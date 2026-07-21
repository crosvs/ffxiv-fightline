import {
  Component,
  OnInit,
  OnDestroy,
  ViewChild,
  HostListener,
  Inject,
} from "@angular/core";
import { Location } from "@angular/common";
import { catchError, of } from "rxjs";
import {
  ActivatedRoute,
  ActivatedRouteSnapshot,
  Router,
} from "@angular/router";
import * as _ from "lodash";
import { FightTimeLineController } from "../../core/FightTimeLineController";
import * as M from "../../core/Models";
import * as FF from "../../core/FFLogs";
import { NgProgressbar } from "ngx-progressbar";
import { process } from "../../core/BossAttackProcessors";
import { SidepanelComponent } from "../../components/sidepanel/sidepanel.component";
import {
  PlanAreaComponent,
  Action,
  EventSource,
} from "./planArea/planArea.component";
import {
  ToolsManager,
  CopyPasteTool,
  DowntimeTool,
} from "../../core/ToolsManager";
import { PresenterManager } from "../../core/PresentationManager";

import { IdGenerator } from "../../core/Generators";
import { ICommandData } from "../../core/UndoRedo";
import * as Gameserviceprovider from "../../services/game.service-provider";
import * as GameServiceInterface from "../../services/game.service-interface";
import * as SerializeController from "../../core/SerializeController";
import { saveFightAndMaybePublish } from "../../services/fight/fightSave.helper";
import { VisStorageService } from "src/services/VisStorageService";
import {
  ActivitySource,
  RecentActivityService,
} from "src/services/RecentActivitiesService";
import {
  DispatcherPayloads,
  DispatcherService,
} from "src/services/dispatcher.service";
import {
  fightServiceToken,
  IFightService,
  ScreenNotificationsService,
  DialogService,
  SettingsService,
  LocalStorageService,
  INostrService,
  nostrServiceToken,
} from "src/services";
import { getTimeGoodAbilityToUse } from "src/core/Defensives/functions";
import { ChangeBossAttackCommand } from "src/core/commands/ChangeBossAttackCommand";
import { visibleFrameTemplate } from "src/core/Frame";

@Component({
  selector: "fightline",
  templateUrl: "./fightline.component.html",
  styleUrls: ["./fightline.component.css"],
})
export class FightLineComponent implements OnInit, OnDestroy {
  fightId: string;
  fflogsCode: string = null;
  // Tracks whether the currently loaded fight actually has an IndexedDB record backing it —
  // true for anything opened from a local draft (or a Nostr load that turned out to resolve to
  // one via the staleness challenge) or that's been through Save/Publish this session; false
  // for a blank new fight, an FFLogs/boss-template import, or a fresh Nostr load with no local
  // counterpart. Drives the tab-close warning below: those cases have nowhere else for edits to
  // go, so closing the tab would silently lose them.
  persistedLocally = false;
  // Drives the toolbar's one-click save button — see quickSaveFight()/quickSaveLabel below.
  quickSaveState: "idle" | "saving" | "done" = "idle";

  @ViewChild("sidepanel", { static: true })
  sidepanel: SidepanelComponent;
  @ViewChild("progressBar", { static: true })
  progressBar: NgProgressbar;
  @ViewChild("planArea", { static: true })
  planArea: PlanAreaComponent;

  fightLineController: FightTimeLineController;
  subs: any[] = [];

  private idgen = new IdGenerator();
  toolsManager = new ToolsManager();
  private presenterManager: PresenterManager;
  jobs = this.gameService.jobRegistry.getJobs();
  private worker: Worker;

  public constructor(
    private recent: RecentActivityService,
    @Inject(fightServiceToken) private fightService: IFightService,
    @Inject(Gameserviceprovider.gameServiceToken)
    public gameService: GameServiceInterface.IGameService,
    @Inject("DispatcherPayloads")
    private dispatcher: DispatcherService<DispatcherPayloads>,
    private notification: ScreenNotificationsService,
    private visStorage: VisStorageService,
    private route: ActivatedRoute,
    private location: Location,
    private router: Router,
    private dialogService: DialogService,
    private settingsService: SettingsService,
    private storage: LocalStorageService,
    @Inject(nostrServiceToken) private nostrService: INostrService
  ) {
    this.presenterManager = visStorage.presenter;

    if (typeof Worker !== "undefined") {
      // Create a new
      this.worker = new Worker(
        new URL("../../app/warnings.worker", import.meta.url)
      );
      this.worker.onmessage = ({ data }) => {
        this.visStorage.holders.warnings = data.warnings;
      };
      this.processWarnings();
    } else {
      // Web workers are not supported in this environment.
      // You should add a fallback so that your program still executes correctly.
    }
  }

  processWarnings() {
    if (this.worker) {
      this.worker.postMessage({});
    }
  }

  onAction(event: Action) {
    if (this.toolsManager.handleAction(event)) {
      return;
    }

    const actionName = "on" + event.name[0].toUpperCase() + event.name.slice(1);
    if (this[actionName]) {
      this[actionName](event.source, event.payload);
    }
  }

  isWarningsVisible() {
    // return true;
    return Boolean(this.visStorage.holders.warnings.length);
  }

  onSelected(source: EventSource, event) {
    this.setSidePanel(event.data);
  }

  showWarnings() {
    this.setSidePanel("warnings");
  }

  onClickGroup(source: EventSource, event) {
    if (source === "player") {
      this.planArea.clearSelection();
      this.setSidePanel(event);
    }
  }

  useTool(t) {
    this.toolsManager.setActive(t);
  }

