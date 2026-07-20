/**
 * Nostr document storage — two-event architecture, ported from XIVPlan's `src/file/nostr.ts`.
 *
 * Framework-agnostic: no Angular imports here, so this can be unit-tested or reused outside DI.
 * Generalized from XIVPlan's single "plan" type into a `createDocumentStore(indexKind, dataKind,
 * cacheNamespace)` factory so fightline can run two independent stores — one for fights, one for
 * personal boss variants — under different Nostr kind numbers (per nostr/09-porting-guide.md,
 * fightline must not reuse XIVPlan's 30078/30079). Everything content-shaped stays as a plain
 * `string`: fightline's `IFight.data`/`IBoss.data` are already JSON.stringify'd by the caller, so
 * unlike XIVPlan (which serializes/deserializes a `Scene` object here) there is no
 * sceneToJson/jsonToScene layer needed — the event `content` field *is* the caller's string.
 *
 * Each document is stored as a pair of NIP-33 parameterized replaceable events:
 *   - Index (indexKind): lightweight metadata + pointer. Vault queries only fetch this kind.
 *   - Data (dataKind): full content (plaintext or NIP-44 encrypted), possibly chunked.
 *
 * Same pubkey + d-tag + kind = always the latest version (replaceable).
 * Keys are stored in IndexedDB (via localforage), never exposed beyond the browser.
 */

import localforage from 'localforage';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, verifyEvent } from 'nostr-tools';
import type { NostrEvent } from 'nostr-tools';
import { AbstractSimplePool } from 'nostr-tools/pool';

export const NOSTR_RELAYS = [
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
];

/**
 * Number of relays that must agree on the same event (with no higher-`created_at` challenger)
 * before {@link fanGet} stops waiting on stragglers. A strict majority means a document is only
 * ever treated as "properly" saved/read once more relays hold that version than don't — anything
 * short of that leaves room for a stale-relay minority to look like consensus.
 */
export function consensusThreshold(relayCount: number): number {
  return Math.floor(relayCount / 2) + 1;
}

/** Incremented when the event structure changes in a backwards-incompatible way. */
export const FIGHTLINE_FORMAT_VERSION = 1;

/**
 * Per-relay timeout for read operations (ms) — also the pool's `maxWaitForConnection` budget.
 * Every other relay-facing timeout derives from this constant. Confirmed necessary as-is for
 * legitimate slow connections (XIVPlan's largest real-world fetch on its slowest benchmarked
 * connection needed the full budget) — do not shorten this to make failures feel snappier.
 */
const RELAY_TIMEOUT_MS = 12000;

/**
 * Extra time {@link fanGet} (for reads) and the publish race (for writes) wait beyond
 * RELAY_TIMEOUT_MS before giving up. RELAY_TIMEOUT_MS is also the pool's `maxWaitForConnection`
 * budget, so a relay that takes the full RELAY_TIMEOUT_MS just to open its WebSocket would
 * otherwise have no time left to actually answer — this grace period is what's left over for the
 * query/response (or the publish OK) after a maximal-length connection.
 */
const QUERY_GRACE_MS = 2000;

/** Outer race timeout for a single relay's publish attempt — see {@link QUERY_GRACE_MS}. */
const PUBLISH_TIMEOUT_MS = RELAY_TIMEOUT_MS + QUERY_GRACE_MS;

// Single long-lived pool — connections are reused across operations and across both document
// stores (fight/boss), since relay health/connectivity is a property of the browser session, not
// of any one document type.
//
// Built on AbstractSimplePool rather than SimplePool because SimplePool's constructor type only
// exposes enablePing/enableReconnect — it hardcodes maxWaitForConnection to 3000ms, which (once a
// per-call maxWait exceeds it) derives the actual connection timeout as
// max(maxWait * 0.8, maxWait - 1000), silently truncating the WebSocket handshake well under what
// was asked for. Passing maxWaitForConnection explicitly keeps the full RELAY_TIMEOUT_MS budget
// available for slow-to-connect relays.
const _pool = new AbstractSimplePool({
  verifyEvent,
  maxWaitForConnection: RELAY_TIMEOUT_MS,
  onRelayConnectionSuccess: (url: string) => _setHealth(url, 'connected'),
  onRelayConnectionFailure: (url: string) => _setHealth(url, 'error'),
});

// ── Shared relay status ───────────────────────────────────────────────────────

export type RelayHealth = 'checking' | 'connected' | 'skipped' | 'stale' | 'incomplete' | 'error';

const _health = new Map<string, RelayHealth>(NOSTR_RELAYS.map((url) => [url, 'checking']));
const _listeners = new Set<() => void>();

let _healthSnapshot: Array<{ url: string; status: RelayHealth }> | null = null;

function _setHealth(url: string, h: RelayHealth): void {
  if (_health.get(url) === h) return;
  _health.set(url, h);
  _healthSnapshot = null;
  for (const fn of _listeners) fn();
}

export function subscribeRelayStatus(fn: () => void): () => void {
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}

export function getRelayStatus(): Array<{ url: string; status: RelayHealth }> {
  _healthSnapshot ??= NOSTR_RELAYS.map((url) => ({ url, status: _health.get(url) ?? 'checking' }));
  return _healthSnapshot;
}

// ── Live fetch status ────────────────────────────────────────────────────────
// Tracks the in-progress fanGet call, if any — distinct from `_health` above, which reflects
// general relay connectivity rather than "did this specific fetch hear back from this relay".

const _fetchStatus = new Map<string, RelayHealth>();
const _fetchListeners = new Set<() => void>();
let _fetchSnapshot: Array<{ url: string; status: RelayHealth }> | null = null;

// Bumped by every UI-tracked fanGet call on start, so an older call whose fetch is still running
// can tell it's no longer the latest and stop writing to the shared stores — otherwise two
// concurrent tracked fetches (e.g. opening a second document before the first resolves) would
// each think they own `_fetchStatus`/`_fetchProgress` and stomp each other's display.
let _fetchGeneration = 0;

function _resetFetchStatus(relays: string[]): void {
  _fetchStatus.clear();
  for (const relay of relays) _fetchStatus.set(relay, 'checking');
  _fetchSnapshot = null;
  for (const fn of _fetchListeners) fn();
}

function _setFetchStatus(relay: string, status: RelayHealth): void {
  _fetchStatus.set(relay, status);
  _fetchSnapshot = null;
  for (const fn of _fetchListeners) fn();
}

export function subscribeFetchStatus(fn: () => void): () => void {
  _fetchListeners.add(fn);
  return () => {
    _fetchListeners.delete(fn);
  };
}

export function getFetchStatus(): Array<{ url: string; status: RelayHealth }> {
  _fetchSnapshot ??= NOSTR_RELAYS.map((url) => ({ url, status: _fetchStatus.get(url) ?? 'checking' }));
  return _fetchSnapshot;
}

// ── Live consensus progress ──────────────────────────────────────────────────

export interface ConsensusProgress {
  /** Relays currently agreeing/confirmed so far. */
  agreeing: number;
  /** Relays required to treat this as settled. */
  threshold: number;
  /** Total relays queried. */
  total: number;
  status: 'pending' | 'reached' | 'short';
}

