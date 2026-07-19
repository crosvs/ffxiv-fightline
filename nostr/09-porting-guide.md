# Porting guide: wiring this into ffxiv-fightline

This doc translates docs 01–08 into concrete steps for
[Airex/ffxiv-fightline](https://github.com/Airex/ffxiv-fightline). It assumes you've read at
least [01-architecture.md](01-architecture.md) through
[03-relay-pool-and-consensus.md](03-relay-pool-and-consensus.md) first.

## Key difference from XIVPlan: fightline already has a server

This is the one architectural fact that should shape everything else. XIVPlan is a static SPA with
**no backend at all** — Nostr isn't an *additional* persistence option there, it's the *only*
persistence option, which is why the protocol layer in `nostr.ts` had to grow features like
read-repair, chunking, and vault caching that a normal CRUD backend would give you for free.

fightline is different: it's an ASP.NET Core app (`FightTimeLine.csproj`, `Controllers/`,
`DataLayer/`, `Hubs/` — SignalR) with an Angular 18 client (`ClientApp/`), and it already has a
real save/list/load pipeline for fights:

```ts
// ClientApp/src/services/fight/fight.service-interface.ts
export interface IFightService {
  saveFight(fight: IFight): Observable<IFight>;
  getFight(id: string): Observable<IFight>;
  getFightsForUser(): Observable<IFight[]>;
  newFight(fraction: string): Observable<IFight>;
  // ...boss/command endpoints, unrelated to this port...
}
```

So the goal here is almost certainly **not** "replace the database with Nostr" — it's adding a
second, independent publish target: **"share this fight as a portable, serverless link that
anyone can open without a fightline account, and that keeps working even if fightline's own
server goes away."** That's the same value proposition XIVPlan gets from Nostr, just added
*alongside* an existing backend rather than *instead of* one. Keep the two paths deliberately
separate — don't try to make Nostr a drop-in `IFightService` implementation, since features like
`getBoss`/`addCommand`/collaborative editing commands are backend-specific concepts with no Nostr
equivalent in this design.

## Stack translation (React+Fluent → Angular+RxJS)

Everything in `nostr.ts` (docs 01–07) is **framework-agnostic TypeScript** — no React import
anywhere in that file. It ports to Angular essentially unchanged as a plain injectable service or
a standalone module of exported functions; Angular doesn't need it rewritten as RxJS at that layer.
Only the UI layer (doc 08) needs translating:

| XIVPlan (React) | fightline equivalent |
|---|---|
| `useSyncExternalStore`-based hooks (`useRelayStatus`, `useFetchStatus`, `useConsensusProgress`) | An `Observable`/`BehaviorSubject`-backed Angular service — wrap the same underlying `subscribe*`/`get*` pub-sub pattern from `nostr.ts` in an RxJS `Observable` (e.g. `new Observable(sub => subscribeRelayStatus(() => sub.next(getRelayStatus()))).pipe(startWith(getRelayStatus()))`), or a `signal()` if the app has started adopting Angular signals. |
| `useAsyncFn` (`{loading, error, value}`) | Any of: a small RxJS-based async-state wrapper, or just `.subscribe()`/`await` with local `loading`/`error` fields on the component, matching whatever pattern the rest of `services/fight` already uses for its own `Observable`-returning calls. |
| Fluent UI `Dialog`/`DataGrid`/`MessageBar` | `ng-zorro-antd` (already a dependency — `Modal`, `Table`, `Alert` are the closest equivalents) |
| `react-reverse-portal` (shared dialog footer across tabs) | `ng-zorro-antd`'s `Modal` footer + Angular's `ng-content`/`ContentChild` projection, or `nzModalFooter` on the modal component — no external portal library needed in Angular for this |
| `history.replaceState` for share-URL updates | Same Web API works identically — or `Location.replaceState()` from `@angular/common` if you want it Angular-idiomatic |
| React `Suspense` + `use()` for URL-driven load | Angular has no direct equivalent; just resolve the fetch in an Angular route `resolve` guard, or in the page component's `ngOnInit` with a loading spinner — simpler than the React suspense dance, not harder |

Dependencies to add to `ClientApp/package.json`:

```json
{
  "nostr-tools": "^2.23.8",
  "localforage": "^1.10.0"
}
```

Both are plain browser-compatible packages with no React/Angular-specific bindings — no
`@angular/*` wrapper needed, use them directly from a service.

## Where to put the code

Following fightline's existing `services/<feature>/` convention (mirroring `services/fight/`):

```
ClientApp/src/services/nostr/
  nostr.service.ts          -- port of xivplan's nostr.ts (key mgmt, publish, fetch, vault, consensus)
  nostr.service-interface.ts -- optional, if you want DI-swappable/mockable like fight.service does
  nostr-share.model.ts       -- the "NostrFightSource" shape (mirrors xivplan's NostrFileSource)
```

Keep it as its own service, not folded into `fight.service.ts` — the two have almost no shared
surface (server CRUD vs. relay publish/fetch), and fightline's existing pattern of one interface +
one real implementation + one mock (`fight.service-mock.ts`) per feature area is worth following
here too (a `nostr.service-mock.ts` makes UI development possible without hitting real relays).

## Data model translation