  onClickEmpty(source: EventSource, event) {
    const downtimesAtTime = this.fightLineController.getDowntimesAtTime(
      event.time
    );
    if (
      downtimesAtTime.length > 0 &&
      (source === "boss" ||
        (source === "player" &&
          this.presenterManager.view.showDowntimesInPartyArea))
    ) {
      event.items = downtimesAtTime.map((d) => d.id);
      this.planArea.clearSelection();

      this.setSidePanel(event);
    } else {
      this.planArea.updateSelection(source, event);
    }
  }

  onDoubleClickEmpty(source: EventSource, event) {
    this.fightLineController.notifyDoubleClick(
      event.item,
      event.group,
      new Date(event.time)
    );
  }

  onDoubleClickItem(source: EventSource, event) {
    this.fightLineController.notifyDoubleClick(
      event.item,
      event.group,
      new Date(event.time)
    );
  }

  onDoubleClickGroup(source: EventSource, event) {
    if (source === "player") {
      if (!this.fightLineController.isJobGroup(event.group)) {
        this.fightLineController.toggleCompactViewAbility(event.group);
        this.presenterManager.save(this.fightId);
      } else {
        this.fightLineController.toggleJobCollapsed(event.group);
        this.presenterManager.save(this.fightId);
      }
      setTimeout(() => this.planArea.refresh());
    }
  }

  onGroupOrderSwap(source: EventSource, event) {
    if (source === "player") {
      const from = event.from;
      const to = event.to;
      const fromJob = this.visStorage.holders.jobs.get(from.id);
      if (fromJob) {
        const toJob = this.visStorage.holders.jobs.get(to.id);
        if (toJob) {
          const ind = fromJob.index;
          fromJob.index = toJob.index;
          toJob.index = ind;

          event.handler(true);
          const fromAbs = this.visStorage.holders.abilities.getByParentId(
            fromJob.id
          );
          fromAbs.forEach((ab) => {
            ab.applyData({});
          });
          const toAbs = this.visStorage.holders.abilities.getByParentId(
            toJob.id
          );
          toAbs.forEach((ab) => {
            ab.applyData({});
          });

          this.visStorage.holders.abilities.update([...fromAbs, ...toAbs]);
        }
      } else {
        const abFrom = this.visStorage.holders.abilities.get(from.id);
        const abTo = this.visStorage.holders.abilities.get(to.id);
        if (abTo && abFrom && abTo.job.id === abFrom.job.id) {
          const ind = abFrom.index;
          abFrom.index = abTo.index;
          abTo.index = ind;
          const jf = this.presenterManager.jobFilter(abTo.job.id);
          jf.abilityOrder ||= {};
          jf.abilityOrder[abTo.ability.name] =
            abTo.index - Math.trunc(abTo.index);
          jf.abilityOrder[abFrom.ability.name] =
            abFrom.index - Math.trunc(abFrom.index);
          this.presenterManager.save(this.fightId);
          event.handler(true);
        }
      }
    }
  }

  onTimeChanged(source: EventSource, event) {
    this.fightLineController.notifyTimeChanged(event.id, event.date);
    this.sidepanel.refresh();
  }

  onDelete(source: EventSource, event) {
    this.fightLineController.handleDelete(event);
  }

  onMove(source: EventSource, event) {
    this.fightLineController.notifyMove(event);
  }

  onKeyMove(source: EventSource, event) {
    this.fightLineController.moveSelection(event.delta, event.selection);
  }

  onVisibleFrameTemplate(source: EventSource, event) {
    if (source === "player") {
      const html = visibleFrameTemplate(
        this.idgen,
        this.visStorage.holders,
        this.settingsService.load().colors,
        this.visStorage.presenter.view.statusesAsRows,
        this.visStorage.presenter.view.colorfulDurations,
        event.item
      );
      event.handler(html);
    }
  }

  onCanMove(source: EventSource, event) {
    const canMove = this.fightLineController.canMove(
      event.item,
      event.selection
    );
    if (canMove && source === "boss") {
      this.fightLineController.moveBossAttack(event.item);
    }
    event.handler(canMove);
  }

  onItemTooltip(source: EventSource, event) {
    event.handler(this.fightLineController.tooltipOnItemUpdateTime(event.item));
  }

  onTable(template: string) {
    // Gated on fight.nostr alone, not nostrShareEnabled (which only governs whether a future Save
    // re-publishes) — if a nostr link exists at all, that document is already reachable on relays,
    // whether it got here via a load from someone else's share link or this device's own publish.
    const fight = this.fightLineController.data.fight;
    const path =
      fight?.nostr?.pubkey && fight?.nostr?.id
        ? this.nostrService.getFightRoutePath(fight.nostr.pubkey, fight.nostr.id, template)
        : this.router.serializeUrl(
            this.router.createUrlTree(["/table", this.fightId || "dummy", template])
          );
    window.open(path, "_blank");
  }

  // private openStanceSelector(data: M.IContextMenuData[]): void {
  //   //    this.contextMenu.openStanceSelector(data);
  // }

  exportToTable() {}

  private setSidePanel(eventData) {
    this.sidepanel.setSidePanel(eventData);
  }

  updateFilter(source?: string): void {
    this.visStorage.holders.level = this.presenterManager.fightLevel;
    this.fightLineController.applyFilter(null, source);
    this.sidepanel.refresh();
    this.presenterManager.save(this.fightId);
  }

  updateView($data?: M.IView): void {
    this.fightLineController.applyView($data);
    this.presenterManager.save(this.fightId);
    setTimeout(() => this.planArea.refresh());
  }

  presetChanged(preset: string): void {
    this.fightLineController.loadPreset(preset);
    this.location.replaceState(
      this.location.path(false).split("?")[0],
      "preset=" + encodeURIComponent(preset)
    );
  }

  openBossAttackAddDialog(
    bossAbility: M.IBossAbility,
    callBack: (b: any) => void
  ): void {
    this.dialogService.openBossAttackAddDialog(
      bossAbility,
      this.presenterManager,
      callBack
    );
  }

