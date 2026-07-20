import { Injectable } from "@angular/core";
import { from, Observable } from "rxjs";
import { map } from "rxjs/operators";
import {
  createDocumentStore,
  getNostrPubkey,
  hasStoredKey,
  generateNewKey,
  importSecretKey,
  exportSecretKeyBlob,
  getNostrShareUrl,
  getNostrRoutePath,
  decodeNostrUrlSegments,
  parseInputPubkey,
  NostrDocInfo,
  NostrDocSource,
  NostrDocType,
} from "./nostr-engine";
import { INostrFetchResult, INostrListResult, INostrService } from "./nostr.service-interface";

// Fresh kind pairs per nostr/09-porting-guide.md — do not reuse XIVPlan's 30078/30079, and keep
// fights/boss-variants on separate pairs so vault-listing queries stay a plain
// `kinds:[X], authors:[pubkey]` filter with no client-side type discrimination needed.
const FIGHT_INDEX_KIND = 31500;
const FIGHT_DATA_KIND = 31501;
const BOSS_INDEX_KIND = 31510;
const BOSS_DATA_KIND = 31511;

const fightStore = createDocumentStore(FIGHT_INDEX_KIND, FIGHT_DATA_KIND, "fight");
const bossStore = createDocumentStore(BOSS_INDEX_KIND, BOSS_DATA_KIND, "boss");

function toFetchResult(r: {
  content: string;
  name: string;
  visibility: "public" | "private";
  agreeingRelays: number;
  totalRelays: number;
}): INostrFetchResult {
  return r;
}

function toListResult(r: { plans: NostrDocInfo[]; hasMore: boolean }): INostrListResult {
  return { plans: r.plans, hasMore: r.hasMore };
}

@Injectable()
export class NostrService implements INostrService {
  getPubkey(): Observable<string> {
    return from(getNostrPubkey());
  }

  hasStoredKey(): Observable<boolean> {
    return from(hasStoredKey());
  }

  generateNewKey(): Observable<void> {
    return from(generateNewKey());
  }

  importSecretKey(text: string): Observable<void> {
    return from(importSecretKey(text));
  }

  exportSecretKeyBlob(): Observable<Blob> {
    return from(exportSecretKeyBlob());
  }

  publishFight(content: string, name: string, visibility: "public" | "private", id?: string): Observable<NostrDocSource> {
    return from(fightStore.publish(content, name, visibility, id));
  }

  fetchFight(pubkey: string, id: string): Observable<INostrFetchResult> {
    return from(fightStore.fetch(pubkey, id)).pipe(map(toFetchResult));
  }

  renameFight(id: string, newName: string, newVisibility: "public" | "private"): Observable<NostrDocInfo> {
    return from(fightStore.rename(id, newName, newVisibility));
  }

  deleteFight(id: string): Observable<void> {
    return from(fightStore.delete(id));
  }

  listMyFights(opts?: { until?: number }): Observable<INostrListResult> {
    return from(fightStore.listOwn(opts)).pipe(map(toListResult));
  }

  publishBoss(content: string, name: string, visibility: "public" | "private", id?: string): Observable<NostrDocSource> {
    return from(bossStore.publish(content, name, visibility, id));
  }

  fetchBoss(pubkey: string, id: string): Observable<INostrFetchResult> {
    return from(bossStore.fetch(pubkey, id)).pipe(map(toFetchResult));
  }

  renameBoss(id: string, newName: string, newVisibility: "public" | "private"): Observable<NostrDocInfo> {
    return from(bossStore.rename(id, newName, newVisibility));
  }

  deleteBoss(id: string): Observable<void> {
    return from(bossStore.delete(id));
  }

  listMyBosses(opts?: { until?: number }): Observable<INostrListResult> {
    return from(bossStore.listOwn(opts)).pipe(map(toListResult));
  }

  getShareUrl(docType: NostrDocType, pubkey: string, id: string): string {
    return getNostrShareUrl(docType, pubkey, id);
  }

  getRoutePath(docType: NostrDocType, pubkey: string, id: string): string {
    return getNostrRoutePath(docType, pubkey, id);
  }

  decodeUrlSegments(pubToken: string, idToken: string): { pubkey: string; id: string } | undefined {
    return decodeNostrUrlSegments(pubToken, idToken);
  }

  parsePubkeyInput(input: string): string {
    return parseInputPubkey(input);
  }
}