function createProgressStore() {
  let progress: ConsensusProgress = { agreeing: 0, threshold: 0, total: 0, status: 'pending' };
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const fn of listeners) fn();
  }

  return {
    reset(total: number, threshold: number): void {
      progress = { agreeing: 0, threshold, total, status: 'pending' };
      notify();
    },
    update(agreeing: number): void {
      if (progress.status !== 'pending' || agreeing <= progress.agreeing) return;
      progress = { ...progress, agreeing };
      notify();
    },
    finish(outcome: 'reached' | 'short', agreeing: number): void {
      progress = { ...progress, agreeing, status: outcome };
      notify();
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    get(): ConsensusProgress {
      return progress;
    },
  };
}

const _fetchProgress = createProgressStore();
export const subscribeConsensusProgress = _fetchProgress.subscribe;
export const getConsensusProgress = _fetchProgress.get;

const _publishProgress = createProgressStore();
export const subscribePublishProgress = _publishProgress.subscribe;
export const getPublishProgress = _publishProgress.get;

// ── Relay size limits (NIP-11) ─────────────────────────────────────────────────
// Relays advertise a max message size via their NIP-11 info document. Checking it before
// publishing lets us skip a relay we already know will reject the event on size, instead of
// spending a full publish round-trip just to get an `OK false "invalid: event too large"` back.
// That NIP-11 figure is only a hint though — some relays (nos.lol/nostr.mom in XIVPlan's own
// testing) reject events well under their advertised max_message_length, so
// `learnSizeLimitFromRejection` tightens a relay's cached limit from real rejections as they
// happen, on top of whatever NIP-11 claims.

interface RelayLimits {
  /** Max size, in bytes, of a full `["EVENT", {...}]` wire message. Undefined if unknown. */
  maxMessageLength?: number;
}

const _relayLimitsCache = new Map<string, RelayLimits>();

function relayInfoUrl(relay: string): string {
  return relay.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
}

