# UI integration layer

Everything in this document sits on top of the protocol layer described in docs 01–07 and adds no
new Nostr semantics of its own — it's the React glue that turns `nostr.ts`'s exported
functions/stores into dialogs, buttons, and a data grid. XIVPlan's UI is built on Fluent UI
(`@fluentui/react-components`) and `react-use`'s `useAsyncFn` (a `{ loading, error, value }`
wrapper around an async action) — a port using a different design system only needs to replicate
the *behavior* described here, not these exact libraries.

## Live-status hooks (`useSyncExternalStore` wrappers)

Four tiny hooks, each subscribing to one of the shared pub/sub stores from
[03-relay-pool-and-consensus.md](03-relay-pool-and-consensus.md):

| Hook | Backing store | What it reflects |
|---|---|---|
| `useRelayStatus()` | `subscribeRelayStatus`/`getRelayStatus` | General connectivity — is each relay reachable right now, independent of any specific operation |
| `useFetchStatus()` | `subscribeFetchStatus`/`getFetchStatus` | Per-relay outcome of whichever `fanGet` fetch is currently in flight |
| `useConsensusProgress()` | `subscribeConsensusProgress`/`getConsensusProgress` | `{agreeing, threshold, total, status}` for an in-flight fetch |
| `usePublishProgress()` | `subscribePublishProgress`/`getPublishProgress` | Same shape, for an in-flight publish |

All four use `useSyncExternalStore` rather than `useState`+`useEffect`, deliberately: some updates
(e.g. the pool's connection-success/failure callbacks) can fire synchronously from deep inside
another component's render, and a fetch can even be *kicked off* synchronously during render (via
`use()` in the URL-loading path — see [07-sharing-and-urls.md](07-sharing-and-urls.md)).
`useState`-based subscription risks a "setState while rendering a different component" React
warning in that scenario; `useSyncExternalStore` is the mechanism React provides specifically for
stores that mutate outside of React's own render cycle.

`useRelayStatus()` also fires `probeRelays()` on mount (fire-and-forget; `nostr.ts` dedupes
concurrent probes) and derives two convenience booleans (`allChecked`, `anyConnected`) plus an
`aggregateRelayStatus(result)` rollup (`'checking' | 'connected' | 'partial' | 'offline'`) used for
indicator coloring.

## Status-rendering components

- **`relayStatusLabels.ts`** — three `Record<RelayHealth, string>` dictionaries
  (`CONNECTIVITY_STATUS_LABELS`, `FETCH_STATUS_LABELS`, `PUBLISH_STATUS_LABELS`) giving
  context-appropriate wording for the same underlying health values (e.g. publish's `skipped`
  reads as "too large", since that's the only reason a publish skips a relay).
- **`RelayStatusRow`** — one relay's row in a breakdown list: colored status dot (or spinner while
  `checking`), hostname with `wss://` stripped, label text, optional trailing slot (used for a
  per-relay Retry button). Purely presentational — takes `{ url, status, label, children? }`.
- **`CircularRelayIndicator`** — the signature widget: a small ring whose center-dot color is the
  aggregate relay health and whose outer ring is either an indeterminate spinner (no `progress`
  prop) or a determinate arc filled by `progress.agreeing / progress.threshold`, turning a
  distinct color when `progress.status === 'short'` (finished, but below consensus threshold) as
  opposed to still-in-progress. Hovering shows the full per-relay breakdown as a tooltip. Takes
  `{ progress?, relayStatus, labels, size?, className?, style? }` — a pure renderer of whatever the
  hooks above produce, with no calls into `nostr.ts` itself.
