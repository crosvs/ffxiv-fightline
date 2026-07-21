# Relay pool, health tracking, and consensus

## Relay list

```ts
export const NOSTR_RELAYS = [
    'wss://nos.lol',
    'wss://nostr.mom',
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://relay.snort.social',
];
```

A hardcoded list of five public relays. No relay-discovery protocol (NIP-65 relay lists, etc.) is
used — every operation fans out to this fixed set. This is a reasonable starting point for a
port, but pick relays independently; XIVPlan's list reflects relays it has empirically found
reliable enough (see the size-limit caveats below) and that may not hold for another app's needs.

## Pool setup

```ts
const _pool = new AbstractSimplePool({
    verifyEvent,
    maxWaitForConnection: RELAY_TIMEOUT_MS,   // 12000ms
    onRelayConnectionSuccess: (url) => _setHealth(url, 'connected'),
    onRelayConnectionFailure: (url) => _setHealth(url, 'error'),
});
```

Built on `nostr-tools`' `AbstractSimplePool` rather than the friendlier `SimplePool` wrapper,
specifically because `SimplePool`'s constructor type only exposes `enablePing`/`enableReconnect`
and hardcodes `maxWaitForConnection` to 3000ms — once a per-call `maxWait` exceeds that, the
actual connection timeout it derives is `max(maxWait * 0.8, maxWait - 1000)`, silently capping the
WebSocket handshake well under what you asked for. `AbstractSimplePool` lets you pass
`maxWaitForConnection` explicitly. **If you use `SimplePool` in a port, check this arithmetic
against whatever `maxWait` you pick, or you'll get mysteriously truncated timeouts.**

A single pool instance is module-level and reused for the lifetime of the page — connections are
kept warm across operations rather than reopened per call.

## Timeout constants

```ts
const RELAY_TIMEOUT_MS = 12000;   // per-relay read timeout AND pool's maxWaitForConnection budget
const QUERY_GRACE_MS = 2000;      // extra time beyond RELAY_TIMEOUT_MS before giving up
const PUBLISH_TIMEOUT_MS = RELAY_TIMEOUT_MS + QUERY_GRACE_MS;
```

Every other relay-facing timeout in the file derives from `RELAY_TIMEOUT_MS` so they can't drift
out of sync with each other. `QUERY_GRACE_MS` exists because `RELAY_TIMEOUT_MS` is *also* the
connection budget — a relay that takes the full budget just to open its WebSocket would otherwise
have zero time left to actually answer a query or acknowledge a publish; the grace period is what's
left over for that after a maximal-length connection.

## Consensus rule: strict majority

```ts
export function consensusThreshold(relayCount: number): number {
    return Math.floor(relayCount / 2) + 1;
}
```

A plan is only treated as "properly" read or written once **more relays hold that version than
don't** — for 5 relays, that's 3. This is the single rule that both the publish path and the fetch
path build on. Anything short of a strict majority leaves room for a stale-relay minority to look
like consensus.

## `fanGet`: parallel fetch with early-exit consensus

This is the core read primitive (`nostr.ts`, ~150 lines) used by both plan-data fetch and
publish-verification. Its contract:

- Queries every relay in parallel, **each with its own `subscribeMany` call** rather than one call
  shared across all relays — this keeps `nostr-tools`' internal dedup-by-id scoped per relay, so a
  misbehaving relay can't shadow another relay's genuine delivery of the same event id (a raw `id`
  claim is checked before the event is even parsed/verified).
- Reacts to `onevent` directly rather than the `get()`/`querySync()` convenience wrappers, because
  those only resolve once *that specific relay* reaches EOSE — gating consensus-checking on a
  slow-to-EOSE relay even after the actual event already arrived on the wire.
- After every new event, recomputes: is there a group of events (grouped by a caller-supplied
  `groupKey`, default = event id) with `agreeingRelays >= consensusThreshold(activeRelays)` **and**
  no other group with a higher `created_at` that could still outrank it? If so, resolve
  immediately — no need to wait out remaining relays.
- Falls back to "best `created_at` seen so far" once the fallback timeout elapses with no
  consensus reached.
