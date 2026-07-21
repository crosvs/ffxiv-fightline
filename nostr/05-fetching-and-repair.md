# Fetching, chunk reconstruction, and read-repair

## `fetchPlanData`: consensus + reconstruction

```ts
async function fetchPlanData(pubkey, planId, trackUiStatus = true): Promise<{
    primary: NostrEvent;      // the winning chunk-1 event
    chunks: NostrEvent[];     // one relay's full, ordered chunk set
    content: string;          // reassembled plaintext (still compressed/encrypted at this point)
    agreeingRelays: number;
    totalRelays: number;
    relayStatuses: Map<string, RelayHealth>;
}>
```

Two distinct phases:

1. **Consensus on the primary chunk**, via `fanGet` grouped by `${created_at}:${gen || id}` (see
   [01-architecture.md](01-architecture.md) for why `gen` matters here). This determines *which
   version* of the plan is the current one, exactly like fetching the index event — nothing about
   chunking is visible yet at this stage.
2. **Reconstruction**, only once a primary chunk has won: read its `chunk` tag to get `N`. If
   `N === 1`, done — `content` is just that event's content. Otherwise, fetch the sibling chunks
   `${planId}:2 .. ${planId}:N` from **the same relay** that supplied the winning primary chunk
   (cheapest-first: relays are tried in order of ascending declared chunk count, so an unchunked
   relay is checked before a heavily-chunked one).

Reconstruction deliberately never needs further cross-relay confirmation — every chunk is signed
by the same key, so a relay can't forge content or lie about its own `chunk` tag; consensus was
already the load-bearing check, at step 1, for *which version* to trust.

### Validating a sibling chunk set

```ts
const complete =
    rest.size === n - 1 &&
    [...rest.values()].every(
        (c) => c.created_at === primary.created_at && genOf(c) === genOf(primary) && chunkCountOf(c) === n,
    );
```

Checking `chunkCountOf(c) === n` (not just `created_at`/`gen`) matters because the chunking retry
ladder reuses the same `created_at`/`gen` across every rung of one publish attempt (2 → 4 → 8
chunks). If a relay's per-`d`-tag replaceable-event tie-break (equal `created_at` resolves to
lowest event id, not "most recent write") ever retains a stale rung's chunk alongside newer
siblings, that stale chunk's own `chunk` tag still declares the *old* rung's `N` — which is exactly
what this check catches. A relay that can't produce a fully matching set for `chunk1` is treated
as **incomplete** (distinct from `stale` — wrong version — and `error` — no response at all) and
tried against the next-cheapest candidate relay instead.

If no relay can supply a complete set, the fetch throws — there's no cross-relay splicing
fallback.

## Decryption / decompression order on read (inverse of publish)

```
if visibility === 'private': decrypt with NIP-44 (using own sk; throws if this session doesn't hold the publishing key)
if comp === 'gzip': gzip-decompress
JSON.parse
```

Decrypt-then-decompress mirrors publish's compress-then-encrypt. Visibility itself is read
straight off the `enc` tag when present, falling back to sniffing whether `content` parses as JSON
for legacy pre-`enc`-tag data (see [01-architecture.md](01-architecture.md)).

## Read-repair

Every successful `fetchPlan` also fires a **fire-and-forget** repair pass against any relay that
answered but was clearly behind:

```ts
function repairStaleRelays(sk, planId, createdAt, gen, sharedTags, content, chunks, agreeingRelays, relayStatuses) {
    if (agreeingRelays < REPAIR_MIN_AGREEMENT) return;   // REPAIR_MIN_AGREEMENT = 2
    const targets = [...relayStatuses]
        .filter(([, status]) => status === 'stale' || status === 'incomplete')
        .map(([url]) => url);
    for (const relay of targets) void repairOneRelay(relay, sk, planId, createdAt, gen, sharedTags, content, chunks);
}
```

Design points worth preserving in a port:

- **Only targets relays with positive evidence of being behind** (`stale` = answered with an
  older version; `incomplete` = right version, missing chunks). `skipped`/`error` relays are
  deliberately excluded — we have no evidence about what they currently hold (never heard from
  them, or gave up before they answered), and pushing to them assumes they're behind when they
  could just as easily be holding a genuinely newer version this fetch simply failed to see in
  time.
- **Requires `agreeingRelays >= 2`** (`REPAIR_MIN_AGREEMENT`) before repairing at all — a single
  relay's unconfirmed claim isn't real corroboration that repair-worthy relays are actually wrong;
  two independent relays agreeing is.
- **Never awaited, never throws** — this is opportunistic housekeeping the user didn't ask for; a
  failed repair attempt must be invisible.
- **Two-tier repair per relay** (`repairOneRelay`):
  1. Tier 1 (always available, even for someone else's public plan): verbatim-republish the exact
     already-signed chunk set reconstruction just used — zero re-signing, so a stale copy can
     never accidentally outrank a genuinely newer version this session simply hasn't seen.
  2. Tier 2 (owned plans only — needs the secret key): if even the verbatim set is still too big
     for this particular relay, fall back to the same reactive chunking ladder a fresh publish
     uses, but **reusing the original winning `created_at` exactly**, never a fresh timestamp —
     the repair must never look newer than the version it's repairing.

## Porting notes

- The "consensus decides the version, then reconstruction trusts the winning relay's own signed
  chunks with no further cross-relay checking" split is the key insight that keeps reconstruction
  cheap — don't re-verify chunks against every relay once you've already established which version
  won.
- Read-repair is a genuine nice-to-have, not required for correctness — if a port skips it, relays
  that fall behind (missed an update, came back online with stale data) simply stay behind until
  someone with the write key happens to republish. It's cheap to add later.
- If the target app never expects documents to need chunking, most of this file's complexity
  (steps 2 in reconstruction, tier-2 repair) disappears — you're left with "fetch, consensus,
  decrypt/decompress," which is a much smaller surface. Start there and add chunk-awareness only
  once real documents hit relay size limits.