  load(): void {
    this.dialogService.openLoad();
  }

  importFromFFLogs(code: string = null): void {
    this.dialogService
      .openImportFromFFLogs(code || this.fflogsCode)
      .then((result) => {
        if (!result) {
          return;
        }
        this.router.navigateByUrl(
          "fflogs/" + result.reportId + "/" + result.fightId
        );
      });
  }

  importBossAttacksFromFFLogs(code: string = null): void {
    this.dialogService
      .openImportFromFFLogs(code || this.fflogsCode, true)
      .then((result) => {
        if (!result) {
          return;
        }
        this.replaceBossFFLogsData(result.reportId, parseInt(result.fightId));
      });
  }

  loadFFLogsData(code: string, enc: number) {
    const stop = (ref: { close: () => void }) => {
      this.progressBar.complete();
      ref.close();
    };

    this.dialogService.executeWithLoading("Loading...", (ref) => {
      this.progressBar.start();
      this.gameService.dataService
        .getEvents(code, enc, {}, (percentage) =>
          this.progressBar.set(percentage * 100)
        )
        .then((parser) => {
          // newFight() only mints an in-memory id — the URL stays on this fflogs/... route (not
          // rewritten to a local draft id) until the user explicitly saves, so re-opening this
          // exact FFLogs pull always re-imports fresh rather than depending on a draft that may
          // never get saved. The recent-activity entry points at the same stable route for the
          // same reason — it re-runs this import on click, it doesn't resume an in-memory draft.
          this.fightService.newFight("").subscribe(
            (value) => {
              this.fightId = value.id;
              this.persistedLocally = false;
              this.recent.register({
                name: parser.fight.name,
                boss: parser.fight.boss,
                source: ActivitySource.FFLogs,
                timestamp: new Date(),
                url: `/fflogs/${code}/${enc}`,
                id: value.id.toLowerCase(),
              });
              const settings = this.settingsService.load();

              try {
                this.presenterManager.setSettings(settings);
                this.fightLineController.importFromFFLogs(
                  code + ":" + enc,
                  parser
                );
                this.planArea.setInitialWindow(
                  this.fightLineController.getLatestAbilityUsageTime(),
                  2
                );
                this.planArea.refresh();
              } catch (error) {
                this.notification.error(
                  "We are unable to load this fight. Dev team is already informed about this case"
                );
              }
              stop(ref);
            },
            (error) => {
              console.log(error);
              stop(ref);
              this.notification.error("Unable to start");
            }
          );
        })
        .catch((error) => {
          console.error(error);
          this.notification.showUnableToImport();
          stop(ref);
        });
    });
  }

  replaceBossFFLogsData(code: string, enc: number) {
    const stop = (ref: { close: () => void }) => {
      this.progressBar.complete();
      ref.close();
    };

    this.dialogService.executeWithLoading("Importing...", (ref) => {
      this.progressBar.start();
      this.gameService.dataService
        .getEvents(code, enc, { bossAttacksOnly: true }, (percentage) =>
          this.progressBar.set(percentage * 100)
        )
        .then((parser) => {
          try {
            this.fightLineController.importAttacksFromFFLogs(
              code + ":" + enc,
              parser
            );
            this.planArea.refresh();
          } catch (error) {
            this.notification.error(
              "We are unable to load this fight. Dev team is already informed about this case"
            );
          }
          stop(ref);
        })
        .catch((error) => {
          console.error(error);
          this.notification.showUnableToImport();
          stop(ref);
        });
    });
  }

  onNew() {
    this.router.navigateByUrl("/new");
  }

  /** Opens the full Save dialog ("Save As" in the toolbar dropdown) — name field, Nostr
   *  share toggle, live URL preview. This is the only place that can rename a fight or fork a new
   *  draft; quickSaveFight() below reuses whatever this dialog last committed. */
  saveFight(): void {
    // No auth gate here anymore: this dialog now also offers publishing to Nostr, which
    // deliberately needs no account at all — the old server-backed "Save"/"Save As New" buttons
    // inside it still individually require auth (the server itself enforces that and surfaces a
    // 401/403 through handleSaveError), but opening the dialog must not be blocked on it.
    this.dialogService
      .openSaveFight(() =>
        this.fightLineController.createSerializer().serializeFight()
      )
      .then((result) => {
        if (result !== null && result !== undefined) {
          this.onFightSaved(result);
        }
      })
      .catch((reason) => {
        console.log(reason);
        this.notification.showFightNotSaved();
      });
  }

  /** True when this fight has never actually been through Save/Publish — a blank new plan, an
   *  FFLogs/boss-template import, or a Nostr load with no local counterpart. There's no remembered
   *  name or sharing preference to reuse yet, so the toolbar's one-click button falls back to
   *  opening the full "Save As" dialog instead of silently quick-saving under a placeholder name. */
  get needsSaveAs(): boolean {
    return !this.persistedLocally;
  }

  /** Click handler for the toolbar's primary save button — routes to the full dialog for a
   *  never-saved fight (see needsSaveAs), otherwise to the one-click quickSaveFight() below. */
  onQuickSaveClick(): void {
    if (this.needsSaveAs) {
      this.saveFight();
      return;
    }
    this.quickSaveFight();
  }

  /** One-click save using this fight's remembered name and Nostr-sharing preference — no dialog.
   *  The toolbar button itself is the status indicator (see quickSaveLabel/quickSaveIcon); this
   *  and the Save dialog's own Save button both go through the same saveFightAndMaybePublish()
   *  helper so they can never disagree on what "save" actually does for a given fight. */
  quickSaveFight(): void {
    if (this.quickSaveState === "saving") {
      return;
    }
    this.quickSaveState = "saving";
    const fight = this.fightLineController.createSerializer().serializeFight();
    this.nostrService.getPubkey().subscribe((pubkey) => {
      saveFightAndMaybePublish(fight, this.fightService, this.nostrService, pubkey).subscribe({
        next: (result) => {
          this.onFightSaved(result);
          this.quickSaveState = "done";
          setTimeout(() => (this.quickSaveState = "idle"), 1500);
        },
        error: (error) => {
          console.log(error);
          this.notification.showFightNotSaved();
          this.quickSaveState = "idle";
        },
      });
    });
  }

