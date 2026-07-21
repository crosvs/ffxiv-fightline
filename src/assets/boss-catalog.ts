/**
 * Maintainer-curated boss encounter templates, bundled into the static app bundle at build time.
 *
 * This replaces the old server-backed public "Boss templates" catalog (any authenticated user
 * could publish a template searchable by everyone) — per the migration plan, that's retired along
 * with the rest of the backend. What ships here is deliberately curated by whoever maintains this
 * repo, added via a normal pull request/commit, not published at runtime by end users. A user's
 * own custom boss variants are saved to their personal Nostr vault instead (see
 * bossTemplatesDialog.component.ts / nostr.service.ts's publishBoss), share-by-link only — not
 * merged into this catalog.
 *
 * `ref` is the FFLogs encounter id (matches `Encounter.id` from core/FFLogs.ts). `data` is the
 * same JSON shape `IBoss.data` already uses (`{ attacks: IBossAbilityUsageData[], downTimes: [...] }`
 * from SerializeController.serializeBoss()) — copy it verbatim out of an exported/saved boss.
 */
export interface CuratedBossEntry {
  id: string;
  name: string;
  ref: number;
  game: string;
  data: string;
}

// Empty by design — this is the scaffold for maintainers to populate over time (fill in via a PR
// once a curated timeline for an encounter is ready), not a stand-in with placeholder content.
export const CURATED_BOSSES: CuratedBossEntry[] = [];
