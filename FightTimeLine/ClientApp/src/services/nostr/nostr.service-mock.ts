import { Injectable } from "@angular/core";
import { Observable, of } from "rxjs";
import { NostrDocInfo, NostrDocSource, NostrDocType } from "./nostr-engine";
import { INostrFetchResult, INostrListResult, INostrService } from "./nostr.service-interface";

const MOCK_PUBKEY = "0".repeat(64);

interface MockEntry {
  id: string;
  name: string;
  content: string;
  visibility: "public" | "private";
  publishedAt: string;
}

/** Local-only stand-in for real relay traffic — keeps dev/testing working without hitting real
 *  Nostr relays, mirroring fight.service-mock.ts's role for the server-backed service. */
@Injectable()
export class NostrMockService implements INostrService {
  private read(namespace: string): MockEntry[] {
    const raw = localStorage.getItem(`nostr_mock_${namespace}`);
    return raw ? JSON.parse(raw) : [];
  }

  private write(namespace: string, entries: MockEntry[]): void {
    localStorage.setItem(`nostr_mock_${namespace}`, JSON.stringify(entries));
  }

  private publish(namespace: string, content: string, name: string, visibility: "public" | "private", id?: string): NostrDocSource {
    const entries = this.read(namespace);
    const docId = id ?? Math.random().toString(16).slice(2, 18);
    const filtered = entries.filter((e) => e.id !== docId);
    filtered.unshift({ id: docId, name, content, visibility, publishedAt: new Date().toISOString() });
    this.write(namespace, filtered);
    return { id: docId, name, pubkey: MOCK_PUBKEY, visibility };
  }

  private fetch(namespace: string, id: string): INostrFetchResult {
    const entry = this.read(namespace).find((e) => e.id === id);
    if (!entry) throw new Error("Not found in mock vault.");
    return { content: entry.content, name: entry.name, visibility: entry.visibility, agreeingRelays: 5, totalRelays: 5 };
  }

  private rename(namespace: string, id: string, newName: string, newVisibility: "public" | "private"): NostrDocInfo {
    const entries = this.read(namespace);
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error("Not found in mock vault.");
    entry.name = newName;
    entry.visibility = newVisibility;
    this.write(namespace, entries);
    return { id, name: newName, publishedAt: new Date(entry.publishedAt), visibility: newVisibility };
  }

  private remove(namespace: string, id: string): void {
    this.write(namespace, this.read(namespace).filter((e) => e.id !== id));
  }

  private list(namespace: string): INostrListResult {
    const plans: NostrDocInfo[] = this.read(namespace).map((e) => ({
      id: e.id,
      name: e.name,
      publishedAt: new Date(e.publishedAt),
      visibility: e.visibility,
    }));
    return { plans, hasMore: false };
  }

  getPubkey(): Observable<string> {
    return of(MOCK_PUBKEY);
  }

  hasStoredKey(): Observable<boolean> {
    return of(true);
  }

  generateNewKey(): Observable<void> {
    return of(undefined);
  }

  importSecretKey(_text: string): Observable<void> {
    return of(undefined);
  }

  exportSecretKeyBlob(): Observable<Blob> {
    return of(new Blob(["0".repeat(64)], { type: "text/plain" }));
  }

  publishFight(content: string, name: string, visibility: "public" | "private", id?: string): Observable<NostrDocSource> {
    return of(this.publish("fight", content, name, visibility, id));
  }

  fetchFight(_pubkey: string, id: string): Observable<INostrFetchResult> {
    return of(this.fetch("fight", id));
  }

  renameFight(id: string, newName: string, newVisibility: "public" | "private"): Observable<NostrDocInfo> {
    return of(this.rename("fight", id, newName, newVisibility));
  }

  deleteFight(id: string): Observable<void> {
    this.remove("fight", id);
    return of(undefined);
  }

  listMyFights(): Observable<INostrListResult> {
    return of(this.list("fight"));
  }

  publishBoss(content: string, name: string, visibility: "public" | "private", id?: string): Observable<NostrDocSource> {
    return of(this.publish("boss", content, name, visibility, id));
  }

  fetchBoss(_pubkey: string, id: string): Observable<INostrFetchResult> {
    return of(this.fetch("boss", id));
  }

  renameBoss(id: string, newName: string, newVisibility: "public" | "private"): Observable<NostrDocInfo> {
    return of(this.rename("boss", id, newName, newVisibility));
  }

  deleteBoss(id: string): Observable<void> {
    this.remove("boss", id);
    return of(undefined);
  }

  listMyBosses(): Observable<INostrListResult> {
    return of(this.list("boss"));
  }

  getShareUrl(docType: NostrDocType, pubkey: string, id: string): string {
    return `${location.protocol}//${location.host}${location.pathname}#/nostr/${docType}/mock-${pubkey}/${id}`;
  }

  decodeUrlSegments(_pubToken: string, idToken: string): { pubkey: string; id: string } | undefined {
    return { pubkey: MOCK_PUBKEY, id: idToken };
  }

  parsePubkeyInput(input: string): string {
    return input;
  }
}
