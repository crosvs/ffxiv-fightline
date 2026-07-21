# FFXIV FightLine

A timeline-based tool for planning and analyzing party cooldowns and buffs for Final Fantasy XIV
raid encounters — lay out job abilities, mitigations, and boss attacks on a shared timeline, import
real pull data from FFLogs, and share a plan with a portable link.

This is a fully static, serverless app. There is no backend, no account system, and no database —
persistence works like this:

- **Drafts are local.** Creating a new fight, importing from FFLogs, and the "Load" dialog all work
  entirely in your browser (IndexedDB), whether or not you ever share anything.
- **Sharing is [Nostr](https://nostr.com/).** Publishing a fight or boss template signs it with a
  locally-generated keypair and broadcasts it to a handful of public relays. Opening a shared link
  reads it back from those same relays — no fightline-owned server is ever involved. See
  [`nostr/`](nostr/) for the full design.
- **Your key is your identity.** There's no login. The toolbar's identity menu lets you export your
  key (back it up — it's the only way to keep access to anything you've published), import one on
  another device, or generate a new one.

## Development

Requires Node.js (no .NET, no database, no other prerequisites).

```bash
npm install
npm start          # dev server at http://localhost:4200
npm run build      # production build to dist/browser
```

To pull real fight data from [FFLogs](https://www.fflogs.com/), add your own personal FFLogs API
key in the in-app settings dialog (FFLogs tab) — this talks to FFLogs' API directly from your
browser, nothing proxies through this project.

## Deployment

Pushing to `master` builds and deploys to GitHub Pages automatically
(`.github/workflows/deploy-pages.yml`), publishing to the custom domain
[timeline.xivoid.app](https://timeline.xivoid.app/) (the workflow writes the `CNAME` file into the
build output on every deploy). If you fork this and deploy under the repo's default Pages subpath
instead, add `--base-href /<repo-name>/` back to the build step and drop the `CNAME` step.

## Project layout

- `src/core/` — the timing/ability engine: attack processors, FFLogs import/parsing, export
  templates. Framework-agnostic TypeScript.
- `src/services/nostr/` — the Nostr protocol layer (ported from
  [XIVPlan](https://github.com/xivplan/xivplan)'s `nostr.ts`) and its Angular service wrapper.
- `src/services/fight/` — local draft persistence (IndexedDB), following the same
  interface/provider pattern as every other service in `src/services/`.
- `nostr/` — design docs for the Nostr integration: architecture, key management, relay consensus,
  publishing/chunking, fetching/repair, vault listing, sharing URLs, and a porting guide.