XIVPlan publishes `sceneToJson(scene)` — swap for fightline's own fight serialization. Concretely:
whatever `IFight` (or the DTO `saveFight()` sends to the server) serializes to is what becomes the
Nostr data event's `content`. Two things to check before wiring this up for real:

1. **Size.** A fight plan with a long boss-attack timeline, custom notes, and marker data may be
   considerably larger than an XIVPlan scene (which is mostly geometric shapes). If `IFight`
   commonly serializes past a few hundred KB, the chunking pipeline in
   [04-publishing.md](04-publishing.md) isn't optional polish — budget time for it from the start
   rather than bolting it on after relays start rejecting real fights.
2. **What actually gets shared.** fightline fights reference boss data (`IBoss`,
   `getBoss`/`saveBoss`) and possibly FFLogs-derived timeline data pulled from
   `FFLogs-data.service.ts` at load time — decide whether a Nostr-published fight needs to be
   **fully self-contained** (embed everything needed to render it with zero fightline-server
   calls, matching the "no backend" spirit of the rest of this design) or whether it's acceptable
   for a shared link to still depend on fightline's server for boss metadata. Self-contained is
   more faithful to why this pattern is worth using at all — if opening a shared fight still
   requires fightline's server to be up, most of the resilience benefit of Nostr disappears.

## Concrete porting checklist

- [ ] Add `nostr-tools` + `localforage` to `ClientApp/package.json`.
- [ ] Port `nostr.ts` near-verbatim into `services/nostr/nostr.service.ts` — pick a relay list
      (reuse XIVPlan's five, or pick independently; see
      [03-relay-pool-and-consensus.md](03-relay-pool-and-consensus.md)), pick fresh event kinds
      (see below — **do not reuse 30078/30079**), and swap `sceneToJson`/`jsonToScene` calls for
      fightline's own `IFight` (de)serialization.
- [ ] Decide chunking/compression need up front based on real `IFight` payload sizes (see above).
- [ ] Wrap the pub-sub status stores (`subscribeRelayStatus`, `subscribeFetchStatus`,
      `subscribeConsensusProgress`, `subscribePublishProgress`) in Angular services exposing
      `Observable`s, one per store, following whatever DI/service convention the rest of
      `services/` uses.
- [ ] Build a status-indicator component (ring/dot + tooltip breakdown) equivalent to
      `CircularRelayIndicator`, styled with `ng-zorro-antd` primitives instead of Fluent UI.
- [ ] Add a "Publish to Nostr" / "Share (portable link)" action — likely a new tab/section inside
      whatever save/share dialog fightline already has, alongside the existing server-backed save,
      not replacing it.
- [ ] Add a route (or extend an existing share-link route) that recognizes the `#/nostr/...`
      hash format and resolves it via a fetch call in an Angular resolver or the page component's
      `ngOnInit`, matching [07-sharing-and-urls.md](07-sharing-and-urls.md).
- [ ] Port the key-management UI (export/import/generate, see
      [02-key-management.md](02-key-management.md)) — decide whether this key is purely local
      (XIVPlan's model) or whether it should be associated with the fightline user account
      server-side (fightline already has `UserService`/`authentication/` — you could store the
      exported hex key as an encrypted user preference so it survives a browser reset, which
      XIVPlan's users don't get today). This is a genuine design choice fightline gets to make
      that XIVPlan doesn't have the infrastructure for.
- [ ] Decide on read-repair and vault-caching (docs 05–06) as later hardening, not launch
      blockers — a first version can fetch without repair and skip the localStorage vault-cache
      mirror entirely, listing directly from relays every time.

## Event kinds: pick your own, don't reuse XIVPlan's

`PLAN_KIND = 30078` / `PLAN_DATA_KIND = 30079` are arbitrary choices within Nostr's addressable
event range (30000–39999) — they're a real risk of **cross-app collision** if reused verbatim,
since any relay query by kind+pubkey+d-tag would then mix XIVPlan plans and fightline fights
published under a key used for both apps (unlikely today since keys are per-browser-per-app, but
not a risk worth taking). Pick two fresh kind numbers for fightline (e.g. `31500`/`31501`, or
whatever isn't already claimed by a NIP you care about — check the
[NIP-72/NIP-33 assigned-kinds table](https://github.com/nostr-protocol/nips) if you want to be
extra careful) and use those consistently.

## What to skip entirely

- **NIP-07 browser-extension signing.** Neither app needs it; a locally-generated key is simpler
  and matches fightline's own account model more naturally (see the key-management design choice
  above).
- **Relay-list discovery (NIP-65).** A hardcoded relay list is fine at this scale; don't add
  dynamic relay discovery unless real usage demands it.
- **Replicating both of XIVPlan's near-duplicate publish-dialog implementations**
  (`SaveNostr`/`ShareDialogButton`'s `NostrTab`) — that duplication in XIVPlan is incidental, not
  a pattern. Build one publish/share surface in fightline.

## Testing against real relays during development

`services/fight/fight.service-mock.ts`'s pattern (a mock implementation swapped in for local dev)
is worth mirroring for Nostr too, but real relay behavior (size limits, occasional flakiness,
actual consensus timing) is exactly the part that's hardest to fake convincingly — plan to do at
least some manual testing against the real relay list before shipping, particularly around
chunking if fightline fights turn out to be large.