  private onFightSaved(result: M.IFight): void {
    this.persistedLocally = true;
    this.recent.register({
      name: result.name,
      url: "/" + result.id.toLowerCase(),
      source: ActivitySource.Timeline,
      id: result.id.toLowerCase(),
    });
    this.fightLineController.updateFight(result);
    // When this fight is linked to Nostr, the address bar should show the shareable /nostr/...
    // path (so it's copy-paste ready straight from the URL bar) rather than the local draft id,
    // which only resolves on this device. The "recent activities" entry above deliberately still
    // points at the local id — that's for fast re-access from this browser, not for sharing, and
    // shouldn't pay a relay round-trip just to reopen.
    this.location.replaceState(
      result.nostr && result.nostrShareEnabled
        ? this.nostrService.getFightRoutePath(result.nostr.pubkey, result.nostr.id)
        : `/${result.id}`
    );
    this.notification.showFightSaved();
  }

  get quickSaveLabel(): string {
    if (this.needsSaveAs) {
      return "Save As";
    }
    const fight = this.fightLineController.data.fight;
    const shareEnabled = !!fight?.nostrShareEnabled;
    const visibility = fight?.nostr?.visibility ?? "public";
    if (this.quickSaveState === "saving") {
      return !shareEnabled ? "Saving..." : visibility === "public" ? "Publishing..." : "Uploading...";
    }
    if (this.quickSaveState === "done") {
      return !shareEnabled ? "Saved" : visibility === "public" ? "Published" : "Uploaded";
    }
    return !shareEnabled ? "Save Locally" : visibility === "public" ? "Save & Publish" : "Save & Upload";
  }

  get quickSaveIcon(): string {
    if (this.needsSaveAs) return "save";
    if (this.quickSaveState === "done") return "check";
    const fight = this.fightLineController.data.fight;
    if (!fight?.nostrShareEnabled) return "save";
    return fight.nostr?.visibility === "private" ? "lock" : "global";
  }

  addJob(jobName: string, actorName?: string): void {
    this.fightLineController.addJob(null, jobName, actorName, null, false);
  }

  showHelp(): Promise<void> {
    const promise = new Promise<void>((resolve) => {
      this.dialogService.openHelp().then(() => {
        this.storage.setString("help_shown", "yes");
        resolve();
      });
    });

    return promise;
  }

  openSettings(): void {
    this.dialogService.openSettings();
  }

  onUndo(): void {
    this.fightLineController.undo();
    this.planArea.refresh();
    this.onCommand({ name: "undo" });
  }

  onRedo(): void {
    this.fightLineController.redo();
    this.planArea.refresh();
    this.onCommand({ name: "redo" });
  }

  private startNew() {
    this.dialogService.executeWithLoading("Starting...", (ref) => {
      this.presenterManager.reset();

      const settings = this.settingsService.load();
      this.presenterManager.setSettings(settings);

      // newFight() only mints an in-memory id here — nothing is written to IndexedDB, and the
      // URL deliberately stays on "/new" (not this.fightId), until the user explicitly saves. A
      // blank, unsaved fight also isn't meaningfully "recent" to return to (revisiting "/new"
      // starts another one, it doesn't resume this one), so it's not registered there either.
      this.fightService.newFight("").subscribe(
        (value) => {
          this.fightId = value.id;
          this.persistedLocally = false;
          ref.close();
        },
        (error) => {
          console.log(error);
          this.notification.error(
            "We are unable to connect to server. Your actions will not be stored."
          );
          ref.close();
        }
      );
    });
  }

  /**
   * Shared tail end of every "load a fight into the editor" path (local draft, or a Nostr fetch
   * that turned out to have a newer local counterpart). Centralized so the staleness challenge in
   * loadFightFromNostr can fall through to a real local load — with its own command history —
   * using exactly the same logic a plain local open would use.
   */
  private applyFightData(
    fight: M.IFight,
    preset: string | undefined,
    ref: { close: () => void },
    opts: { recentUrl: string; withCommandHistory: boolean; persistedLocally: boolean }
  ): void {
    this.fightId = fight.id;
    this.persistedLocally = opts.persistedLocally;
    this.recent.register({
      id: fight.id,
      name: fight.name,
      source: ActivitySource.Timeline,
      url: opts.recentUrl,
    });

    // A local draft that's already linked+enabled for Nostr sharing should show its shareable
    // /nostr/... address bar immediately on load — not just after the next Save & Publish. The
    // other load paths (a route already on /nostr/... , or a draft with sharing off) leave the
    // current URL alone, since it's already correct for those cases.
    if (fight.nostr && fight.nostrShareEnabled) {
      this.location.replaceState(this.nostrService.getFightRoutePath(fight.nostr.pubkey, fight.nostr.id));
    }

    const settings = this.settingsService.load();
    this.presenterManager.setSettings(settings);

    const loadedData =
      fight.data && (JSON.parse(fight.data) as SerializeController.IFightSerializeData);
    if (loadedData?.filter) {
      this.presenterManager.filter = loadedData.filter;
    }
    if (loadedData?.view) {
      this.presenterManager.view = loadedData.view;
    }

    this.presenterManager.load(fight.id);

    const finish = (commands?: any[]) => {
      this.planArea.setInitialWindow(this.fightLineController.getLatestBossAttackTime(), 2);
      this.planArea.refresh();
      try {
        this.fightLineController.loadFight(fight, loadedData, commands);
        if (preset) {
          this.fightLineController.loadPreset(preset);
        }
      } catch (error) {
        this.notification.error(
          "We are unable to load this fight. Dev team is already informed about this case"
        );
      }
      ref.close();
    };

    if (opts.withCommandHistory) {
      this.fightService
        .getCommands(fight.id, new Date(fight.dateModified).valueOf())
        .subscribe({
          next: (commands) => finish(commands.map((cmd) => JSON.parse(cmd.data))),
          error: (error) => {
            console.log(error);
            this.notification.error("Unable to load data");
            ref.close();
          },
        });
    } else {
      finish();
    }
  }

