# Publishing pipeline

## End-to-end flow (`publishPlan`)

```ts
export async function publishPlan(
    scene: Scene,
    name: string,
    visibility: 'public' | 'private',
    id?: string,
): Promise<NostrFileSource>
```

1. Get (or lazily create) the signing key and derive the pubkey.
2. Serialize the document to JSON (app-specific — XIVPlan's `sceneToJson`).
3. **Compress** the JSON with gzip, but only keep the compressed form if it's actually smaller.
4. **Encrypt** with NIP-44 self-encryption if `visibility === 'private'` — always
   compress-then-encrypt, never the reverse (encrypted bytes are high-entropy; gzip can't shrink
   them at all once ciphertext).
5. Build the index event's tags (`d`, `name`, `v`, `enc?`) and the data event's shared tags
   (`name`, `v`, `comp?`, `enc?`).
6. Sign the index event.
7. Hand everything to `publishChunkedPlan`, which publishes to every relay in parallel, each
   relay running its own independent chunking retry ladder for the data event.
8. Optimistically update the local vault-listing cache so the plan appears in "my plans"
   immediately without a relay round-trip.

## Compression

```ts
function supportsCompression(): boolean {
    return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

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
```

Uses the browser's native [Compression Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API)
(Chrome/Edge 80+, Firefox 113+, Safari 16.4+) — no compression library dependency. Falls back to
plain JSON on unsupported browsers or any failure. The gzip bytes are base64url-encoded (URL-safe
alphabet, no padding) before going into an event's `content` string, since Nostr event content is
JSON-string-valued.

**Why compress at all:** some public relays silently drop/close-without-error events over a size
limit well under what a complex document serializes to (XIVPlan confirmed `nos.lol`/`nostr.mom`
close the connection with no error for a ~390KB event, while `relay.damus.io`/`relay.primal.net`
accept it fine). Gzip buys real headroom for free on repetitive JSON.

## Encryption (recap)

```ts
if (visibility === 'private') {
    const convKey = nip44.getConversationKey(sk, pk); // self: pk derived from same sk
    dataContent = nip44.encrypt(storedJson, convKey);
}
```

See [01-architecture.md](01-architecture.md) for why this is "self-encryption" rather than
recipient-specific sharing.

## Chunking: the retry ladder

Some relays reject a data event outright for size even after compression. Rather than picking a
conservative chunk size upfront (which would waste bytes on relays that don't need it), XIVPlan
tries the whole event first and only chunks reactively, per relay, doubling the chunk count until
it fits or a hard cap is hit:

```ts
const MAX_CHUNKS = 16;

async function publishDataToRelay(relay, sk, planId, createdAt, gen, sharedTags, content, wholeEvent) {
    const first = await tryPublishSet(relay, [wholeEvent]);
    if (first.ok) return 'connected';
    if (!first.sizeRejected) return 'error';       // rejected for a reason unrelated to size — give up

    let n = startingChunkCount(wireEventSize(wholeEvent), peekRelayLimits(relay).maxMessageLength);
    for (;;) {
        const set = buildChunkSet(sk, planId, createdAt, gen, sharedTags, content, n);
        const result = await tryPublishSet(relay, set);
        if (result.ok) return 'connected';
        if (!result.sizeRejected) return 'error';
        if (n >= MAX_CHUNKS) return 'skipped';       // this relay can never hold this plan
        n = Math.min(MAX_CHUNKS, n * 2);
    }
}
```

`startingChunkCount` uses this relay's *cached* NIP-11/rejection-derived size limit (if any) to
jump straight to a plausible `n` instead of always restarting the ladder at 2 — pure optimization,
falls back to `2` for an unknown relay.

Splitting is done by raw character index, with one guard: never split in the middle of a UTF-16
surrogate pair (anything outside the Basic Multilingual Plane — most emoji, some CJK), since each
half would otherwise independently encode an unpaired surrogate as U+FFFD on UTF-8 encode —
silent, unrecoverable data loss that rejoining could never undo:

```ts
function splitIntoChunks(content: string, n: number): string[] { /* ...boundary nudge for surrogate pairs... */ }
function joinChunks(pieces: string[]): string { return pieces.join(''); }
```

Chunks are **never spliced across relays** — a fetch always reconstructs from one relay's own
complete, self-consistent chunk set (see [05-fetching-and-repair.md](05-fetching-and-repair.md)).
This is what makes the whole scheme safe: a relay caught mid-publish (some chunks updated, some
still old) just looks like "doesn't have a valid matching chunk set yet," never a silent old+new
splice — the `chunk` tag on every piece declares its own `i/N`, checked against the primary chunk's
declared `N` on reconstruction.

## Publish + verify

```ts
async function publishChunkedPlan(pk, sk, planId, createdAt, sharedTags, content, indexEvent): Promise<void> {
    const gen = randomNonce();
    const wholeEvent = buildWholeEvent(sk, planId, createdAt, gen, sharedTags, content);

    // publish index + data to every relay in parallel, each with its own chunking ladder
    const perRelay = await Promise.allSettled(NOSTR_RELAYS.map(async (relay) => {
        const [dataOutcome, indexOk] = await Promise.all([
            publishDataToRelay(relay, sk, planId, createdAt, gen, sharedTags, content, wholeEvent),
            publishIndexToRelay(relay, indexEvent),
        ]);
        return { success: dataOutcome === 'connected' && indexOk, dataOutcome };
    }));

    const accepted = /* count of successes */;
    const skipped = /* count of relays whose ladder maxed out at MAX_CHUNKS */;
    // Judge against relays actually able to hold it — a relay that exhausted the ladder was never
    // going to succeed, the same way a pre-filtered "ineligible" relay wouldn't count in an older
    // design. Reporting against every configured relay would misreport a publish that reached
    // every relay actually capable of holding it as merely "short."
    const effectiveThreshold = consensusThreshold(NOSTR_RELAYS.length - skipped);

    if (accepted === 0) throw new Error(/* all relays too small, or none responded at all */);

    // Verify: read back the index event via fanGet and confirm it's exactly what we just signed.
    const { event: stored } = await fanGetInternal({ kinds: [PLAN_KIND], authors: [pk], '#d': [planId] }, NOSTR_RELAYS);
    if (!stored) throw new Error('Verification failed — the plan was not found on any relay after publishing.');
    if (stored.id !== indexEvent.id) {
        throw new Error('Another version was saved at the same time. If you have multiple tabs open, close the others and try again.');
    }
}
```

The post-publish verification round-trip catches a real race: if two tabs/sessions publish under
the same `(pubkey, planId)` at nearly the same instant, a relay's replaceable-event tie-break
(equal `created_at` resolves to lowest event id) could silently keep the *other* write instead of
this one. Comparing the fetched index event's id against what was just signed detects that
case explicitly rather than reporting false success.

`_lastPublishedPlan` stashes the last publish's inputs (`planId`, `createdAt`, `gen`, `sharedTags`,
`content`, `indexEvent`) purely so a user can retry a single failed relay later
(`retryRelay(relay)`) by re-running the *same* chunking ladder against just that relay, rather than
re-publishing everything from scratch.

## Porting notes

- The compress-then-encrypt ordering is a correctness requirement, not a style choice — get it
  backwards and compression becomes a no-op that just wastes CPU.
- The reactive, per-relay chunking ladder is the most involved piece of this entire file. If a
  port doesn't expect documents anywhere near relay size limits (a few KB, say), it's reasonable
  to skip chunking entirely for a first version and just accept that outsized documents fail to
  publish to some relays — add chunking later if it turns out to matter in practice.
- The post-publish verification step is cheap and worth keeping even in a simplified port — it's
  the only thing that catches "your save silently lost a race."