async function fetchRelayLimits(relay: string): Promise<RelayLimits> {
  const cached = _relayLimitsCache.get(relay);
  if (cached) return cached;
  let limits: RelayLimits = {};
  try {
    const res = await fetch(relayInfoUrl(relay), {
      headers: { Accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(2500),
    });
    const info = await res.json();
    if (typeof info?.limitation?.max_message_length === 'number') {
      limits = { maxMessageLength: info.limitation.max_message_length };
    }
  } catch {
    // No NIP-11 info available — leave unset. We simply won't be able to skip this relay
    // proactively; it still gets a normal publish/fetch attempt like any other.
  }
  _relayLimitsCache.set(relay, limits);
  return limits;
}

/**
 * Cache-only lookup — never triggers a network request. Publish/fetch's size-based skip must
 * never block the hot path on a fresh NIP-11 round-trip; it only benefits from limits
 * `probeRelays()` has already warmed in the background. Unknown relays just don't get skipped.
 */
function peekRelayLimits(relay: string): RelayLimits {
  return _relayLimitsCache.get(relay) ?? {};
}

/** The exact bytes a relay receives for this event — matches nostr-tools' own `publish()` framing. */
function wireEventSize(event: NostrEvent): number {
  return new TextEncoder().encode('["EVENT",' + JSON.stringify(event) + ']').length;
}

/** Matches a NIP-01 `OK false <reason>` reason that rejects an event specifically for its size. */
const SIZE_REJECTION_PATTERN = /too large|too big|max.{0,20}(size|length)|size.{0,20}(exceed|limit)/i;

/**
 * Matches nostr-tools' own generic hard-close error text ("relay connection failed"/"relay
 * connection closed"/"websocket closed" — see abstract-relay.js's `ws.onerror`/`ws.onclose`
 * handlers), which is what a relay's *silent* size rejection actually surfaces as in practice: a
 * relay confirmed already-reachable this session (an earlier small event round-tripped fine) that
 * abruptly hangs up the instant it receives an oversized EVENT frame, with no OK-false message at
 * all. Verified against the real relay list while building this port — nos.lol and nostr.mom both
 * did exactly this for a ~390KB event, never producing text SIZE_REJECTION_PATTERN could match, so
 * relying on that pattern alone would silently skip the chunking ladder for precisely the failure
 * mode it exists to handle. Deliberately does NOT match a plain "publish timed out" — a relay that
 * just never responds is a different, genuinely-unreachable failure, not evidence of a size
 * rejection worth spending a chunking ladder on.
 */
const HARD_CLOSE_PATTERN = /relay connection (failed|closed)|websocket closed/i;

function looksLikeSizeRejection(reason: string): boolean {
  return SIZE_REJECTION_PATTERN.test(reason) || HARD_CLOSE_PATTERN.test(reason);
}

function learnSizeLimitFromRejection(relay: string, event: NostrEvent, reason: string): void {
  if (!looksLikeSizeRejection(reason)) return;
  const learned = wireEventSize(event) - 1;
  const existing = _relayLimitsCache.get(relay)?.maxMessageLength;
  if (existing === undefined || learned < existing) {
    _relayLimitsCache.set(relay, { maxMessageLength: learned });
  }
}

// ── Data-event chunking ─────────────────────────────────────────────────────────
// A relay that rejects a document's data event for being too large will often still accept the
// exact same bytes split across several smaller NIP-33 events ("chunks") — this is purely a
// per-relay, reactive fallback (try the whole event first; only chunk for a relay that actually
// rejects it), never a deliberate data-distribution strategy. This is mandatory, not optional
// polish: public relays silently reject (or silently drop) oversized events, so without chunking,
// realistically-sized fight/boss payloads can fail to land on enough relays to ever reach the
// strict-majority consensus threshold at all.
//
// Chunk 1 of N reuses the document's ordinary `d`-tag (docId); chunks 2..N use `${docId}:${i}`.
// These d-tags are *reused* across publish generations (ordinary NIP-33 overwrite-latest-
// created_at semantics), not versioned — safe because every consumer of a non-primary chunk must
// reject it unless its `created_at` exactly matches the already-established winning primary
// event's `created_at`. A relay caught mid-publish (some chunks updated, some still old) then just
// looks like "doesn't have a valid matching chunk yet," never a silent old+new splice.

/** Hard cap on the publish retry ladder (2 -> 4 -> 8 -> 16 chunks). Beyond this, a relay is
 *  treated as permanently unable to hold this document. */
const MAX_CHUNKS = 16;

/**
 * Splits a string into `n` roughly-equal pieces by character index, nudging a boundary back one
 * code unit when it would land inside a UTF-16 surrogate pair (most emoji, some CJK) — otherwise
 * each half independently encodes an unpaired surrogate as U+FFFD on UTF-8 encode, silent data
 * loss that {@link joinChunks} could never undo.
 */
function splitIntoChunks(content: string, n: number): string[] {
  const size = Math.ceil(content.length / n);
  const pieces: string[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    let end = i === n - 1 ? content.length : Math.min(content.length, start + size);
    const endsMidSurrogatePair =
      end > start + 1 &&
      end < content.length &&
      content.charCodeAt(end - 1) >= 0xd800 &&
      content.charCodeAt(end - 1) <= 0xdbff &&
      content.charCodeAt(end) >= 0xdc00 &&
      content.charCodeAt(end) <= 0xdfff;
    if (endsMidSurrogatePair) end -= 1;
    pieces.push(content.slice(start, end));
    start = end;
  }
  return pieces;
}

/** Inverse of {@link splitIntoChunks} — trivial concatenation in order. */
function joinChunks(pieces: string[]): string {
  return pieces.join('');
}

/** Reads a data event's declared chunk count. A missing `chunk` tag implies '1/1'. */
function chunkCountOf(event: NostrEvent): number {
  const tag = event.tags.find((t) => t[0] === 'chunk')?.[1];
  const n = tag ? Number(tag.split('/')[1]) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * A short random per-publish tag, carried on every chunk of one publish (including the
 * whole-event case) as `['gen', ...]`. `created_at` alone has only 1-second resolution, so two
 * publishes landing within the same second would otherwise be indistinguishable as "versions"
 * once fetches group relay responses by created_at rather than event id — this tag is what keeps
 * genuinely different publishes from being merged into one group.
 */
function randomNonce(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
}

/** Reads a data event's `gen` tag — `''` if absent (legacy data, or the index event). */
function genOf(event: NostrEvent): string {
  return event.tags.find((t) => t[0] === 'gen')?.[1] ?? '';
}

/** Smallest power of 2 that is `>= n`. */
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Starting chunk count for a relay's *first* chunked attempt, using its cached size limit (if
 *  any) to jump straight to a plausible N instead of always restarting the ladder at 2. */
function startingChunkCount(dataSize: number, cachedLimit: number | undefined): number {
  if (cachedLimit === undefined) return 2;
  return Math.min(MAX_CHUNKS, Math.max(2, nextPow2(Math.ceil(dataSize / cachedLimit))));
}

/**
 * Builds `n` signed data-kind events for one relay's attempt — `n=1` is the ordinary whole-event
 * case. `sharedTags` live only on chunk 1; chunks 2..N carry only `d`/`chunk`/`gen`. Every piece
 * carries the same `gen` — that's what lets a fetch recognize them as the same publish.
 */
function buildChunkSet(
  dataKind: number,
  sk: Uint8Array,
  docId: string,
  createdAt: number,
  gen: string,
  sharedTags: string[][],
  content: string,
  n: number,
): NostrEvent[] {
  const pieces = n === 1 ? [content] : splitIntoChunks(content, n);
  return pieces.map((piece, index) => {
    const i = index + 1;
    const tags: string[][] = i === 1 ? [['d', docId], ...sharedTags] : [['d', `${docId}:${i}`]];
    tags.push(['chunk', `${i}/${n}`], ['gen', gen]);
    return finalizeEvent({ kind: dataKind, created_at: createdAt, tags, content: piece }, sk);
  });
}

function buildWholeEvent(
  dataKind: number,
  sk: Uint8Array,
  docId: string,
  createdAt: number,
  gen: string,
  sharedTags: string[][],
  content: string,
): NostrEvent {
  const [wholeEvent] = buildChunkSet(dataKind, sk, docId, createdAt, gen, sharedTags, content, 1);
  if (!wholeEvent) throw new Error('unreachable: buildChunkSet(n=1) always returns exactly one event');
  return wholeEvent;
}

let _probing = false;
let _lastProbeTime = 0;
const PROBE_COOLDOWN_MS = 5 * 60 * 1000;

/** Opportunistically warms relay connectivity + NIP-11 size-limit caches in the background, so a
 *  later publish/fetch doesn't pay for a cold connection or a fresh NIP-11 round-trip. Call once
 *  on app boot (or idle) rather than lazily on first use. Rate-limited to once per 5 minutes. */
export async function probeRelays(): Promise<void> {
  const now = Date.now();
  if (_probing || now - _lastProbeTime < PROBE_COOLDOWN_MS) return;
  _probing = true;
  _lastProbeTime = now;
  const futureTs = Math.floor(now / 1000) + 365 * 24 * 3600;
  try {
    await Promise.allSettled(
      NOSTR_RELAYS.map(async (relay) => {
        try {
          // An always-empty query (a filter for events from the future) — this only needs the
          // relay to accept the connection and respond, not to actually return anything.
          await _pool.get([relay], { kinds: [1], since: futureTs }, { maxWait: RELAY_TIMEOUT_MS });
          _setHealth(relay, 'connected');
        } catch {
          _setHealth(relay, 'error');
        }
        void fetchRelayLimits(relay);
      }),
    );
  } finally {
    _probing = false;
  }
}

// ── IDB storage ───────────────────────────────────────────────────────────────

const nostrStore = localforage.createInstance({ name: 'FightLine', storeName: 'nostr' });

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// ── Compression ───────────────────────────────────────────────────────────────
// Some public relays silently drop events over a size limit well under what a complex document's
// JSON serializes to. Gzipping the JSON before it goes into `content` buys real headroom for
// repetitive data without touching the event/consensus model at all.

function supportsCompression(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function gzipCompress(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzipDecompress(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Gzips + base64url-encodes `json`, but only keeps the compressed form if it's actually smaller
 *  — gzip's framing overhead can make already-tiny documents larger, not smaller. Falls back to
 *  plain JSON on unsupported browsers or any compression failure. */
async function compressForStorage(json: string): Promise<{ content: string; compressed: boolean }> {
  if (!supportsCompression()) return { content: json, compressed: false };
  try {
    const gzipped = bytesToBase64Url(await gzipCompress(json));
    return gzipped.length < json.length
      ? { content: gzipped, compressed: true }
      : { content: json, compressed: false };
  } catch {
    return { content: json, compressed: false };
  }
}

/** Random 8-byte document id (16 hex chars) — used as the Nostr d-tag. */
function randomDocId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
}

// ── Key management ───────────────────────────────────────────────────────────

export async function getOrCreateSecretKey(): Promise<Uint8Array> {
  const stored = await nostrStore.getItem<string>('sk');
  if (stored) return hexToBytes(stored);
  const sk = generateSecretKey();
  await nostrStore.setItem('sk', bytesToHex(sk));
  return sk;
}

export async function getNostrPubkey(): Promise<string> {
  return getPublicKey(await getOrCreateSecretKey());
}

export async function hasStoredKey(): Promise<boolean> {
  return (await nostrStore.getItem<string>('sk')) !== null;
}

// Reactive pubkey — lets the UI update in place when the signing key changes (import/generate)
// instead of requiring a full page reload.
let _cachedPubkey: string | undefined;
const _pubkeyListeners = new Set<() => void>();

export function subscribePubkey(fn: () => void): () => void {
  _pubkeyListeners.add(fn);
  return () => {
    _pubkeyListeners.delete(fn);
  };
}

export function getCachedPubkey(): string | undefined {
  return _cachedPubkey;
}

export async function refreshNostrPubkey(): Promise<string> {
  _cachedPubkey = await getNostrPubkey();
  for (const fn of _pubkeyListeners) fn();
  return _cachedPubkey;
}

// Every createDocumentStore() instance registers its own "forget last publish" reset here, so a
// key switch invalidates every store's in-flight retry state, not just whichever store happens to
// have been used most recently.
const _onKeyChangedListeners = new Set<() => void>();
function _notifyKeyChanged(): void {
  for (const fn of _onKeyChangedListeners) fn();
}

/** Replaces the stored key with a freshly generated one. Irreversible — export first. */
export async function generateNewKey(): Promise<void> {
  const sk = generateSecretKey();
  await nostrStore.setItem('sk', bytesToHex(sk));
  await refreshNostrPubkey();
  _notifyKeyChanged();
}

/** Accepts a 64-char hex private key (contents of the exported .txt file). */
export async function importSecretKey(text: string): Promise<void> {
  const hex = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('Invalid key: expected 64 hex characters.');
  }
  await nostrStore.setItem('sk', hex);
  await refreshNostrPubkey();
  _notifyKeyChanged();
}

/** Returns a Blob containing the hex private key, suitable for saving as .txt. */
export async function exportSecretKeyBlob(): Promise<Blob> {
  const sk = await getOrCreateSecretKey();
  return new Blob([bytesToHex(sk)], { type: 'text/plain' });
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

export function pubkeyToNpub(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

function decodePubkeyToken(token: string): string | undefined {
  try {
    const bytes = base64UrlToBytes(token);
    return bytes.length === 32 ? bytesToHex(bytes) : undefined;
  } catch {
    return undefined;
  }
}

/** Accepts anything a user might reasonably paste when asked for an author: an npub, a raw hex
 *  pubkey, just the pubkey segment copied out of a share URL, or the whole share URL/link. */
export function parseInputPubkey(input: string): string {
  input = input.trim();

  const pathIdx = input.indexOf('/nostr/');
  if (pathIdx !== -1) {
    // rest is "<docType>/<pubToken>/<idToken>..." — skip the docType segment to reach the pubkey.
    const afterNostr = input.slice(pathIdx + '/nostr/'.length);
    const firstSlash = afterNostr.indexOf('/');
    const rest = firstSlash > 0 ? afterNostr.slice(firstSlash + 1) : afterNostr;
    const slash = rest.indexOf('/');
    const pubSegment = slash > 0 ? rest.slice(0, slash) : rest;
    const decoded = decodePubkeyToken(pubSegment);
    if (decoded) return decoded;
  }

  if (input.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(input);
      if (decoded.type === 'npub') return decoded.data as string;
    } catch {
      // fall through
    }
  }

  if (/^[0-9a-f]{64}$/i.test(input)) {
    return input.toLowerCase();
  }

  return decodePubkeyToken(input) ?? input;
}

// ── URL helpers ───────────────────────────────────────────────────────────────
// fightline's route is a real path segment, `/nostr/<docType>/<pubToken>/<idToken>` — unlike
// XIVPlan (which uses a `#/nostr/...` hash fragment throughout), fightline's router already uses
// Angular's PathLocationStrategy everywhere else (`:fightId`, `fflogs/:code`, ...), and a hash
// fragment is invisible to Angular's path-based route matching — it would need a separate,
// special-cased parsing path alongside the router instead of a normal route. The extra `docType`
// segment (absent from XIVPlan's URL) is needed since a URL alone must disambiguate a fight
// share-link from a boss-variant share-link (two independent kind pairs, same pubkey namespace).

export type NostrDocType = 'fight' | 'boss';

/**
 * The deployed app doesn't necessarily live at the domain root — a GitHub Pages project site
 * serves it under `/<repo-name>/` via `<base href>`, which `ng build --base-href` stamps into
 * index.html at build time. Angular's router already resolves its own routes relative to this
 * automatically; this helper exists only because share-URL construction here builds a plain
 * string outside the router and would otherwise silently drop that prefix.
 */
function baseHref(): string {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/';
  return href.endsWith('/') ? href : `${href}/`;
}

export function getNostrShareUrl(docType: NostrDocType, pubkey: string, id: string): string {
  const pubToken = bytesToBase64Url(hexToBytes(pubkey));
  const idToken = bytesToBase64Url(hexToBytes(id));
  return `${location.origin}${baseHref()}nostr/${docType}/${pubToken}/${idToken}`;
}

/**
 * The router-relative counterpart of {@link getNostrShareUrl} — for `Router.navigateByUrl()`
 * calls (e.g. selecting a vault entry), which already resolve paths relative to `<base href>`
 * themselves and would double up the prefix if given the full absolute URL instead.
 */
export function getNostrRoutePath(docType: NostrDocType, pubkey: string, id: string): string {
  const pubToken = bytesToBase64Url(hexToBytes(pubkey));
  const idToken = bytesToBase64Url(hexToBytes(id));
  return `/nostr/${docType}/${pubToken}/${idToken}`;
}

export function decodeNostrUrlSegments(
  pubToken: string,
  idToken: string,
): { pubkey: string; id: string } | undefined {
  try {
    const pubkeyBytes = base64UrlToBytes(pubToken);
    const idBytes = base64UrlToBytes(idToken);
    if (pubkeyBytes.length !== 32 || idBytes.length === 0) return undefined;
    return { pubkey: bytesToHex(pubkeyBytes), id: bytesToHex(idBytes) };
  } catch {
    return undefined;
  }
}

/** Strips characters that are unsafe in a URL path segment or Nostr d-tag. Spaces are allowed. */
export function sanitizeDocName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 \-_]/g, '');
}

