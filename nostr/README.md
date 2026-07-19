# XIVPlan Nostr Integration — Documentation

This folder documents how XIVPlan uses the [Nostr](https://nostr.com/) protocol to publish,
share, and sync raid-plan documents without a backend server. It exists so the same pattern can
be replicated in other web apps — the immediate target being
[ffxiv-fightline](https://github.com/Airex/ffxiv-fightline).

There is no server anywhere in this design. "Saving to the cloud" means signing an event with a
locally-generated key and broadcasting it to a handful of public relays; "loading a shared plan"
means asking those same relays for the event and reconstructing it client-side. Everything here
runs in the browser.

## Why Nostr for this use case

- **No backend to run or pay for.** Public relays are free, shared infrastructure.
- **Identity is just a keypair.** No accounts, no login, no email. The secret key generated on
  first use *is* the user's identity, stored in IndexedDB.
- **Content-addressed enough for consensus.** Nostr's replaceable-event model (same pubkey +
  `kind` + `d` tag = latest version wins) gives a natural "last write wins" story, and querying
  several relays in parallel gives just enough redundancy to detect a stale or lying relay.
- **Optional end-to-end encryption.** NIP-44 lets a plan be "private" (only decryptable by the
  publishing key) while still living on public infrastructure.

The tradeoff: relays are unreliable, rate-limited, and size-limited, and there's no server to lean
on for consistency. Most of the complexity documented here (consensus thresholds, chunking,
read-repair) exists specifically to paper over that unreliability.

## Reading order

1. [01-architecture.md](01-architecture.md) — the two-event model, kinds, tag schema. Read this first.
2. [02-key-management.md](02-key-management.md) — where the identity keypair comes from and how it's stored.
3. [03-relay-pool-and-consensus.md](03-relay-pool-and-consensus.md) — the relay pool, health tracking, and the "strict majority" consensus rule used for both reads and writes.
4. [04-publishing.md](04-publishing.md) — compression, encryption, chunking, and the publish/verify flow.
5. [05-fetching-and-repair.md](05-fetching-and-repair.md) — fetching a plan, reconstructing chunks, and opportunistic read-repair of stale relays.
6. [06-vault-listing.md](06-vault-listing.md) — paginated "my plans" list with local caching.
7. [07-sharing-and-urls.md](07-sharing-and-urls.md) — the share-link URL format and how it round-trips to relay queries.
8. [08-ui-integration.md](08-ui-integration.md) — the React hooks/components layer built on top of the above, and how they compose into the publish/open/vault UX.
9. [09-porting-guide.md](09-porting-guide.md) — a concrete checklist for porting this into another app (written with ffxiv-fightline in mind).

## Source of truth

All of this is derived from XIVPlan's own source, primarily:

- [`src/file/nostr.ts`](../../src/file/nostr.ts) — the entire protocol layer (~1900 lines, no UI).
- [`src/file/share.ts`](../../src/file/share.ts) — URL parsing/routing glue.
- [`src/SceneProvider.tsx`](../../src/SceneProvider.tsx) — defines `NostrFileSource`, the shape describing "this open document came from Nostr."
- `src/file/*.tsx` / `src/file/use*.ts` — the React UI layer (dialogs, vault list, relay status indicators).

If the code and these docs ever disagree, trust the code — this documentation describes a
snapshot and should be updated alongside future changes to `nostr.ts`.

## Minimal dependency footprint

```json
{
  "nostr-tools": "^2.23.8",
  "localforage": "^1.10.0"
}
```

`nostr-tools` provides event signing/verification, the relay pool primitive, NIP-19 (npub)
encoding, and NIP-44 encryption. `localforage` is only used as an IndexedDB wrapper for the
secret key (a plain `localStorage` string would also work, but wouldn't survive as gracefully
across browsers/quota edge cases). Nothing else Nostr-specific is required — no relay SDK, no
NIP-07 browser extension dependency (XIVPlan intentionally uses a locally-generated key instead
of "login with Nostr extension").