  private loadFight(id: string, preset?: string) {
    this.dialogService.executeWithLoading("Loading...", (ref) => {
      this.presenterManager.reset();
      this.fightService.getFight(id).subscribe(
        (fight: M.IFight) => {
          if (fight) {
            this.applyFightData(fight, preset, ref, {
              recentUrl: "/" + fight.id.toLowerCase(),
              withCommandHistory: true,
              persistedLocally: true,
            });
          } else {
            ref.close();
          }
        },
        () => {
          this.notification.showUnableToLoadFight(() => {});
          ref.close();
        }
      );
    });
  }

  private onStart(r: ActivatedRouteSnapshot): void {
    this.fflogsCode = null;
    if (r.params.pubToken && r.params.idToken) {
      const decoded = this.nostrService.decodeUrlSegments(r.params.pubToken, r.params.idToken);
      if (!decoded) {
        this.notification.error("This share link is not valid.");
        return;
      }
      if (r.data.nostrDocType === "boss") {
        this.loadBossFromNostr(decoded.pubkey, decoded.id);
      } else {
        this.loadFightFromNostr(decoded.pubkey, decoded.id, r.queryParamMap.get("preset"));
      }
      return;
    }

    const id = r.params.fightId;
    if (id) {
      if (id.indexOf("dummy") === 0) {
        this.loadFight("", r.queryParamMap.get("preset"));
      } else if (id === "new") {
        this.startNew();
      } else {
        this.loadFight(id, r.queryParamMap.get("preset"));
      }
    } else {
      const boss = r.params.boss;
      if (boss) {
        this.loadBoss(boss);
      } else {
        const code = r.params.code;
        if (code) {
          this.fflogsCode = code;
          const enc = r.params.fight;
          if (enc) {
            this.loadFFLogsData(code, +enc);
          } else {
            this.importFromFFLogs(code);
          }
        }
      }
    }
  }

  /**
   * Loads a fight published to Nostr — the serverless share-link path. Normally shows the fetched
   * snapshot as-is (no command-replay history, matching XIVPlan's model — in-session undo/redo
   * still works since that's already local to fightLineController/UndoRedoController), unless a
   * local draft already linked to this same document turns out to be newer, in which case that
   * local draft (with its own history) is loaded instead — see the staleness challenge below.
   */
  private loadFightFromNostr(pubkey: string, id: string, preset?: string): void {
    this.dialogService.executeWithLoading({ text: "Loading from Nostr...", nostr: true }, (ref) => {
      this.presenterManager.reset();
      this.fightId = id;
      this.nostrService.fetchFight(pubkey, id).subscribe({
        next: (result) => {
          const recentUrl = this.nostrService.getFightShareUrl(pubkey, id);

          // Challenge the fetched relay snapshot against any local draft already linked to this
          // same Nostr document (once consensus above has actually resolved a result). A local
          // draft can be ahead of the relays — edited but not yet republished — so on a refresh
          // or reopening this share link, whichever side is more recent wins; loading the older
          // one unconditionally could silently show stale content, or get overwritten right back
          // onto the relays on the next publish.
          this.fightService
            .findFightByNostrLink(pubkey, id)
            .pipe(catchError(() => of(null)))
            .subscribe((localFight) => {
              if (
                localFight &&
                new Date(localFight.dateModified).getTime() > result.publishedAt.getTime()
              ) {
                this.applyFightData(localFight, preset, ref, {
                  recentUrl,
                  withCommandHistory: true,
                  persistedLocally: true,
                });
                return;
              }

              const loadedData = JSON.parse(result.content) as SerializeController.IFightSerializeData;
              const fight: M.IFight = {
                id,
                name: result.name,
                userName: pubkey.slice(0, 8),
                data: result.content,
                isDraft: false,
                dateModified: result.publishedAt,
                game: this.gameService.name,
                // Records where this came from so a later re-publish (from the save dialog) can
                // update this same Nostr document instead of minting a new one — but only once
                // re-verified against whatever key is active at publish time, in case it's since
                // changed, or this is someone else's shared fight rather than your own.
                nostr: { pubkey, id, visibility: result.visibility },
              };
              this.applyFightData(fight, preset, ref, {
                recentUrl,
                withCommandHistory: false,
                persistedLocally: false,
              });
            });
        },
        error: (error) => {
          console.log(error);
          this.notification.error(error?.message ?? "Unable to load this shared fight.");
          ref.close();
        },
      });
    });
  }