// ── Fan-fetch helpers (parallel, deduplicated, status-tracking) ───────────────

export interface FanGetResult {
  event: NostrEvent | null;
  agreeingRelays: number;
  totalRelays: number;
  relayStatuses: Map<string, RelayHealth>;
  relayEvents: Map<string, NostrEvent>;
  uiGeneration: number;
}

/**
 * Fetches from all relays in parallel, but stops waiting as soon as a strict majority of `relays`
 * have delivered the same event and no other relay has delivered one with a higher `created_at`
 * that would outrank it. See nostr/03-relay-pool-and-consensus.md for the full rationale — ported
 * near-verbatim, this is the most correctness-critical piece of the whole engine.
 */
async function fanGet(
  filter: Parameters<AbstractSimplePool['subscribeMany']>[1],
  relays: string[] = NOSTR_RELAYS,
  fallbackTimeoutMs: number = RELAY_TIMEOUT_MS + QUERY_GRACE_MS,
  registerPruner?: (prune: (relay: string) => void) => void,
  trackUiStatus = true,
  groupKey: (event: NostrEvent) => string = (e) => e.id,
): Promise<FanGetResult> {
  const myGeneration = trackUiStatus ? ++_fetchGeneration : -1;
  function uiActive(): boolean {
    return trackUiStatus && myGeneration === _fetchGeneration;
  }

  return new Promise((resolve) => {
    const events = new Map<string, NostrEvent>();
    const relaysByKey = new Map<string, Map<string, NostrEvent>>();
    const active = new Set(relays);
    const prunedRelays = new Set<string>();
    let resolved = false;

    function threshold(): number {
      return consensusThreshold(relays.length - prunedRelays.size);
    }

    function bestSoFar(): NostrEvent | null {
      let best: NostrEvent | null = null;
      for (const event of events.values()) {
        if (!best || event.created_at > best.created_at) best = event;
      }
      return best;
    }

    function relayLabels(best: NostrEvent | null): Map<string, RelayHealth> {
      const labels = new Map<string, RelayHealth>();
      if (!best) return labels;
      const bestKey = groupKey(best);
      for (const [key, supporters] of relaysByKey) {
        const label = key === bestKey ? 'connected' : 'stale';
        for (const relay of supporters.keys()) labels.set(relay, label);
      }
      return labels;
    }

    function settleStragglers(outcome: 'consensus' | 'timeout'): void {
      if (!uiActive()) return;
      for (const relay of relays) {
        if (_fetchStatus.get(relay) === 'checking') {
          _setFetchStatus(relay, outcome === 'consensus' ? 'skipped' : 'error');
        }
      }
    }

    function updateRelayLabels(): void {
      if (!uiActive()) return;
      for (const [relay, label] of relayLabels(bestSoFar())) _setFetchStatus(relay, label);
    }

    function finish(best: NostrEvent | null, agreeingRelays: number, outcome: 'consensus' | 'timeout'): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(fallbackHandle);
      settleStragglers(outcome);
      updateRelayLabels();
      if (uiActive()) _fetchProgress.finish(outcome === 'consensus' ? 'reached' : 'short', agreeingRelays);
      resolve({
        event: best,
        agreeingRelays,
        totalRelays: relays.length - prunedRelays.size,
        relayStatuses: relayLabels(best),
        relayEvents: best ? (relaysByKey.get(groupKey(best)) ?? new Map()) : new Map(),
        uiGeneration: myGeneration,
      });
      for (const closer of closers.values()) closer.close('fanGet: resolved');
    }

    function checkConsensus(): void {
      if (resolved) return;
      updateRelayLabels();
      const currentThreshold = threshold();
      let bestAgreement = 0;
      for (const [key, event] of events) {
        const agreeingRelays = relaysByKey.get(key)?.size ?? 0;
        bestAgreement = Math.max(bestAgreement, agreeingRelays);
        if (agreeingRelays < currentThreshold) continue;
        const challenged = [...events.values()].some(
          (other) => groupKey(other) !== key && other.created_at > event.created_at,
        );
        if (!challenged) {
          finish(event, agreeingRelays, 'consensus');
          return;
        }
      }
      if (uiActive()) _fetchProgress.update(bestAgreement);
      if (active.size === 0) {
        finish(bestSoFar(), bestAgreement, 'timeout');
      }
    }

    function pruneRelay(relay: string): void {
      if (resolved || !active.has(relay)) return;
      active.delete(relay);
      prunedRelays.add(relay);
      if (uiActive() && _fetchStatus.get(relay) === 'checking') _setFetchStatus(relay, 'skipped');
      closers.get(relay)?.close('fanGet: pruned');
      checkConsensus();
    }

    registerPruner?.(pruneRelay);

    const fallbackHandle = setTimeout(() => {
      const best = bestSoFar();
      finish(best, best ? (relaysByKey.get(groupKey(best))?.size ?? 0) : 0, 'timeout');
    }, fallbackTimeoutMs);

    if (uiActive()) {
      _resetFetchStatus(relays);
      _fetchProgress.reset(relays.length, threshold());
    }

    const closers = new Map(
      relays.map((relay) => [
        relay,
        _pool.subscribeMany([relay], filter, {
          maxWait: RELAY_TIMEOUT_MS,
          onevent: (event: NostrEvent) => {
            active.delete(relay);
            if (uiActive()) _setFetchStatus(relay, 'connected');
            const key = groupKey(event);
            events.set(key, event);
            let relayMap = relaysByKey.get(key);
            if (!relayMap) {
              relayMap = new Map();
              relaysByKey.set(key, relayMap);
            }
            relayMap.set(relay, event);
            checkConsensus();
          },
          onclose: (reasons: string[]) => {
            if (reasons[0] !== 'fanGet: resolved' && reasons[0] !== 'fanGet: pruned') {
              active.delete(relay);
              if (uiActive() && _fetchStatus.get(relay) === 'checking') _setFetchStatus(relay, 'error');
              checkConsensus();
            }
          },
        }),
      ]),
    );
  });
}