- **`RelayPublishList`** — maps `useRelayStatus()`'s relays through `RelayStatusRow`, labeled via
  `PUBLISH_STATUS_LABELS`; any `error` row gets an inline Retry button wired to `retryRelay(url)`
  (per-row `useAsyncFn`, so retrying one relay doesn't re-run the whole publish). Reads the shared
  store directly with **no props** — it always reflects whichever relay-touching operation most
  recently ran anywhere in the app. A sibling `RelayFetchList` (same pattern, `FETCH_STATUS_LABELS`)
  exists for the fetch side.

## Key management UI (`KeySection`)

A shared block shown at the top of every Nostr tab: shortened npub (full npub on hover), and
Save-key / Load-key / New-key buttons wired straight to `exportSecretKeyBlob` (downloaded via an
object-URL + synthetic click, named `xivplan-key-<npub-prefix>.txt`), `importSecretKey` (from an
uploaded `.txt`, with inline error display rather than throwing), and `generateNewKey` — the latter
gated behind a confirmation dialog warning that the old key's plans become un-republishable from
this browser, with an inline "save the current key first" affordance inside that same confirm
step.

## Publish flow (Save As / Share dialog)

Two near-duplicate implementations exist — `SaveNostr` (the Nostr tab of the classic Save-As
dialog) and `ShareDialogButton`'s `NostrTab` (the newer, unified Share dialog) — both following the
same shape:

1. `NostrVaultList` (below) lets the user pick an existing plan to overwrite, or the pinned
   "New plan" row with an editable name + public/private toggle.
2. A `canSave`/`canUpload` guard requires: a non-empty trimmed name, `relayStatus.anyConnected`,
   and *something* that actually needs writing (new plan, different existing plan selected, dirty
   scene, changed name, or changed visibility vs. whatever's currently open).
3. Confirming (button click or Enter-in-name-field) calls
   `publishPlan(scene, name, visibility, existingId?)` via `useAsyncFn`, driving a
   `CircularRelayIndicator` (labeled with `PUBLISH_STATUS_LABELS`) while in flight.
4. On success: `history.replaceState` to `getNostrShareUrl(pubkey, id)` (URL updates without a
   navigation), `setSource(nostrSource)` + `setSavedState(scene)` (marks the app's dirty-tracking
   as clean against this Nostr plan), and the tab flips into a "Published" view — the share URL in
   a read-only textbox plus `RelayPublishList` for the per-relay breakdown.
5. Both dialogs reset their "Published" view back to empty whenever they transition from
   closed→open (tracked via a `wasOpen`-style comparison during render, not a `useEffect`) —
   necessary because Fluent's `Dialog` doesn't unmount tab content between opens, so a stale
   success screen (with live Retry buttons for a *different* plan) would otherwise persist across
   dialog reopens.

`ShareDialogButton`'s version additionally has to pre-select the currently-open plan's row once
`useNostrPubkey()` resolves and turns out to match `source.pubkey` — done via a one-shot flag set
directly during render (not an effect) so it fires exactly once and doesn't clobber a selection the
user already made while the pubkey was still resolving.

## Open flow

`OpenNostr` (Nostr Vault tab of the Open dialog) and `ImportFromString` (a "paste a link" textarea,
for links shared outside the app, e.g. via Discord) are the two entry points, both converging on
`fetchPlan(pubkey, id)`:

1. Both gate on unsaved-changes confirmation first if the current scene is dirty.
2. Both then: `fetchPlan` → `history.replaceState` to the canonical share URL → `loadScene(scene)`
   → `setSource({type: 'nostr', ...})` → close the dialog.
3. Both show the same "loaded from X/Y relays — may not be the latest version" warning when
   `agreeingRelays < consensusThreshold(totalRelays)` — duplicated locally in each, rather than
   relying on the App-level consensus-warning effect below, since that one only fires for the
   direct-URL-navigation path.
4. `ImportFromString` additionally accepts the *other* (non-Nostr) share format and raw encoded
   scene text as fallbacks if the pasted text doesn't parse as a `#/nostr/...` link.

## `NostrVaultList` — the reusable vault data grid

The single most stateful piece of the UI layer, reused (with different prop configurations) by
Open, Save-As, and Share. Its job is "browse a pubkey's published plans, with pagination, and let
the containing dialog react to selection."

**Contract it needs from the protocol layer:** a paginated `listPlans(pubkey, {until}) ->
{plans, hasMore, cached, stale}` backed by a cache that publish/rename/duplicate write straight
into (so this component's own reads never need to invalidate anything to stay in sync with a
mutation elsewhere); `renamePlan`/`deletePlan`/`duplicatePlan` each returning enough of the updated
record to splice into local state directly, with no re-fetch needed.

Key behaviors:

- **Pagination cursor**: tracks `until` locally, derived as
  `floor(lastLoadedPlan.publishedAt/1000) - 1` after each page, and appends (rather than replaces)
  on "load more."
- **Stale-while-revalidate**: if `listPlans` reports `stale: true` (cache hit past freshness
  window), the list renders immediately from the stale cache, then a background effect
  immediately busts the cache and reloads — invisible to the user beyond an eventual list update.
- **Optimistic local mutation** rather than re-fetching the list after every action: delete
  filters the row out locally; rename splices the returned updated record into place (and, if the
  edited row was selected, re-fires the selection callback with fresh data so callers relying on
  "the selected plan" see the update too); duplicate prepends a new row **only when the vault
  currently being viewed is the signer's own** (duplicates always land in the signer's vault
  regardless of which vault is being browsed, but only show up locally if that happens to be the
  same vault currently on screen).
- **`refreshToken` prop**: an incrementing number a parent bumps to force a resync *from the
  already-updated cache* (no cache-bust) after it — not this list — performed a mutation
  elsewhere (e.g. a Share-dialog publish). This is the seam that lets a publish somewhere else in
  the UI reflect into this list without a relay round-trip, relying on the protocol layer's own
  optimistic cache upsert (see [06-vault-listing.md](06-vault-listing.md)).
- **Pinned "New plan" row**: rendered outside the normal paginated `items` array (via a sentinel
  id) so it's always visible regardless of scroll position or pagination state.
- **Author browsing**: a secondary modal accepts npub/hex/full-share-link input (via
  `parseInputPubkey`) to browse someone else's public vault; another author's private-plan rows
  are shown (metadata is public even if content isn't) but visually dimmed and inert
  (`pointer-events: none`) rather than hidden — they exist on relays, they're just undecryptable to
  a non-owner.
- **`disabled` prop**: dims and disables the entire list, used while a containing publish/open
  action elsewhere is in flight, so the vault can't be mutated mid-operation.

```ts
interface NostrVaultListProps {
  ownVaultOnly?: boolean;
  showPublishAsNew?: boolean;
  newPlanName?: string;
  onNewPlanNameChange?: (value: string) => void;
  renameSelectedInline?: boolean;   // edit selected row's name in place instead of a separate Edit dialog
  visibility?: 'public' | 'private';
  onVisibilityChange?: (value: 'public' | 'private') => void;
  selectedId: string | undefined;
  onSelectedChange: (item: NostrPlanInfo | undefined, pubkey: string | null) => void;
  onRowDoubleClick?: (item: NostrPlanInfo, pubkey: string) => void;
  refreshToken?: number;
  onSubmit?: () => void;
  disabled?: boolean;
}
```

## Portal pattern for dialog actions

`FileDialog`'s `OpenDialog`/`SaveAsDialog` host multiple tabs (local file, browser storage, Nostr,
import, etc.), and each tab needs to control the shared dialog footer's action buttons even though
the footer lives outside that tab's own DOM position. XIVPlan solves this with
`react-reverse-portal`: the parent dialog creates one `HtmlPortalNode`, passes it to every tab as an
`actions` prop, and renders `<OutPortal node={actions} />` once in its fixed footer; each tab
renders `<InPortal node={actions}><DialogActions>...</DialogActions></InPortal>` wherever is
convenient in its own tree. Worth replicating in any port with a similar multi-tab-dialog-with-
shared-footer shape, regardless of design system.

## Resolving a Nostr URL at page load (App-level wiring)

Distinct from the in-dialog Open flow — this is what happens when a share link is opened directly
in a browser (a fresh tab, or pasted into an address bar):

1. `useSceneFromUrl()`/`useSourceFromUrl()` (from `share.ts`) are called synchronously during the
   render of the app's top-level providers, seeding `SceneProvider`'s `initialScene`/
   `initialSource`. The scene half suspends via React's `use()` on
   `getNostrFetchPromise(pubkey, id)`; the source half is synchronous and returns a provisional
   `FileSource` immediately from whatever's already cached (falling back to the raw id as a
   placeholder name).
