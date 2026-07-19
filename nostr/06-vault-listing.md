# Vault listing (the "my plans" list)

## Query shape

```ts
export async function listPlans(
    pubkey: string,
    opts: { until?: number; id?: string } = {},
): Promise<{ plans: NostrPlanInfo[]; hasMore: boolean; cached: boolean; stale: boolean }>
```

Only queries `kinds: [PLAN_KIND]` (30078, index events) — data events never appear in a listing
query, keeping it cheap regardless of how large individual plans' data events are.

```ts
export interface NostrPlanInfo {
    id: string;
    name: string;
    publishedAt: Date;
    visibility: 'public' | 'private';
}
```

## Why over-fetch before deduping

```ts
const fetchLimit = (VAULT_PAGE_SIZE + 1) * 4;   // VAULT_PAGE_SIZE = 20
```

Relays apply the requested `limit` **before** cross-relay dedup happens, and a relay isn't
guaranteed to have promptly purged superseded versions of a replaceable event from its own
top-N-by-recency slice. That means a naive `limit: 21` request could have several of its slots
consumed by stale duplicates of plans already represented elsewhere, silently shrinking the
deduped result below a full page and making `hasMore` unreliable. Requesting 4x headroom gives
`fanQuery`'s dedup step enough slack to still surface a full page (and an accurate `hasMore`) even
when a chunk of what comes back turns out to be duplicates.

## `fanQuery`: merge + replaceable-event dedup

Distinct from `fanGet` (used for reads) — `fanQuery` is a simpler "ask every relay, merge
everything" query used only for listing, not for single-event consensus:

1. Query every relay in parallel via `querySync`, tolerating per-relay failures
   (`Promise.allSettled`).
2. Merge all returned events, deduplicated by event id first.
3. **Then** apply replaceable-event semantics: for kinds in the 30000–39999 range, group by
   `pubkey:kind:d-tag` and keep only the highest-`created_at` event per group — this is what
   collapses "the same plan, as seen by 5 different relays, possibly at different versions" down
   to one row.

## Local cache

A two-layer cache: an in-memory `Map<pubkey, VaultCachePage>` mirrored to `localStorage` (key
`xivplan:vault-cache`) so the list survives a page reload without a relay round-trip.

```ts
const VAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
```

- **First page only** is cached (`opts.until === undefined && !opts.id`). Subsequent "load more"
  pages are appended to the cache (extending the stored list) but don't reset the freshness clock
  — `fetchedAt` is preserved from the original first-page fetch.
- **Cache hit within TTL** → `{ ...cached, cached: true, stale: false }`, zero relay traffic.
- **Cache hit past TTL** → still returned immediately (`stale: true`), letting a caller render
  instantly from cache and trigger a background revalidation (this is exactly what
  `NostrVaultList` does — see [08-ui-integration.md](08-ui-integration.md)).
- **Cache miss** → a real `fanQuery`, then written into both the in-memory map and
  `localStorage`.

```ts
export function invalidateVaultCache(pubkey?: string): void
```

Called after publish/rename (indirectly, via the optimistic upsert below) and delete, or by an
explicit user-triggered "Refresh."

## Optimistic cache updates

Rather than re-querying relays after every mutation, `nostr.ts` writes the known-good result
straight into the cache:

```ts
function upsertVaultCacheEntry(pk: string, entry: NostrPlanInfo): void {
    const existing = _vaultCache.get(pk);
    if (existing) {
        const filtered = existing.plans.filter((p) => p.id !== entry.id);
        _vaultCache.set(pk, { plans: [entry, ...filtered], hasMore: existing.hasMore, fetchedAt: Date.now() });
        _saveVaultCache();
    } else {
        invalidateVaultCache(pk); // no cached page to patch — just drop it, next list() call does a real fetch
    }
}
```

Called by both `publishPlan` and `renamePlan` after a successful write. This is the seam the UI
layer's `refreshToken` prop relies on — a component elsewhere in the app can trigger
`NostrVaultList` to re-sync from this already-updated cache without any network call. See
[08-ui-integration.md](08-ui-integration.md).

## Pagination cursor

The vault list is cursor-paginated by `created_at`, not offset-paginated:

```ts
opts.until  // pass floor(lastLoadedPlan.publishedAt.getTime() / 1000) - 1 for "load more"
```

`buildPage` sorts fetched events by `created_at` descending, slices to `VAULT_PAGE_SIZE` (20), and
reports `hasMore = events.length > VAULT_PAGE_SIZE` (a side effect of the over-fetch: if the raw
merged/deduped result exceeds one page's worth, there's more to load).

## Porting notes

- The `localStorage`-mirrored cache is a small, self-contained pattern — safe to copy close to
  verbatim, but namespace the storage key per app (`xivplan:vault-cache` → your app's own prefix)
  to avoid any risk of key collision if apps ever share an origin.
- The 4x over-fetch multiplier is empirically motivated, not derived from anything fundamental —
  keep it as a starting point, but if a port observes different dedup behavior from its relay set,
  adjust it.
- If a port doesn't need offline/instant-reload behavior, the `localStorage` mirror can be dropped
  and just keep the in-memory `Map` — you lose "list appears instantly on reload" but keep
  everything else (TTL, optimistic upsert, stale-while-revalidate).
