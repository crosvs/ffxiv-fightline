import { Observable } from "rxjs";
import { switchMap } from "rxjs/operators";
import { IFight } from "../../core/Models";
import { IFightService } from "./fight.service-interface";
import { INostrService } from "../nostr/nostr.service-interface";
import { randomDocId } from "../nostr/nostr-engine";

/**
 * Saves a fight locally, and — when `fight.nostrShareEnabled` is set — also (re)publishes it to
 * Nostr first, updating `fight.nostr` to the real published link before the local save runs.
 * Shared between the full Save dialog and the toolbar's one-click quick-save so the two surfaces
 * can never drift on what pressing "save" actually does for a given fight.
 */
export function saveFightAndMaybePublish(
  fight: IFight,
  fightService: IFightService,
  nostrService: INostrService,
  currentPubkey: string
): Observable<IFight> {
  if (!fight.nostrShareEnabled) {
    return fightService.saveFight(fight);
  }

  // A link's d-tag only means something under the pubkey that minted it — if there's no link
  // yet, or the currently active key differs from the one that owns the existing link, reserve a
  // fresh id under the current key rather than trying to republish into someone else's namespace.
  if (!fight.nostr || fight.nostr.pubkey !== currentPubkey) {
    fight.nostr = {
      pubkey: currentPubkey,
      id: randomDocId(),
      visibility: fight.nostr?.visibility ?? "public",
    };
  }
  const visibility = fight.nostr.visibility;

  return nostrService.publishFight(fight.data, fight.name, visibility, fight.nostr.id).pipe(
    switchMap((source) => {
      fight.nostr = { pubkey: source.pubkey, id: source.id, visibility };
      return fightService.saveFight(fight);
    })
  );
}
