# Architecture: the two-event model

## Overview

Each saved plan is stored as **two separate Nostr events**, both published by the same key and
sharing the same `d` tag (the plan's id):

| Event | Kind | Purpose | Content |
|---|---|---|---|
| **Index** | `30078` | Lightweight metadata for vault listing | Always empty (`content: ''`) — everything is in tags |
| **Data** | `30079` | The actual plan JSON | Plaintext or NIP-44-encrypted, possibly gzip-compressed, possibly split into chunks |

```
export const PLAN_KIND = 30078;       // index — vault queries only ever fetch this kind
export const PLAN_DATA_KIND = 30079;  // data — only fetched when opening a specific plan
```

Both kinds are in Nostr's "parameterized replaceable event" range (30000–39999, NIP-33 / now
folded into NIP-01 as "addressable events"): for a given `(pubkey, kind, d-tag)` triple, only the
event with the highest `created_at` is meaningful — relays are expected to discard/replace older
versions automatically. This is what gives "save" the semantics of an overwrite rather than an
ever-growing history.

### Why two events instead of one

Listing "all of a user's plans" (the vault view) only needs `name` + timestamp + visibility — not
the full (possibly large, possibly chunked) plan JSON. By splitting metadata into its own tiny
kind-30078 event, the vault list query (`kinds: [30078], authors: [pubkey]`) never has to
transfer plan bodies over the wire. Opening a specific plan is the only time the kind-30079 data
event is fetched.

## The `d` tag / plan id

The `d` tag is a random 16-hex-char (8 byte) string, generated once when a plan is first
published and never changed afterward:

```ts
function randomPlanId(): string {
    return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
}
```

This id is what makes a plan URL stable across renames — renaming only republishes new index/data
events under the *same* `d` tag, so the same `(pubkey, id)` pair keeps resolving to the latest
version. See [07-sharing-and-urls.md](07-sharing-and-urls.md).

## Tag schema

### Index event (kind 30078)

```
['d', planId]
['name', displayName]
['v', formatVersion]        // e.g. "1"
['enc', 'nip44-self']        // present only if the plan is private
```

`content` is always `''`.

### Data event (kind 30079), unchunked case

```
['d', planId]                // same id as the index event
['name', displayName]
['v', formatVersion]
['comp', 'gzip']              // present only if content was gzip-compressed
['enc', 'nip44-self']         // present only if private
['chunk', '1/1']              // see chunking below
['gen', nonce]                // see "gen" below
```

`content` is the (possibly compressed, possibly encrypted) plan JSON.

### Data event, chunked case

When a relay rejects the whole event for being too large, the same logical event is instead
published as N separate kind-30079 events sharing one `created_at`:

- **Chunk 1** uses the plan's ordinary `d` tag (`planId`) and carries the *full* metadata tag set
  above (`name`, `v`, `comp?`, `enc?`).
- **Chunks 2..N** use `d = "${planId}:${i}"` and carry only `['d', ...]`, `['chunk', 'i/N']`,
  `['gen', nonce]` — no duplicated metadata, since nothing ever reads it off a non-primary chunk.

`content` for each chunk is a slice of the full JSON string, split by `splitIntoChunks` (see
[04-publishing.md](04-publishing.md)) and rejoined with plain concatenation on read.

Reconstructing a plan therefore means: fetch chunk 1 (the primary slot, same query as the
unchunked case), read its `chunk` tag to learn `N`, then — if `N > 1` — fetch
`${planId}:2 .. ${planId}:N` from **the same relay** that served chunk 1, and concatenate.

### Why `gen`

`created_at` has 1-second resolution. Two genuinely different publishes landing in the same
second (a rapid rename right after a save, or a fast automated test) would otherwise be
indistinguishable as "versions" when grouping relay responses. Every publish generates an 8-byte
random nonce (`gen`) that's stamped on every chunk of that publish (including the unchunked
case), and version-grouping keys off `created_at + gen` instead of `created_at` alone. Legacy
data published before this existed has no `gen` tag; grouping code falls back to the event's own
`id` in that case, which exactly restores plain per-event identity.

## Deletion (NIP-09)

Deleting a plan sends a single kind-5 event whose `a` tags reference every possible slot the plan
could occupy — the index, the primary data chunk, and every possible chunk index up to
`MAX_CHUNKS` (16), since different relays may have settled on different chunk counts for the same
plan and there is no other record of "the largest N any relay ever used":

```
['a', `30078:${pubkey}:${planId}`]
['a', `30079:${pubkey}:${planId}`]
['a', `30079:${pubkey}:${planId}:2`]
...
['a', `30079:${pubkey}:${planId}:16`]
```

## Format versioning

```ts
export const XIVPLAN_FORMAT_VERSION = 1;
```

Stamped as a `v` tag on both index and data events. Incremented only for backwards-incompatible
changes to the event structure itself (not the plan JSON schema, which is versioned separately by
the app's own scene serializer). A porting app should mint its own version constant — it is purely
informational; nothing in the current code branches on its value, but it's the escape hatch for
future protocol changes.

## Encryption (NIP-44, "self-encryption")

Private plans are encrypted with NIP-44 using a conversation key derived from the author's own
secret key and public key:

```ts
const convKey = nip44.getConversationKey(sk, pk); // pk === getPublicKey(sk)
const dataContent = nip44.encrypt(storedJson, convKey);
```

This is *not* sharing with another party — it's "encrypt to myself" so that only someone holding
this exact secret key can ever decrypt it, even though the ciphertext sits on public relays
alongside everyone else's public plans. There is no recipient-specific key exchange; a "private"
plan is only ever readable by the browser/profile that published it (or anyone who separately
obtains that key export).

Compression always happens **before** encryption, never after — encrypted bytes are
high-entropy and gzip cannot shrink them further (see [04-publishing.md](04-publishing.md)).

## Format-detection fallback for legacy data

Newer data events carry an explicit `enc` tag mirroring the index event's. Older published plans
predate that tag; for those, the code sniffs whether `content` parses as JSON — NIP-44 ciphertext
and gzip output both fail to parse as JSON, so a parse failure implies "private" for data with no
`comp` tag either. A porting app starting fresh doesn't need this fallback — always stamp `enc`
explicitly from day one.