function fanGetInternal(
  filter: Parameters<AbstractSimplePool['subscribeMany']>[1],
  relays: string[] = NOSTR_RELAYS,
  fallbackTimeoutMs?: number,
): Promise<FanGetResult> {
  return fanGet(filter, relays, fallbackTimeoutMs, undefined, false);
}

async function fanQuery(filter: Parameters<AbstractSimplePool['querySync']>[1]): Promise<NostrEvent[]> {
  const results = await Promise.allSettled(
    NOSTR_RELAYS.map(async (relay) => {
      try {
        const events = await _pool.querySync([relay], filter, { maxWait: RELAY_TIMEOUT_MS });
        _setHealth(relay, 'connected');
        return events;
      } catch {
        _setHealth(relay, 'error');
        return [] as NostrEvent[];
      }
    }),
  );
  const seen = new Set<string>();
  const merged: NostrEvent[] = [];
  for (const r of results) {
    for (const ev of r.status === 'fulfilled' ? r.value : []) {
      if (!seen.has(ev.id)) {
        seen.add(ev.id);
        merged.push(ev);
      }
    }
  }

  // NIP-33 parameterized replaceable events (kind 30000-39999): a stale relay may return an older
  // version under a different event id. Keep only the newest event per pubkey+kind+d-tag.
  const newest = new Map<string, NostrEvent>();
  for (const ev of merged) {
    if (ev.kind < 30000 || ev.kind >= 40000) continue;
    const dtag = ev.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    const key = `${ev.pubkey}:${ev.kind}:${dtag}`;
    const existing = newest.get(key);
    if (!existing || ev.created_at > existing.created_at) {
      newest.set(key, ev);
    }
  }
  return merged.filter((ev) => {
    if (ev.kind < 30000 || ev.kind >= 40000) return true;
    const dtag = ev.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    return newest.get(`${ev.pubkey}:${ev.kind}:${dtag}`) === ev;
  });
}

// ── Publish primitives (shared by every document store) ──────────────────────

async function tryPublishSet(relay: string, events: NostrEvent[]): Promise<{ ok: boolean; sizeRejected: boolean }> {
  const timeoutMs = events.length > 1 ? RELAY_TIMEOUT_MS : PUBLISH_TIMEOUT_MS;
  const results = await Promise.allSettled(
    events.map((event) =>
      Promise.race([
        _pool.publish([relay], event)[0],
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('publish timed out')), timeoutMs)),
      ]),
    ),
  );
  let sizeRejected = false;
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      learnSizeLimitFromRejection(relay, events[i]!, reason);
      if (looksLikeSizeRejection(reason)) sizeRejected = true;
    }
  });
  return { ok: results.every((r) => r.status === 'fulfilled'), sizeRejected };
}

async function publishDataToRelay(
  dataKind: number,
  relay: string,
  sk: Uint8Array,
  docId: string,
  createdAt: number,
  gen: string,
  sharedTags: string[][],
  content: string,
  wholeEvent: NostrEvent,
): Promise<'connected' | 'skipped' | 'error'> {
  const first = await tryPublishSet(relay, [wholeEvent]);
  if (first.ok) return 'connected';
  if (!first.sizeRejected) return 'error';

  let n = startingChunkCount(wireEventSize(wholeEvent), peekRelayLimits(relay).maxMessageLength);
  for (;;) {
    const set = buildChunkSet(dataKind, sk, docId, createdAt, gen, sharedTags, content, n);
    const result = await tryPublishSet(relay, set);
    if (result.ok) return 'connected';
    if (!result.sizeRejected) return 'error';
    if (n >= MAX_CHUNKS) return 'skipped';
    n = Math.min(MAX_CHUNKS, n * 2);
  }
}

async function publishIndexToRelay(relay: string, indexEvent: NostrEvent): Promise<boolean> {
  return (await tryPublishSet(relay, [indexEvent])).ok;
}

// ── Fetch primitives (shared) ─────────────────────────────────────────────────