2. Because the scene half suspends, the app wraps its providers in `<Suspense>`, whose fallback
   checks if the pending hash is a Nostr link and, if so, renders `CircularRelayIndicator` (fed by
   `useConsensusProgress()`/`useFetchStatus()`) instead of a generic spinner — so a cold page load
   of a Nostr share link gets the same relay-status visualization as an in-dialog fetch.
3. Any plan loaded via a share URL (Nostr or the other embedded-data format) starts the app in
   **preview mode** (editor panels hidden) — a shared behavior across both share-link kinds, not
   Nostr-specific.
4. A `NostrConsensusWarning` component, mounted unconditionally, calls
   `consumeNostrFetchedConsensus()` once in an effect with an empty dependency array — a
   *consuming* read (see [07-sharing-and-urls.md](07-sharing-and-urls.md)) so the "loaded from X/Y
   relays" warning toast fires exactly once per navigation, immune to React StrictMode's dev-mode
   double-invoke of effects.

## Toolbar wiring (re-save without a dialog)

The main toolbar's Save button adapts its label/behavior based on the currently open
`FileSource` and the live, reactive `useNostrPubkey()`:

- No source → "Save as." A `blob` source → "Download." Any other local source → "Save" (disabled
  if not dirty).
- A Nostr source **owned by the current key** → "Publish" (disabled if not dirty) — clicking it
  calls `publishPlan(scene, source.name, source.visibility ?? 'public', source.id)` **directly**,
  with no dialog, no name prompt: same id, same name/visibility already on the open source. This is
  the only call site of `publishPlan` outside the dialog components.
- A Nostr source **not owned by the current key** (or ownership not yet resolved) → falls back to
  "Save as" — republishing someone else's plan silently under your own key would be surprising, so
  it's never offered as a one-click action.

`Ctrl+S` routes to this same one-click save path; `Ctrl+Shift+S` always opens the full Save-As
dialog regardless of what's currently open. Because `useNostrPubkey()` is reactive, switching keys
while a Nostr plan you no longer own is open flips the button from "Publish" back to "Save as" live,
with no reload.

## Porting notes

- The four `useSyncExternalStore`-based status hooks plus `CircularRelayIndicator` are the most
  broadly reusable UI pieces here — they have no XIVPlan-specific dependencies beyond the shape of
  `RelayHealth`/`ConsensusProgress`, and give a port a "relay operation in progress" indicator for
  free.
- `NostrVaultList`'s optimistic-update + `refreshToken` pattern is worth preserving even in a
  simpler port: it's what keeps a publish in one part of the UI from requiring every other open
  vault-list view to re-fetch from relays to stay in sync.
- The dual `SaveNostr`/`ShareDialogButton` implementations are partially redundant in XIVPlan
  itself (a known area of duplication, not a pattern to imitate) — a fresh port should pick **one**
  unified "publish/share" surface rather than replicating both.