- Supports mid-flight **pruning** — a caller can end a specific relay's subscription early (e.g.
  once it's known that relay can't possibly hold the answer), and consensus is rechecked against
  the shrunken relay set.
- A custom `groupKey` lets a caller treat physically different events as "the same version" — used
  by data-event fetch to group by `created_at + gen` instead of event id, since two relays can
  legitimately hold byte-different chunk-1 events (different declared chunk count) for what is
  conceptually the same published version.

```ts
async function fanGet(
    filter,
    relays = NOSTR_RELAYS,
    fallbackTimeoutMs = RELAY_TIMEOUT_MS + QUERY_GRACE_MS,
    registerPruner?: (prune: (relay: string) => void) => void,
    trackUiStatus = true,
    groupKey: (event) => string = (e) => e.id,
): Promise<FanGetResult>
```

`FanGetResult` returns not just the winning event but per-relay labels (`connected` / `stale` /
`skipped` / `error` / `incomplete`) and each agreeing relay's own copy of the event — the latter
needed for read-repair (see [05-fetching-and-repair.md](05-fetching-and-repair.md)).

There's also `fanGetInternal`, a thin wrapper for auxiliary lookups (e.g. the post-publish
verification round-trip) that opts out of the shared UI status stores so it can't be mistaken for
the user-visible fetch the UI is currently showing progress for.

## Live status stores (for UI)

Three independent pub/sub stores, all following the same shape — a `Map` of mutable state, a
`Set` of listener callbacks, and a cached snapshot array kept `Object.is`-stable between reads (for
`useSyncExternalStore` compatibility):

1. **Relay health** (`subscribeRelayStatus` / `getRelayStatus`) — general connectivity, updated by
   the pool's connection-success/failure hooks and by `probeRelays()`.
2. **Fetch status** (`subscribeFetchStatus` / `getFetchStatus`) — per-relay status *for the
   in-progress `fanGet` call*, distinct from general health. Reset at the start of each
   UI-tracked `fanGet`. Guarded by a monotonically increasing `_fetchGeneration` counter so that
   if a second fetch starts before the first resolves (e.g. opening a second plan quickly), the
   stale call detects it's no longer the latest and stops writing to the shared store instead of
   fighting the new call for what's on screen.
3. **Consensus progress** (`createProgressStore()`, instantiated once for fetch and once for
   publish) — `{ agreeing, threshold, total, status: 'pending' | 'reached' | 'short' }`, useful for
   a progress indicator like "3/5 relays agree" while an operation is in flight.

## Relay size limits (NIP-11) and adaptive learning

Relays advertise a `max_message_length` via their NIP-11 info document
(`https://<relay-host>/` with an `Accept: application/nostr+json` header). XIVPlan fetches and
caches this per relay, but treats it only as a *hint*: some relays (observed: `nos.lol`,
`nostr.mom`) reject events well under their advertised max. `learnSizeLimitFromRejection` tightens
the cached limit whenever a publish is actually rejected with a size-related reason:

```ts
const SIZE_REJECTION_PATTERN = /too large|too big|max.{0,20}(size|length)|size.{0,20}(exceed|limit)/i;
```

`probeRelays()` (rate-limited to once per 5 minutes) opportunistically warms both the connectivity
health map and the size-limit cache in the background, so a later publish doesn't have to wait on
a fresh NIP-11 round-trip before it can even start. The cache-only lookup used on the hot path
(`peekRelayLimits`) never triggers a network request itself — an unresponsive relay for *that*
lookup would defeat the point of skipping it quickly.

## Porting notes

- The strict-majority consensus rule, the per-relay-subscription dedup isolation, and the
  "resolve as soon as consensus is reached, don't wait for stragglers" pattern are the most
  reusable and non-obvious pieces here — worth porting close to verbatim rather than
  reinventing.
- If porting into an app with fewer/more relays, just changing `NOSTR_RELAYS` and re-deriving
  `consensusThreshold` from its length is enough — nothing else hardcodes "5".
- The NIP-11 size-limit learning is a nice-to-have that only matters once you observe real
  relay rejections in production; a first port can skip it and hardcode a conservative chunk-size
  assumption instead (see [04-publishing.md](04-publishing.md)).