async function fetchRemainingChunks(
  dataKind: number,
  relay: string,
  pubkey: string,
  docId: string,
  n: number,
): Promise<Map<number, NostrEvent>> {
  const dTagToIndex = new Map<string, number>();
  for (let i = 2; i <= n; i++) dTagToIndex.set(`${docId}:${i}`, i);
  const result = new Map<number, NostrEvent>();
  try {
    const events = await _pool.querySync(
      [relay],
      { kinds: [dataKind], authors: [pubkey], '#d': [...dTagToIndex.keys()] },
      { maxWait: RELAY_TIMEOUT_MS },
    );
    for (const event of events) {
      const d = event.tags.find((t) => t[0] === 'd')?.[1];
      const index = d ? dTagToIndex.get(d) : undefined;
      if (index !== undefined) result.set(index, event);
    }
  } catch {
    // No response from this relay — caller treats a partial/empty result as incomplete.
  }
  return result;
}

const REPAIR_MIN_AGREEMENT = 2;

async function repairOneRelay(
  dataKind: number,
  relay: string,
  sk: Uint8Array | null,
  docId: string,
  createdAt: number,
  gen: string,
  sharedTags: string[][],
  content: string,
  chunks: NostrEvent[],
): Promise<void> {
  const maxLen = peekRelayLimits(relay).maxMessageLength;
  const maxChunkSize = Math.max(...chunks.map(wireEventSize));
  const verbatim =
    maxLen !== undefined && maxChunkSize > maxLen
      ? { ok: false, sizeRejected: true }
      : await tryPublishSet(relay, chunks);
  if (verbatim.ok || !verbatim.sizeRejected || !sk) return;
  const wholeEvent = buildWholeEvent(dataKind, sk, docId, createdAt, gen, sharedTags, content);
  await publishDataToRelay(dataKind, relay, sk, docId, createdAt, gen, sharedTags, content, wholeEvent);
}

function repairStaleRelays(
  dataKind: number,
  sk: Uint8Array | null,
  docId: string,
  createdAt: number,
  gen: string,
  sharedTags: string[][],
  content: string,
  chunks: NostrEvent[],
  agreeingRelays: number,
  relayStatuses: Map<string, RelayHealth>,
): void {
  if (agreeingRelays < REPAIR_MIN_AGREEMENT) return;
  const targets = [...relayStatuses].filter(([, status]) => status === 'stale' || status === 'incomplete').map(([url]) => url);
  for (const relay of targets) {
    void repairOneRelay(dataKind, relay, sk, docId, createdAt, gen, sharedTags, content, chunks);
  }
}

function visibilityFromTags(tags: string[][]): 'public' | 'private' {
  return tags.some((t) => t[0] === 'enc') ? 'private' : 'public';
}

// ── Document store factory ────────────────────────────────────────────────────

export interface NostrDocInfo {
  id: string;
  name: string;
  publishedAt: Date;
  visibility: 'public' | 'private';
}

export interface NostrDocSource {
  id: string;
  name: string;
  pubkey: string;
  visibility: 'public' | 'private';
}

export interface FetchDocResult {
  content: string;
  visibility: 'public' | 'private';
  name: string;
  agreeingRelays: number;
  totalRelays: number;
}

const VAULT_PAGE_SIZE = 20;
const VAULT_CACHE_TTL = 5 * 60 * 1000;

interface VaultCachePage {
  plans: NostrDocInfo[];
  hasMore: boolean;
  fetchedAt: number;
}

interface StoredVaultCachePage {
  plans: Array<{ id: string; name: string; publishedAt: number; visibility: 'public' | 'private' }>;
  hasMore: boolean;
  fetchedAt: number;
}

/**
 * Builds an independent publish/fetch/list/delete API for one document type, under its own kind
 * pair (index kind + data kind). fightline runs two instances — one for fights, one for personal
 * boss variants — so vault-listing queries stay simple (`kinds:[X], authors:[pubkey]`) rather than
 * needing client-side type filtering within a single shared kind pair.
 */