  /** Boss-variant equivalent of loadFightFromNostr — like the existing loadBoss(), this starts a
   *  brand-new fight shell and loads the fetched boss data into it as the starting encounter. */
  private loadBossFromNostr(pubkey: string, id: string): void {
    this.dialogService.executeWithLoading({ text: "Loading from Nostr...", nostr: true }, (ref) => {
      this.nostrService.fetchBoss(pubkey, id).subscribe({
        next: (result) => {
          const bossData = JSON.parse(result.content) as M.IBoss;
          bossData.nostr = { pubkey, id, visibility: result.visibility };
          this.fightService.newFight("").subscribe(
            (value) => {
              // newFight() only mints an in-memory id — the URL stays on this nostr/... route
              // (not rewritten to a local draft id) until the user explicitly saves.
              this.fightId = value.id;
              this.persistedLocally = false;
              try {
                const settings = this.settingsService.load();
                this.presenterManager.setSettings(settings);
                this.fightLineController.applyView(settings.main.defaultView);
                this.fightLineController.applyFilter(settings.main.defaultFilter);
                this.fightLineController.loadBoss(bossData);
                this.planArea.setInitialWindow(this.fightLineController.getLatestBossAttackTime(), 2);
                this.planArea.refresh();
                ref.close();
              } catch (error) {
                console.log(error);
                this.notification.error("Unable to start");
                ref.close();
              }
            },
            (error) => {
              console.log(error);
              this.notification.error("Unable to start fight");
              ref.close();
            }
          );
        },
        error: (error) => {
          console.log(error);
          this.notification.error(error?.message ?? "Unable to load this shared boss.");
          ref.close();
        },
      });
    });
  }

  loadBoss(bossId: string) {
    this.dialogService.executeWithLoading("Loading...", (ref) => {
      const func = (fraction: M.IFraction, bossData: M.IBoss) => {
        this.fightService.newFight(fraction ? fraction.name : "").subscribe(
          (value) => {
            // newFight() only mints an in-memory id — the URL stays on this boss/:boss route
            // (not rewritten to a local draft id) until the user explicitly saves.
            this.fightId = value.id;
            this.persistedLocally = false;
            try {
              const settings = this.settingsService.load();

              this.presenterManager.setSettings(settings);

              this.fightLineController.fraction = fraction;
              this.fightLineController.applyView(settings.main.defaultView);
              this.fightLineController.applyFilter(
                settings.main.defaultFilter
              );

              this.fightLineController.loadBoss(bossData);
              this.planArea.setInitialWindow(
                this.fightLineController.getLatestBossAttackTime(),
                2
              );
              this.planArea.refresh();
              ref.close();
            } catch (error) {
              console.log(error);
              this.notification.error("Unable to start");
              ref.close();
            }
          },
          (error) => {
            console.log(error);
            this.notification.error("Unable to start fight");
            ref.close();
          }
        );
      };

      this.fightService.getBoss(bossId).subscribe(
        (data) => {
          func(null, data);
        },
        (error) => {
          console.log(error);
          this.notification.error("Unable to start");
          ref.close();
        }
      );
    });
  }

  /**
   * Publishes a boss template to the current pubkey's personal Nostr vault — replaces the old
   * server-backed public boss catalog for saving (per the migration plan, that public catalog is
   * retired going forward; a saved boss variant is now share-by-link/private-to-your-key, the same
   * model as a saved fight, not a publicly searchable record). Reuses the existing Nostr document
   * id (an in-place update, stable share URL) only when `bossData.nostr` was published under
   * whatever key is active *right now* — re-checked at publish time, not trusted from whenever
   * this boss was loaded, since the active key can change mid-session and a boss loaded from
   * someone else's shared link must never be able to overwrite their document.
   */
  private publishBossToNostr(bossData: M.IBoss, isPrivate: boolean, close: () => void): void {
    const visibility: "public" | "private" = isPrivate ? "private" : "public";
    this.nostrService.getPubkey().subscribe((currentPubkey) => {
      const reuseId = bossData.nostr?.pubkey === currentPubkey ? bossData.nostr.id : undefined;
      this.nostrService.publishBoss(bossData.data, bossData.name, visibility, reuseId).subscribe({
        next: (source) => {
          bossData.id = source.id;
          bossData.nostr = { pubkey: source.pubkey, id: source.id, visibility };
          bossData.userName = source.pubkey.slice(0, 8);
          bossData.isPrivate = isPrivate;
          this.fightLineController.updateBoss(bossData);
          this.notification.success("Boss saved to your Nostr vault");
          close();
        },
        error: (err) => {
          console.error(err);
          this.notification.error(err?.message ?? "Boss save failed");
        },
      });
    });
  }

  onCommand(data: ICommandData) {
    console.log("adding command in fightline.onCommand");
    this.fightService
      .addCommand(this.fightId, JSON.stringify(data))
      .subscribe();
    this.sidepanel.refresh();
  }

  ngOnInit(): void {
    this.visStorage.clear();
    this.fightLineController = new FightTimeLineController(
      this.idgen,
      this.visStorage.holders,
      {
        openBossAttackAddDialog: this.openBossAttackAddDialog.bind(this),
      },
      this.gameService,
      this.settingsService,
      this.presenterManager
    );

    this.router.routeReuseStrategy.shouldReuseRoute = () => false;
    this.router.onSameUrlNavigation = "reload";
    this.fightLineController.downtimeChanged.subscribe(() => {
      this.toolsManager.refresh();
    });
    this.fightLineController.commandExecuted.subscribe((data: ICommandData) => {
      this.onCommand(data);
    });

    this.subscribeToDispatcher(this.dispatcher);

    this.toolsManager.register(
      new DowntimeTool(this.planArea, this.fightLineController)
    );
    this.toolsManager.register(new CopyPasteTool(this.fightLineController));

    setTimeout(() => {
      this.onStart(this.route.snapshot);
    });
  }

  @HostListener("window:beforeunload", ["$event"])
  beforeUnloadHandler(event: any) {
    // Autosave isn't a thing anymore — there's no server quietly persisting edits in the
    // background. Only warn when there's actually somewhere for the loss to happen: changes
    // made to a fight that has never been through Save/Publish (no IndexedDB record backing it
    // yet). Once it's saved locally, edits since the last save live in IndexedDB via the command
    // log, so closing the tab isn't destructive the same way.
    if (this.hasChanges && !this.persistedLocally) {
      event.preventDefault();
      event.returnValue = "You have unsaved changes that haven't been saved yet. Are you sure you want to leave?";
      return event.returnValue;
    }
    return null;
  }

