import { Injectable } from "@angular/core";
import { Observable } from "rxjs";
import {
  ConsensusProgress,
  RelayHealth,
  getConsensusProgress,
  getFetchStatus,
  getPublishProgress,
  getRelayStatus,
  subscribeConsensusProgress,
  subscribeFetchStatus,
  subscribePublishProgress,
  subscribeRelayStatus,
} from "./nostr-engine";

export interface RelayStatusEntry {
  url: string;
  status: RelayHealth;
}

/** Wraps nostr-engine's plain subscribe/get pub-sub stores as RxJS observables, following the
 *  translation pattern from nostr/09-porting-guide.md — each store already notifies synchronously
 *  on change, `startWith` just gives a late subscriber today's value immediately. */
function toObservable<T>(subscribe: (fn: () => void) => () => void, get: () => T): Observable<T> {
  return new Observable<T>((subscriber) => {
    subscriber.next(get());
    return subscribe(() => subscriber.next(get()));
  });
}

@Injectable()
export class NostrStatusService {
  /** General relay connectivity, independent of any specific in-flight operation. */
  relayStatus$: Observable<RelayStatusEntry[]> = toObservable(subscribeRelayStatus, getRelayStatus);

  /** Per-relay status for whichever fetch is currently in flight (if any). */
  fetchStatus$: Observable<RelayStatusEntry[]> = toObservable(subscribeFetchStatus, getFetchStatus);

  /** "N/M relays agree" progress for the current fetch. */
  consensusProgress$: Observable<ConsensusProgress> = toObservable(subscribeConsensusProgress, getConsensusProgress);

  /** "N/M relays confirmed" progress for the current publish. */
  publishProgress$: Observable<ConsensusProgress> = toObservable(subscribePublishProgress, getPublishProgress);
}
