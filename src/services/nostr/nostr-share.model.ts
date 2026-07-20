import { NostrDocSource, NostrDocType } from "./nostr-engine";

/** Describes a fight that was opened from (or just published to) Nostr — the fightline
 *  equivalent of XIVPlan's `NostrFileSource`. Attach to whatever in-memory "how was this document
 *  loaded" state fightline already tracks for a fight, alongside the server-backed equivalent. */
export interface NostrFightSource extends NostrDocSource {
  docType: "fight";
}

/** Same shape, for a personal boss-variant template. */
export interface NostrBossSource extends NostrDocSource {
  docType: "boss";
}

export function toNostrFightSource(source: NostrDocSource): NostrFightSource {
  return { ...source, docType: "fight" };
}

export function toNostrBossSource(source: NostrDocSource): NostrBossSource {
  return { ...source, docType: "boss" };
}

export type { NostrDocType };
