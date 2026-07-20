import { Inject, Injectable } from "@angular/core";
import localforage from "localforage";
import { from, Observable } from "rxjs";
import { IBoss, IFight, IBossSearchEntry, ICommandEntry } from "../../core/Models";
import { IFightService } from "./fight.service-interface";
import * as Gameserviceprovider from "../game.service-provider";
import * as Gameserviceinterface from "../game.service-interface";

interface StoredCommand {
  id: number;
  userName: string;
  fight: string;
  data: string;
  timeStamp: number;
}

const fightsStore = localforage.createInstance({ name: "FightLine", storeName: "fights" });
const bossesStore = localforage.createInstance({ name: "FightLine", storeName: "bosses" });
const commandsStore = localforage.createInstance({ name: "FightLine", storeName: "commands" });

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Local-first draft storage for fights and boss templates — replaces the old server-backed
 * FightsService (HTTP against the now-deleted ASP.NET Core backend). "New fight", FFLogs import,
 * and the "Load" dialog all operate on drafts stored in IndexedDB (via localforage), never
 * touching the network — the same role the old server played for unpublished work-in-progress,
 * just local instead of server-side. Publishing a fight/boss to Nostr (see services/nostr/) is
 * the separate, explicit action that actually makes something shareable; this service never
 * publishes anything on its own.
 *
 * Command-log replay (addCommand/getCommands) is kept for the same reason it existed
 * server-side: reopening a draft later reconstructs it from its full edit history, not just a
 * last-saved snapshot. This has nothing to do with the removed SignalR live-collab — it's local
 * persistence of one browser's own edit history.
 */
@Injectable()
export class FightsService implements IFightService {
  constructor(
    @Inject(Gameserviceprovider.gameServiceToken) private gameService: Gameserviceinterface.IGameService
  ) {}

  getBosses(reference: number, searchString: string, _privateOnly: boolean): Observable<IBossSearchEntry[]> {
    return from(
      bossesStore.keys().then(async (keys) => {
        const bosses = await Promise.all(keys.map((k) => bossesStore.getItem<IBoss>(k)));
        const search = (searchString || "").toLowerCase();
        return bosses
          .filter((b): b is IBoss => !!b && b.ref === reference)
          .filter((b) => !search || b.name.toLowerCase().includes(search))
          .map((b) => ({ id: b.id, name: b.name, canRemove: true } as IBossSearchEntry));
      })
    );
  }

  getBoss(id: string): Observable<IBoss> {
    return from(bossesStore.getItem<IBoss>(id));
  }

  removeBosses(ids: string[]): Observable<any> {
    return from(Promise.all(ids.map((id) => bossesStore.removeItem(id))));
  }

  saveBoss(boss: IBoss): Observable<IBoss> {
    const toSave: IBoss = { ...boss, id: boss.id || randomId() };
    return from(bossesStore.setItem(toSave.id, toSave).then(() => toSave));
  }

  getFight(id: string): Observable<IFight> {
    return from(fightsStore.getItem<IFight>(id));
  }

  saveFight(fight: IFight): Observable<IFight> {
    const now = new Date();
    const toSave: IFight = {
      ...fight,
      id: fight.id || randomId(),
      isDraft: false,
      dateModified: now,
      dateCreated: fight.dateCreated || now,
    };
    return from(fightsStore.setItem(toSave.id, toSave).then(() => toSave));
  }

  getFightsForUser(): Observable<IFight[]> {
    return from(
      fightsStore.keys().then(async (keys) => {
        const fights = await Promise.all(keys.map((k) => fightsStore.getItem<IFight>(k)));
        return fights
          .filter((f): f is IFight => !!f)
          .sort((a, b) => new Date(b.dateModified).getTime() - new Date(a.dateModified).getTime());
      })
    );
  }

  removeFights(ids: string[]): Observable<any> {
    return from(Promise.all(ids.map((id) => fightsStore.removeItem(id).then(() => commandsStore.removeItem(id)))));
  }

  newFight(fraction: string = ""): Observable<IFight> {
    const now = new Date();
    const fight: IFight = {
      id: randomId(),
      name: "new",
      userName: "",
      data: "",
      isDraft: true,
      dateCreated: now,
      dateModified: now,
      game: fraction ? `${this.gameService.name}:${fraction}` : this.gameService.name,
    };
    return from(fightsStore.setItem(fight.id, fight).then(() => fight));
  }

  addCommand(fight: string, data: any): Observable<{ id: number }> {
    const entry: StoredCommand = {
      id: Date.now(),
      userName: "",
      fight,
      data: typeof data === "string" ? data : JSON.stringify(data),
      timeStamp: Date.now(),
    };
    return from(
      commandsStore
        .getItem<StoredCommand[]>(fight)
        .then((existing) => commandsStore.setItem(fight, [...(existing ?? []), entry]))
        .then(() => ({ id: entry.id }))
    );
  }

  getCommands(fight: string, timestamp: number): Observable<ICommandEntry[]> {
    return from(
      commandsStore.getItem<StoredCommand[]>(fight).then((entries) =>
        (entries ?? [])
          .filter((c) => !timestamp || c.timeStamp > timestamp)
          .sort((a, b) => a.timeStamp - b.timeStamp)
          .map((c) => ({ userName: c.userName, fight: c.fight, data: c.data, timeStamp: new Date(c.timeStamp) }))
      )
    );
  }

  getCommand(_id: number): Observable<any> {
    return from(Promise.resolve(null));
  }
}