export function createDocumentStore(indexKind: number, dataKind: number, cacheNamespace: string) {
  const cacheStorageKey = `fightline:${cacheNamespace}-vault-cache`;

  let _lastPublished: {
    docId: string;
    createdAt: number;
    gen: string;
    sharedTags: string[][];
    content: string;
    indexEvent: NostrEvent;
  } | null = null;

  _onKeyChangedListeners.add(() => {
    // A retry against stashed publish state signed under the old key would republish a data event
    // under the new key while the already-published index event stays signed by the old one.
    _lastPublished = null;
  });

  function _loadVaultCache(): Map<string, VaultCachePage> {
    try {
      const raw = localStorage.getItem(cacheStorageKey);
      if (!raw) return new Map();
      const stored = JSON.parse(raw) as Record<string, StoredVaultCachePage>;
      return new Map(
        Object.entries(stored).map(([pubkey, page]) => [
          pubkey,
          {
            plans: page.plans.map((p) => ({
              id: p.id,
              name: p.name,
              publishedAt: new Date(p.publishedAt),
              visibility: p.visibility,
            })),
            hasMore: page.hasMore,
            fetchedAt: page.fetchedAt,
          },
        ]),
      );
    } catch {
      return new Map();
    }
  }

  function _saveVaultCache(): void {
    try {
      const stored: Record<string, StoredVaultCachePage> = {};
      for (const [pubkey, page] of _vaultCache.entries()) {
        stored[pubkey] = {
          plans: page.plans.map((p) => ({
            id: p.id,
            name: p.name,
            publishedAt: p.publishedAt.getTime(),
            visibility: p.visibility,
          })),
          hasMore: page.hasMore,
          fetchedAt: page.fetchedAt,
        };
      }
      localStorage.setItem(cacheStorageKey, JSON.stringify(stored));
    } catch {
      // Ignore storage errors (private browsing, quota exceeded)
    }
  }

  const _vaultCache = _loadVaultCache();

  function invalidateVaultCache(pubkey?: string): void {
    if (pubkey) _vaultCache.delete(pubkey);
    else _vaultCache.clear();
    _saveVaultCache();
  }

  function upsertVaultCacheEntry(pk: string, entry: NostrDocInfo): void {
    const existing = _vaultCache.get(pk);
    if (existing) {
      const filtered = existing.plans.filter((p) => p.id !== entry.id);
      _vaultCache.set(pk, { plans: [entry, ...filtered], hasMore: existing.hasMore, fetchedAt: Date.now() });
      _saveVaultCache();
    } else {
      invalidateVaultCache(pk);
    }
  }

  async function publishChunkedDocument(
    pk: string,
    sk: Uint8Array,
    docId: string,
    createdAt: number,
    sharedTags: string[][],
    content: string,
    indexEvent: NostrEvent,
  ): Promise<void> {
    const gen = randomNonce();
    _lastPublished = { docId, createdAt, gen, sharedTags, content, indexEvent };
    const wholeEvent = buildWholeEvent(dataKind, sk, docId, createdAt, gen, sharedTags, content);

    const threshold = consensusThreshold(NOSTR_RELAYS.length);
    _publishProgress.reset(NOSTR_RELAYS.length, threshold);

    let confirmed = 0;
    const perRelay = await Promise.allSettled(
      NOSTR_RELAYS.map(async (relay) => {
        _setHealth(relay, 'checking');
        const [dataOutcome, indexOk] = await Promise.all([
          publishDataToRelay(dataKind, relay, sk, docId, createdAt, gen, sharedTags, content, wholeEvent),
          publishIndexToRelay(relay, indexEvent),
        ]);
        const success = dataOutcome === 'connected' && indexOk;
        _setHealth(relay, success ? 'connected' : dataOutcome === 'skipped' ? 'skipped' : 'error');
        if (success) _publishProgress.update(++confirmed);
        return { success, dataOutcome };
      }),
    );

    const accepted = perRelay.filter((r) => r.status === 'fulfilled' && r.value.success).length;
    const skipped = perRelay.filter((r) => r.status === 'fulfilled' && r.value.dataOutcome === 'skipped').length;
    const effectiveThreshold = consensusThreshold(NOSTR_RELAYS.length - skipped);
    _publishProgress.finish(accepted >= effectiveThreshold ? 'reached' : 'short', accepted);
    if (accepted === 0) {
      const allSkipped = skipped === NOSTR_RELAYS.length;
      if (allSkipped) {
        throw new Error(
          `This is too large for every configured relay (${Math.ceil(wireEventSize(wholeEvent) / 1024)}KB even after splitting into up to ${MAX_CHUNKS} pieces). Try removing some content.`,
        );
      }
      throw new Error('Could not publish — no relays responded. Check your internet connection and try again.');
    }

    const { event: stored } = await fanGetInternal({ kinds: [indexKind], authors: [pk], '#d': [docId] }, NOSTR_RELAYS);
    if (!stored) {
      throw new Error('Verification failed — this was not found on any relay after publishing.');
    }
    if (stored.id !== indexEvent.id) {
      throw new Error(
        'Another version was saved at the same time. If you have multiple tabs open, close the others and try again.',
      );
    }
  }

  async function publish(
    content: string,
    name: string,
    visibility: 'public' | 'private',
    id?: string,
  ): Promise<NostrDocSource> {
    const sk = await getOrCreateSecretKey();
    const pk = getPublicKey(sk);
    const now = Math.floor(Date.now() / 1000);
    const docId = id ?? randomDocId();

    const { content: storedContent, compressed } = await compressForStorage(content);

    // Compress-then-encrypt, never the other way — encrypted bytes are high-entropy and won't
    // compress at all.
    let dataContent: string;
    if (visibility === 'private') {
      const convKey = nip44.getConversationKey(sk, pk);
      dataContent = nip44.encrypt(storedContent, convKey);
    } else {
      dataContent = storedContent;
    }

    const sharedTags: string[][] = [
      ['name', name],
      ['v', String(FIGHTLINE_FORMAT_VERSION)],
    ];
    if (compressed) sharedTags.push(['comp', 'gzip']);
    if (visibility === 'private') sharedTags.push(['enc', 'nip44-self']);

    const indexTags: string[][] = [
      ['d', docId],
      ['name', name],
      ['v', String(FIGHTLINE_FORMAT_VERSION)],
    ];
    if (visibility === 'private') indexTags.push(['enc', 'nip44-self']);
    const indexEvent = finalizeEvent({ kind: indexKind, created_at: now, tags: indexTags, content: '' }, sk);

    await publishChunkedDocument(pk, sk, docId, now, sharedTags, dataContent, indexEvent);
    upsertVaultCacheEntry(pk, { id: docId, name, publishedAt: new Date(now * 1000), visibility });

    return { id: docId, name, pubkey: pk, visibility };
  }

  async function fetchDocumentData(
    pubkey: string,
    docId: string,
    trackUiStatus = true,
  ): Promise<{
    primary: NostrEvent;
    chunks: NostrEvent[];
    content: string;
    agreeingRelays: number;
    totalRelays: number;
    relayStatuses: Map<string, RelayHealth>;
  }> {
    const { event: primary, agreeingRelays, totalRelays, relayStatuses, relayEvents, uiGeneration } = await fanGet(
      { kinds: [dataKind], authors: [pubkey], '#d': [docId] },
      NOSTR_RELAYS,
      undefined,
      undefined,
      trackUiStatus,
      (e) => `${e.created_at}:${genOf(e) || e.id}`,
    );
    if (!primary) throw new Error('Not found on any relay.');

    const candidates = [...relayEvents.entries()].sort((a, b) => chunkCountOf(a[1]) - chunkCountOf(b[1]));
    let content: string | undefined;
    let chunks: NostrEvent[] | undefined;
    for (const [relay, chunk1] of candidates) {
      const n = chunkCountOf(chunk1);
      if (n === 1) {
        content = chunk1.content;
        chunks = [chunk1];
        break;
      }
      const rest = await fetchRemainingChunks(dataKind, relay, pubkey, docId, n);
      const complete =
        rest.size === n - 1 &&
        [...rest.values()].every(
          (c) => c.created_at === primary.created_at && genOf(c) === genOf(primary) && chunkCountOf(c) === n,
        );
      if (complete) {
        const ordered = [chunk1, ...Array.from({ length: n - 1 }, (_, index) => rest.get(index + 2)!)];
        content = joinChunks(ordered.map((e) => e.content));
        chunks = ordered;
        break;
      }
      relayStatuses.set(relay, 'incomplete');
      if (uiGeneration === _fetchGeneration) _setFetchStatus(relay, 'incomplete');
    }
    if (content === undefined || chunks === undefined) {
      throw new Error('Data could not be fully retrieved from any relay — try again.');
    }

    return { primary, chunks, content, agreeingRelays, totalRelays, relayStatuses };
  }

  async function fetchOne(pubkey: string, id: string): Promise<FetchDocResult> {
    const { primary: dataEvent, chunks, content: reconstructed, agreeingRelays, totalRelays, relayStatuses } =
      await fetchDocumentData(pubkey, id);

    const ownSk = await getOrCreateSecretKey();
    const repairSk = getPublicKey(ownSk) === pubkey ? ownSk : null;
    const sharedTags = dataEvent.tags.filter((t) => t[0] !== 'd' && t[0] !== 'chunk' && t[0] !== 'gen');
    repairStaleRelays(
      dataKind,
      repairSk,
      id,
      dataEvent.created_at,
      genOf(dataEvent),
      sharedTags,
      reconstructed,
      chunks,
      agreeingRelays,
      relayStatuses,
    );

    const name = dataEvent.tags.find((t) => t[0] === 'name')?.[1] ?? id;

    const encTag = dataEvent.tags.find((t) => t[0] === 'enc')?.[1];
    const compTag = dataEvent.tags.find((t) => t[0] === 'comp')?.[1];
    let visibility: 'public' | 'private';
    if (encTag !== undefined) {
      visibility = encTag === 'nip44-self' ? 'private' : 'public';
    } else if (compTag !== undefined) {
      visibility = 'public';
    } else {
      let looksLikeJson = false;
      try {
        JSON.parse(reconstructed);
        looksLikeJson = true;
      } catch {
        /* encrypted */
      }
      visibility = looksLikeJson ? 'public' : 'private';
    }

    let content = reconstructed;
    if (visibility === 'private') {
      const sk = await getOrCreateSecretKey();
      const ownPk = getPublicKey(sk);
      if (ownPk !== pubkey) {
        throw new Error('This is private and can only be opened with the key that published it.');
      }
      const convKey = nip44.getConversationKey(sk, ownPk);
      try {
        content = nip44.decrypt(content, convKey);
      } catch {
        throw new Error('Failed to decrypt — the stored key may be corrupted or the data is invalid.');
      }
    }

    if (compTag === 'gzip') {
      try {
        content = await gzipDecompress(base64UrlToBytes(content));
      } catch {
        throw new Error('Failed to decompress — the stored data may be corrupted.');
      }
    }

    return { content, visibility, name, agreeingRelays, totalRelays };
  }

  async function rename(id: string, newName: string, newVisibility: 'public' | 'private'): Promise<NostrDocInfo> {
    const sk = await getOrCreateSecretKey();
    const pk = getPublicKey(sk);
    const now = Math.floor(Date.now() / 1000);

    const { primary: existingData, content: existingContent } = await fetchDocumentData(pk, id, false);

    const version = existingData.tags.find((t) => t[0] === 'v')?.[1] ?? String(FIGHTLINE_FORMAT_VERSION);
    const currentVisibility = visibilityFromTags(existingData.tags);
    const compTag = existingData.tags.find((t) => t[0] === 'comp')?.[1];

    let content = existingContent;
    if (newVisibility !== currentVisibility) {
      const convKey = nip44.getConversationKey(sk, pk);
      content = currentVisibility === 'private' ? nip44.decrypt(content, convKey) : nip44.encrypt(content, convKey);
    }

    const sharedTags: string[][] = [
      ['name', newName],
      ['v', version],
    ];
    if (compTag) sharedTags.push(['comp', compTag]);
    if (newVisibility === 'private') sharedTags.push(['enc', 'nip44-self']);

    const indexTags: string[][] = [
      ['d', id],
      ['name', newName],
      ['v', version],
    ];
    if (newVisibility === 'private') indexTags.push(['enc', 'nip44-self']);
    const indexEvent = finalizeEvent({ kind: indexKind, created_at: now, tags: indexTags, content: '' }, sk);

    await publishChunkedDocument(pk, sk, id, now, sharedTags, content, indexEvent);

    const entry: NostrDocInfo = { id, name: newName, publishedAt: new Date(now * 1000), visibility: newVisibility };
    upsertVaultCacheEntry(pk, entry);
    return entry;
  }

  async function deleteOne(id: string): Promise<void> {
    const sk = await getOrCreateSecretKey();
    const pk = getPublicKey(sk);

    const tags: string[][] = [
      ['a', `${indexKind}:${pk}:${id}`],
      ['a', `${dataKind}:${pk}:${id}`],
    ];
    for (let i = 2; i <= MAX_CHUNKS; i++) {
      tags.push(['a', `${dataKind}:${pk}:${id}:${i}`]);
    }

    const event = finalizeEvent({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk);
    await Promise.any(_pool.publish(NOSTR_RELAYS, event));
    invalidateVaultCache(pk);
  }

  async function duplicate(sourcePubkey: string, sourceId: string, newName: string): Promise<NostrDocSource> {
    const { content, visibility } = await fetchOne(sourcePubkey, sourceId);
    return publish(content, newName, visibility);
  }

  function buildPage(events: NostrEvent[]): { plans: NostrDocInfo[]; hasMore: boolean } {
    events.sort((a, b) => b.created_at - a.created_at);
    const hasMore = events.length > VAULT_PAGE_SIZE;
    const page = events.slice(0, VAULT_PAGE_SIZE);
    const plans = page
      .map((e) => {
        const id = e.tags.find((t) => t[0] === 'd')?.[1] ?? '';
        return {
          id,
          name: e.tags.find((t) => t[0] === 'name')?.[1] ?? id,
          publishedAt: new Date(e.created_at * 1000),
          visibility: visibilityFromTags(e.tags),
        };
      })
      .filter((p) => p.id);
    return { plans, hasMore };
  }

  async function list(
    pubkey: string,
    opts: { until?: number; id?: string } = {},
  ): Promise<{ plans: NostrDocInfo[]; hasMore: boolean; cached: boolean; stale: boolean }> {
    const isFirstPage = opts.until === undefined && !opts.id;

    if (isFirstPage) {
      const cached = _vaultCache.get(pubkey);
      if (cached) {
        const withinTTL = Date.now() - cached.fetchedAt < VAULT_CACHE_TTL;
        return { plans: cached.plans, hasMore: cached.hasMore, cached: true, stale: !withinTTL };
      }
    }

    // Requesting well beyond one page's worth gives cross-relay dedup enough headroom to still
    // surface a full page (and an accurate hasMore) even when some responses turn out to be
    // stale duplicates of a replaceable event.
    const fetchLimit = (VAULT_PAGE_SIZE + 1) * 4;
    const events = await fanQuery({
      kinds: [indexKind],
      authors: [pubkey],
      limit: fetchLimit,
      ...(opts.until !== undefined && { until: opts.until }),
      ...(opts.id && { '#d': [opts.id] }),
    });

    const result = buildPage(events);

    if (isFirstPage) {
      _vaultCache.set(pubkey, { ...result, fetchedAt: Date.now() });
      _saveVaultCache();
    } else if (!opts.id) {
      const existing = _vaultCache.get(pubkey);
      if (existing) {
        const seen = new Set(existing.plans.map((p) => p.id));
        const appended = result.plans.filter((p) => !seen.has(p.id));
        _vaultCache.set(pubkey, {
          plans: [...existing.plans, ...appended],
          hasMore: result.hasMore,
          fetchedAt: existing.fetchedAt,
        });
        _saveVaultCache();
      }
    }

    return { ...result, cached: false, stale: false };
  }

  async function listOwn(
    opts: { until?: number; id?: string } = {},
  ): Promise<{ plans: NostrDocInfo[]; hasMore: boolean; cached: boolean }> {
    return list(await getNostrPubkey(), opts);
  }

  /** Retry publishing the last document to a specific relay — re-runs the exact same reactive
   *  chunking ladder `publish` uses, rather than a single verbatim republish. */
  async function retryRelay(relay: string): Promise<void> {
    if (!_lastPublished) return;
    const { docId, createdAt, gen, sharedTags, content, indexEvent } = _lastPublished;
    _setHealth(relay, 'checking');

    const sk = await getOrCreateSecretKey();
    const wholeEvent = buildWholeEvent(dataKind, sk, docId, createdAt, gen, sharedTags, content);
    const [dataOutcome, indexOk] = await Promise.all([
      publishDataToRelay(dataKind, relay, sk, docId, createdAt, gen, sharedTags, content, wholeEvent),
      publishIndexToRelay(relay, indexEvent),
    ]);
    const success = dataOutcome === 'connected' && indexOk;
    _setHealth(relay, success ? 'connected' : dataOutcome === 'skipped' ? 'skipped' : 'error');
  }

  return { publish, fetch: fetchOne, rename, delete: deleteOne, duplicate, list, listOwn, retryRelay, invalidateVaultCache };
}

/**
 * Label for a publish/save action driven by a vault-list selection: "Publish" for the New row,
 * "Update" when the selection is the item already open, "Overwrite" for any other item.
 */
export function getPublishActionLabel(
  selectedId: string | undefined,
  currentOpenId: string | undefined,
): 'Publish' | 'Update' | 'Overwrite' {
  if (!selectedId) return 'Publish';
  return selectedId === currentOpenId ? 'Update' : 'Overwrite';
}
