# Share-link URL scheme

## Format

```
<origin><path>#/nostr/<pubkey-token>/<id-token>
```

e.g. `https://xivplan.example/#/nostr/AbCd-1234.../wXyZ-5678...`

Both tokens are **raw bytes, base64url-encoded** (URL-safe alphabet, no `=` padding) — not the
human-oriented NIP-19 `npub`/`note` bech32 encodings. This keeps the URL as short as possible
(32 raw bytes for the pubkey, 8 raw bytes for the plan id, vs. bech32's overhead) since it's meant
to be pasted into chat apps, not read by a human.

```ts
export function getNostrShareUrl(pubkey: string, id: string): string {
    const pubToken = bytesToBase64Url(hexToBytes(pubkey));
    const idToken = bytesToBase64Url(hexToBytes(id));
    return `${location.protocol}//${location.host}${location.pathname}#/nostr/${pubToken}/${idToken}`;
}

export function decodeNostrUrlSegments(pubToken: string, idToken: string): { pubkey: string; id: string } | undefined {
    // base64url-decode both segments back to hex; returns undefined on any malformed input
    // (wrong pubkey byte length, empty id, decode failure)
}
```

Uses a **hash fragment** (`#/nostr/...`), not a query string or path segment — the fragment never
gets sent to any server on the initial page load, which matters because there is no server here at
all (this is a static SPA); the entire URL is resolved client-side by querying relays directly from
the browser.

## Why this differs from the app's other share-link format

XIVPlan has a second, older, non-Nostr share format (`#/plan/<url-encoded-json>`) that embeds the
*entire scene* directly in the URL — no server or relay round-trip needed to open it, but the URL
can become enormous for a complex document, and there's no way to update a previously-shared link
in place (a new save is a completely different URL). The Nostr format is the answer to both of
those limits: the URL is small and fixed-size regardless of document size, and it always resolves
to *whatever was most recently published* under that `(pubkey, id)` — republishing (a rename or an
edit) changes what the same link points to.

Both formats are parsed independently in `src/file/share.ts`; a port that doesn't already have an
embedded-data share format doesn't need to replicate that half at all — only the `#/nostr/...`
branch is relevant here.

## Resolving a URL to a document

`useSceneFromUrl()` (`share.ts`) is a React hook, called synchronously during render, that:

1. Checks `hash.startsWith('#/nostr/')`.
2. Parses out the two path segments after the prefix, decodes them via
   `decodeNostrUrlSegments`.
3. Calls React's `use()` on `getNostrFetchPromise(pubkey, id)` — **this suspends** the calling
   component tree until the relay fetch resolves, so the app can render a loading UI via
   `<Suspense>` rather than needing its own manual loading-state plumbing at the top level.

```ts
export function getNostrFetchPromise(pubkey: string, id: string): Promise<Scene | undefined> {
    const key = `${pubkey}|${id}`;
    if (key === _cacheKey && _cachedPromise) return _cachedPromise;  // stable across re-renders
    // ...kick off fetchPlan(pubkey, id), cache the resulting promise + side metadata...
}
```

Caching the in-flight promise by key is required for correctness with `use()`: React expects a
given call to `use()` during a render pass to see a *stable* promise reference across re-renders of
the same component, not a fresh one created every render.

A second, independent, **synchronous** helper (`useSourceFromUrl()`) builds a provisional
`FileSource` (`{ type: 'nostr', id, pubkey, name, visibility }`) straight from the decoded URL
segments plus whatever `getNostrFetchedName()`/`getNostrFetchedVisibility()` already have cached —
without waiting on the fetch promise. This lets the rest of the app (e.g. the toolbar's "is this my
plan" ownership check) have *something* to work with immediately, even before the suspended fetch
resolves, falling back to the raw id as a placeholder name.

## Consensus-shortfall signal for the URL path specifically

Because `getNostrFetchPromise` goes through the same `fetchPlan` as everything else, it also
captures `agreeingRelays`/`totalRelays` from that call:

```ts
export function consumeNostrFetchedConsensus(): { agreeingRelays: number; totalRelays: number } | undefined
```

This is a **consuming** read (clears the cached values after being read once) — deliberately, so
a "loaded from X/Y relays, may not be the latest version" warning fires exactly once per URL
navigation, not once per re-render. See [08-ui-integration.md](08-ui-integration.md) for how the
app wires this into a toast.

## Accepting pasted input loosely

`parseInputPubkey` (see [02-key-management.md](02-key-management.md)) accepts a full share URL as
one of its recognized input shapes — a user pasting `https://.../#/nostr/<pubToken>/<idToken>`
into a "browse this author's vault" field gets the pubkey segment extracted and decoded
automatically, rather than requiring them to know to strip it down to just the token or an npub.

## Porting notes

- The hash-fragment + base64url-token format is fully self-contained and framework-agnostic — copy
  it verbatim, it doesn't depend on anything else in this codebase besides `bytesToHex`/
  `hexToBytes`/base64url helpers (a handful of lines each, shown in `nostr.ts`).
- `use()` + a cached-by-key promise is a React 19+ pattern; if the target app is on an older React
  version (or a non-React framework), replace this with whatever that framework's idiomatic
  suspense/loading-state mechanism is — the underlying `fetchPlan(pubkey, id)` call and its
  `agreeingRelays`/`totalRelays` result are the actual reusable part.
- If the target app has its own router (React Router, TanStack Router, etc.) rather than raw
  `location.hash` parsing, prefer wiring the `#/nostr/:pubkey/:id` pattern into that router
  directly instead of copying XIVPlan's manual hash-parsing — the token encode/decode functions
  are what's worth reusing, not the routing mechanism itself.