  get hasChanges(): boolean {
    return this.fightLineController.hasChanges;
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.dispatcher.destroy();
  }

  showAsTable() {
    this.dialogService.openTable();
  }

  openBossTemplates() {
    const boss = this.fightLineController.data.boss;
    this.dialogService.openBossTemplates(true, boss);
  }

  attachPreset(data: { name: string; preset: M.IPresetTemplate }) {
    this.fightLineController.attachPreset(data.name, data.preset);
  }

  exportData(format) {
    const saveData = (() => {
      const a = document.createElement("a");
      a.style.display = "none";
      document.body.appendChild(a);
      return (data: Blob, fileName: string) => {
        const url = window.URL.createObjectURL(data);
        a.href = url;
        a.download = fileName;
        a.click();
        window.URL.revokeObjectURL(url);
      };
    })();

    const serializer = this.fightLineController.createSerializer();
    const exported = serializer.serializeForDownload();
    const blob = new Blob([JSON.stringify(exported, null, 2)], {
      type: "application/json",
    });
    saveData(blob, "data.json");
  }

  /** Triggered by a hidden file input — reads a classic {party, events} export (the shape the
   *  Export > JSON button above has always produced, including on the old hosted deployment) and
   *  rebuilds it as a fresh, unsaved fight. Best-effort: that shape never carried full fidelity,
   *  so ability matching is name-based and anything that can't be matched is skipped and reported. */
  onImportJsonFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) {
      return;
    }

    if (this.fightLineController.hasChanges && !confirm("Importing will replace the current timeline with the imported data. Continue?")) {
      return;
    }

    file.text().then((text) => {
      let data: SerializeController.IClassicFightExport;
      try {
        data = JSON.parse(text);
      } catch {
        this.notification.error("This file isn't valid JSON.");
        return;
      }
      if (!data || !Array.isArray(data.party) || !Array.isArray(data.events)) {
        this.notification.error("This doesn't look like exported FightLine data.");
        return;
      }

      this.dialogService.executeWithLoading("Importing...", (ref) => {
        this.presenterManager.reset();
        this.fightService.newFight("").subscribe(
          (value) => {
            this.fightId = value.id;
            this.persistedLocally = false;
            try {
              const settings = this.settingsService.load();
              this.presenterManager.setSettings(settings);
              this.fightLineController.applyView(settings.main.defaultView);
              this.fightLineController.applyFilter(settings.main.defaultFilter);

              const result = this.fightLineController.importClassicExport(data);
              this.planArea.setInitialWindow(this.fightLineController.getLatestBossAttackTime(), 2);
              this.planArea.refresh();

              this.notification.success(
                `Imported ${result.jobsAdded} jobs, ${result.bossAttacksAdded} boss attacks and ${result.abilitiesAdded} abilities.` +
                  (result.abilitiesSkipped
                    ? ` ${result.abilitiesSkipped} abilities couldn't be matched and were skipped.`
                    : "")
              );
            } catch (error) {
              console.log(error);
              this.notification.error("Unable to import this file.");
            }
            ref.close();
          },
          (error) => {
            console.log(error);
            this.notification.error("Unable to start fight");
            ref.close();
          }
        );
      });
    });
  }

  private subscribeToDispatcher(
    dispatcher: DispatcherService<DispatcherPayloads>
  ) {
    dispatcher.on("similarClick").subscribe((value) => {
      this.planArea.selectBossAttacks([value]);
      this.sidepanel.setItems(this.fightLineController.getItems([value]));
    });

    dispatcher.on("similarAllClick").subscribe((value) => {
      this.planArea.selectBossAttacks(value);
      this.sidepanel.setItems(this.fightLineController.getItems(value));
    });

    dispatcher.on("abilityClick").subscribe((value) => {
      this.planArea.selectAbilities([value]);
      this.sidepanel.setItems(this.fightLineController.getItems([value]));
    });

    dispatcher.on("attacksSetColor").subscribe(({ ids, color }) => {
      this.fightLineController.combineAndExecute(
        ids.map((id) => {
          const ba = this.visStorage.holders.bossAttacks.get(id);
          return new ChangeBossAttackCommand(
            id,
            { ...ba.attack, color: color },
            false
          );
        })
      );
    });

    dispatcher.on("bossTemplateSave").subscribe((value) => {
      const bossData = this.fightLineController
        .createSerializer()
        .serializeBoss();

      if (bossData.id) {
        this.publishBossToNostr(bossData, value.isPrivate, value.close);
      } else {
        this.dialogService
          .openSaveBoss(value.name + " new template")
          .then((data) => {
            if (data) {
              bossData.name = data;
              bossData.ref = (bossData && bossData.ref) || value.reference;
              bossData.game = this.gameService.name;
              this.publishBossToNostr(bossData, value.isPrivate, value.close);
            } else {
              value.close();
            }
          });
      }
    });

    dispatcher.on("changeJobStats").subscribe((value) => {
      this.fightLineController.setJobStats(value.id, value.data);
    });

    dispatcher.on("toggleAttackPin").subscribe((value) => {
      this.fightLineController.toggleBossAttackPin(value);
    });

    dispatcher.on("bossTemplateSaveAsNew").subscribe((value) => {
      const bossData = this.fightLineController
        .createSerializer()
        .serializeBoss();
      this.dialogService
        .openSaveBoss(value.name + " new template")
        .then((data) => {
          if (data) {
            bossData.id = null;
            bossData.name = data;
            bossData.ref = (bossData && bossData.ref) || value.reference;
            bossData.game = this.gameService.name;
            this.publishBossToNostr(bossData, value.isPrivate, value.close);
          } else {
            value.close();
          }
        });
    });

    dispatcher.on("updateSettings").subscribe(() => {
      this.fightLineController.colorSettings =
        this.settingsService.load().colors;
      this.planArea.refresh();
    });

    dispatcher.on("removeJob").subscribe((value) => {
      this.fightLineController.removeJob(value);
      this.setSidePanel(null);
    });

    dispatcher.on("attackCopy").subscribe((value) => {
      this.fightLineController.copy(value);
      this.toolsManager.setActive("Copy & Paste");
    });

    dispatcher.on("attackEdit").subscribe((value) => {
      this.fightLineController.updateBossAttack(value);
    });

    dispatcher.on("updateFilter").subscribe((value) => {
      this.updateFilter();
    });

    dispatcher.on("updateView").subscribe((value) => {
      this.updateView();
    });

    // dispatcher.on("SidePanel Ability Settings").subscribe(value => {
    //   this.fightLineController.editAbility(value.id);
    // });

    dispatcher.on("abilitySaveSettings").subscribe((value) => {
      this.fightLineController.updateAbilitySettings(value.id, value.settings);
    });

    dispatcher.on("hideJobAbility").subscribe((value) => {
      this.fightLineController.hideAbility(value);
      this.setSidePanel(null);
      this.presenterManager.save(this.fightId);
    });

    dispatcher.on("clearJobAbility").subscribe((value) => {
      this.fightLineController.clearAbility(value);
      this.setSidePanel(null);
    });

    dispatcher.on("fillJobAbility").subscribe((value) => {
      this.fightLineController.combineAndExecute(
        this.fightLineController.fillAbility(value)
      );
    });

    dispatcher.on("fillJob").subscribe((value) => {
      this.fightLineController.combineAndExecute(
        this.fightLineController.fillJob(value)
      );
    });

    dispatcher.on("jobAbilityRestoreAll").subscribe((value) => {
      const hidden = [...this.presenterManager.jobFilter(value).abilityHidden];
      hidden?.forEach((h) => {
        const ab = this.visStorage.holders.abilities.getByParentAndAbility(
          value,
          h
        );
        this.fightLineController.showAbility(ab.id);
      });
      this.presenterManager.save(this.fightId);
    });

    dispatcher.on("jobAbilityRestore").subscribe((value) => {
      this.fightLineController.showAbility(value);
      this.presenterManager.save(this.fightId);
    });

    dispatcher.on("toggleJobCompactView").subscribe((value) => {
      this.fightLineController.toggleJobCompactView(value);
      this.fightLineController.applyFilter();
      this.presenterManager.save(this.fightId);
    });

    dispatcher.on("availAbilityClick").subscribe(({ abilityMap, attackId }) => {
      const attack = this.visStorage.holders.bossAttacks.get(attackId);
      const at = getTimeGoodAbilityToUse(
        this.visStorage.holders,
        abilityMap,
        attack
      );

      this.fightLineController.addClassAbility(null, abilityMap, at, false);
    });

    dispatcher.on("toggleJobAbilityCompactView").subscribe((value) => {
      this.fightLineController.toggleCompactViewAbility(value);
      // this.fightLineController.applyFilter();
      this.presenterManager.save(this.fightId);
    });

    dispatcher.on("downTimeColor").subscribe((value) => {
      this.fightLineController.setDownTimeColor(value.id, value.color);
    });

    dispatcher.on("downtimeComment").subscribe((value) => {
      this.fightLineController.setDownTimeComment(value.id, value.comment);
    });

    dispatcher.on("abilitiesRemove").subscribe((value) => {
      this.fightLineController.handleDelete(value);
    });

    dispatcher.on("attacksRemove").subscribe((value) => {
      this.fightLineController.handleDelete(value);
    });

    dispatcher.on("downtimeRemove").subscribe((value) => {
      this.fightLineController.removeDownTime(value);
      this.setSidePanel(null);
    });

    dispatcher.on("selectDowntimes").subscribe((value) => {
      this.setSidePanel({
        items: [value],
      });
    });

    dispatcher.on("bossTemplatesLoad").subscribe(async (value) => {
      this.dialogService.executeWithLoading("Loading...", async (ref) => {
        const stop = (dialog: { close: () => void }) => {
          value.close();
          this.progressBar.complete();
          dialog.close();
        };

        this.progressBar.start();
        const source = this.fightLineController.data.importedFrom;
        if (source) {
          const [code, fight] = source.split(":");
          const parser = await this.gameService.dataService.getEvents(
            code,
            +fight,
            { bossAttacksOnly: true },
            (percentage) => this.progressBar.set(percentage * 100)
          );

          const enemyAttacks = parser.events.filter((it: FF.AbilityEvent) => {
            return (
              !it.sourceIsFriendly &&
              it.ability &&
              it.ability.name.toLowerCase() !== "attack" &&
              it.ability.name.trim() !== "" &&
              it.ability.name.indexOf("Unknown_") < 0
            );
          });
          const g = _.groupBy(
            enemyAttacks as FF.AbilityEvent[],
            (d) => d.ability.name + "_" + Math.trunc(d.timestamp / 1000)
          );
          const attacks: FF.AbilityEvent[] = Object.keys(g).map((k: string) => {
            return g[k][0];
          });

          const bossData = JSON.parse(
            value.boss.data
          ) as SerializeController.IBossSerializeData;
          const result = process(
            attacks,
            parser.fight.start_time,
            bossData.attacks.map((it) => it.ability),
            bossData.downTimes
          );
          bossData.attacks = result.map(
            (it) =>
              ({
                ability: it,
                id: this.idgen.getNextId(M.EntryType.BossAttack),
              } as SerializeController.IBossAbilityUsageData)
          );
          value.boss.data = JSON.stringify(bossData);
          this.fightLineController.loadBoss(value.boss);
          stop(ref);
        } else {
          this.fightLineController.loadBoss(value.boss);
          stop(ref);
        }
      });
    });
  }
}
