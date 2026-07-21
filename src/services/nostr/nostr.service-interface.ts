import { Observable } from "rxjs";
import { NostrDocInfo, NostrDocSource, NostrDocType } from "./nostr-engine";

export interface INostrFetchResult {
  content: string;
  name: string;
  visibility: "public" | "private";
  publishedAt: Date;
  agreeingRelays: number;
  totalRelays: number;
}

export interface INostrListResult {
  plans: NostrDocInfo[];
  hasMore: boolean;
}

export interface INostrService {
  getPubkey(): Observable<string>;
  hasStoredKey(): Observable<boolean>;
  generateNewKey(): Observable<void>;
  importSecretKey(text: string): Observable<void>;
  exportSecretKeyBlob(): Observable<Blob>;

  publishFight(
    content: string,
    name: string,
    visibility: "public" | "private",
    id?: string
  ): Observable<NostrDocSource>;
  fetchFight(pubkey: string, id: string): Observable<INostrFetchResult>;
  renameFight(id: string, newName: string, newVisibility: "public" | "private"): Observable<NostrDocInfo>;
  deleteFight(id: string): Observable<void>;
  listMyFights(opts?: { until?: number }): Observable<INostrListResult>;

  publishBoss(
    content: string,
    name: string,
    visibility: "public" | "private",
    id?: string
  ): Observable<NostrDocSource>;
  fetchBoss(pubkey: string, id: string): Observable<INostrFetchResult>;
  renameBoss(id: string, newName: string, newVisibility: "public" | "private"): Observable<NostrDocInfo>;
  deleteBoss(id: string): Observable<void>;
  listMyBosses(opts?: { until?: number }): Observable<INostrListResult>;

  getShareUrl(docType: NostrDocType, pubkey: string, id: string): string;
  getRoutePath(docType: NostrDocType, pubkey: string, id: string): string;
  getFightShareUrl(pubkey: string, id: string, viewmode?: string): string;
  getFightRoutePath(pubkey: string, id: string, viewmode?: string): string;
  decodeUrlSegments(pubToken: string, idToken: string): { pubkey: string; id: string } | undefined;
  parsePubkeyInput(input: string): string;
}
