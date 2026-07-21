import {
  Component,
  OnInit,
  OnDestroy,
  Inject,
  ViewChild,
  HostListener,
} from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { SettingsService } from "../../services/SettingsService";
import * as S from "../../services/index";
import * as M from "../../core/Models";
import { NgProgressbar } from "ngx-progressbar";

import { BossAttackDefensiveTemplateV2 } from "../../core/ExportTemplates/BossAttackDefensiveTemplate";
import {
  TableViewTemplate,
  ExportTemplateContext,
} from "../../core/BaseExportTemplate";
import { gameServiceToken } from "../../services/game.service-provider";
import { IGameService } from "../../services/game.service-interface";
import { INostrService } from "../../services/nostr/nostr.service-interface";
import { nostrServiceToken } from "../../services/nostr/nostr.service-provider";

import * as FightTimeLineController from "../../core/FightTimeLineController";
import * as Generators from "../../core/Generators";
import { DescriptiveTemplate } from "../../core/ExportTemplates/DescriptiveTemplate";
import * as ExportModels from "../../core/ExportModels";
import { VisStorageService } from "../../services/VisStorageService";
import { IFightSerializeData } from "../../core/SerializeController";
import { MitigationsTemplate } from "../../core/ExportTemplates/MitigationsTemplate";
import { DispatcherPayloads } from "../../services/dispatcher.service";
import { Utils } from "../../core/Utils";
import { Location } from "@angular/common";
import { SidepanelComponent } from "../../components/sidepanel/sidepanel.component";
import {
  calculateAvailDefsForAttack,
  getAvailabilitiesForAbility,
  getTimeGoodAbilityToUse,
} from "../../core/Defensives/functions";
import { CdkDrag, CdkDragDrop, CdkDropList } from "@angular/cdk/drag-drop";
import { MoveCommand } from "../../core/commands/MoveCommand";
import { BossAttackAndMitigationAbilities } from "src/core/ExportTemplates/BossAttackAndMitigationAbilities";
import { Subscription } from "rxjs";

type DropData = {
  row: ExportModels.IExportRow;
  col: ExportModels.IExportColumn;
};

@Component({
  selector: "tableview",
  templateUrl: "./tableview.component.html",
  styleUrls: ["./tableview.component.css"],
})
export class TableViewComponent implements OnInit, OnDestroy {
  fightId: string;
  template: string;
  tableHeight: string = window.innerHeight - 100 + "px";
  fightLineController: FightTimeLineController.FightTimeLineController;
  options: ExportModels.ITableOptionSettings;
  currentOptions: ExportModels.ITableOptions;
  filterData: { [name: string]: string[] } = {};

  @ViewChild("sidepanel", { static: true }) sidepanel: SidepanelComponent;
  @ViewChild("progressBar", { static: true }) progressBar: NgProgressbar;

  set: ExportModels.IExportResultSet = {
    columns: [],
    headers: [],
    rows: [],
    title: "",
    filterByFirstEntry: false,
  };

  filtered: ExportModels.IExportRow[] = [];
  pagesize = Number.MAX_VALUE;
  private lvl: number;
  private ff: boolean;
  tpl: TableViewTemplate;

  templates = {
    defence: BossAttackDefensiveTemplateV2,
    descriptive: DescriptiveTemplate,
    mitigations: MitigationsTemplate,
    mitwithabilities: BossAttackAndMitigationAbilities,
  } as const;

  get showIcon(): boolean {
    return this.currentOptions.co.indexOf("icon") >= 0;
  }
  get showOffset(): boolean {
    return this.currentOptions.co.indexOf("offset") >= 0;
  }

  get showText(): boolean {
    return this.currentOptions.co.indexOf("text") >= 0;
  }

  get showTarget(): boolean {
    return this.currentOptions.co.indexOf("target") >= 0;
  }

  get iconSize(): number {
    return this.currentOptions.is;
  }

  private idgen = new Generators.IdGenerator();

  public constructor(
    @Inject(S.fightServiceToken) private fightService: S.IFightService,
    @Inject(gameServiceToken) private gameService: IGameService,
    @Inject(nostrServiceToken) private nostrService: INostrService,
    private visStorage: VisStorageService,
    private notification: S.ScreenNotificationsService,
    private route: ActivatedRoute,
    private dialogService: S.DialogService,
    private location: Location,
    private router: Router,
    @Inject("DispatcherPayloads")
    private dispatcher: S.DispatcherService<DispatcherPayloads>,
    private settingsService: SettingsService
  ) {}

  home() {
    this.router.navigateByUrl("/");
  }

  filterChange(event: any, column: string) {
    if (column) {
      this.filterData[column] = event;
    }
    const cellFilter = this.createCellFilter();
    this.filtered = this.set.rows.filter((row) => {
      const flattenedColumns = this.set.columns;
      const visible = flattenedColumns.every((c) => {
        const v =
          !c.filterFn ||
          !this.filterData[c.name] ||
          c.filterFn(this.filterData[c.name], row, c);
        return v;
      });

      if (visible) {
        row.cells.forEach((cell, index) =>
          cellFilter(cell, this.filterData[flattenedColumns[index].name])
        );
      }

      return visible;
    });
  }

  createCellFilter() {
    const unique = new Set();
    const fn = (cell: ExportModels.IExportCell, data: string[]) => {
      cell.items.forEach((it) => {
        it.visible = true;
        if (it.filterFn && data && !it.filterFn(data)) {
          it.visible = false;
          return;
        } else {
          if (cell.disableUnique) {
            return;
          }
          if (it.refId && unique.has(it.refId)) {
            it.visible = false;
          } else {
            it.visible = true;
            unique.add(it.refId);
          }
        }
      });
    };
    return fn;
  }

  ngOnInit(): void {
    this.visStorage.clear();
    this.gameService.jobRegistry.setLevel(100);
    this.fightLineController =
      new FightTimeLineController.FightTimeLineController(
        this.idgen,
        this.visStorage.holders,
        {
          openBossAttackAddDialog: () => {},
        },
        this.gameService,
        this.settingsService,
        this.visStorage.presenter
      );
    this.fightLineController.commandExecuted.subscribe((data) => {
      this.fightService
        .addCommand(this.fightId, JSON.stringify(data))
        .subscribe();
      this.loadTable();
      this.sidepanel.refresh();
    });

    this.fightLineController.applyFilter(null, "level");

    this.subscribeToDispatcher(this.dispatcher);

    this.route.params.subscribe((r) => {
      const pubToken = r.pubToken as string;
      const idToken = r.idToken as string;
      const viewmode = r.viewmode as string;
      if (pubToken && idToken && viewmode) {
        const decoded = this.nostrService.decodeUrlSegments(pubToken, idToken);
        if (!decoded) {
          this.notification.error("This share link is not valid.");
          return;
        }
        this.template = viewmode;
        this.loadFromNostr(decoded.pubkey, decoded.id);
        return;
      }

      const id = r.fightId as string;
      const template = r.template as string;
      if (id && template) {
        this.template = template;
        this.fightId = id;
        this.load(id);
      }
    });
  }

  private subscribeToDispatcher(
    dispatcher: S.DispatcherService<DispatcherPayloads>
  ) {
    dispatcher.on("similarClick").subscribe((value) => {
      this.sidepanel.setItems(this.fightLineController.getItems([value]));
    });

    dispatcher.on("similarAllClick").subscribe((value) => {
      this.sidepanel.setItems(this.fightLineController.getItems(value));
    });

    dispatcher.on("abilityClick").subscribe((value) => {
      this.sidepanel.setItems(this.fightLineController.getItems([value]));
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
  }

  private tplExecutedSub: Subscription;

  load(id: string) {
    this.dialogService.executeWithLoading("Loading...", (ref) => {
      this.fightService.getFight(id).subscribe(
        (fight: M.IFight) => {
          if (fight) {
            this.fightService
              .getCommands(id, new Date(fight.dateModified).valueOf())
              .subscribe({
                next: (value) => {
                  const loadedData =
                    fight.data &&
                    (JSON.parse(fight.data) as IFightSerializeData);
                  this.finishLoad(
                    fight,
                    loadedData,
                    value.map((cmd) => JSON.parse(cmd.data)),
                    ref
                  );
                },
                error: (error) => {
                  console.error(error);
                  ref.close();
                  this.notification.error("Unable to load data");
                },
              });
          } else {
            ref.close();
            this.notification.showUnableToLoadFight(() => {});
          }
        },
        (error) => {
          console.error(error);
          this.notification.showUnableToLoadFight(() => {});
          ref.close();
        }
      );
    });
  }

  /** Nostr-share counterpart of load() — mirrors FightLineComponent's loadFightFromNostr, minus
   *  the local-draft staleness challenge: table view is read-only presentation, not a save
   *  target, so there's no "which side is newer" question to resolve. */
  private loadFromNostr(pubkey: string, id: string): void {
    this.dialogService.executeWithLoading(
      { text: "Loading from Nostr...", nostr: true },
      (ref) => {
        this.fightId = id;
        this.nostrService.fetchFight(pubkey, id).subscribe({
          next: (result) => {
            const loadedData = JSON.parse(
              result.content
            ) as IFightSerializeData;
            const fight: M.IFight = {
              id,
              name: result.name,
              userName: pubkey.slice(0, 8),
              data: result.content,
              isDraft: false,
              dateModified: result.publishedAt,
              game: this.gameService.name,
              nostr: { pubkey, id, visibility: result.visibility },
            };
            this.finishLoad(fight, loadedData, undefined, ref);
          },
          error: (error) => {
            console.error(error);
            this.notification.error(
              error?.message ?? "Unable to load this shared fight."
            );
            ref.close();
          },
        });
      }
    );
  }

  private finishLoad(
    fight: M.IFight,
    loadedData: IFightSerializeData,
    commands: any[] | undefined,
    ref: { close: () => void }
  ): void {
    this.fightLineController.loadFight(fight, loadedData, commands);
    this.gameService.jobRegistry.setLevel(100);
    this.tpl = new this.templates[this.template.toLowerCase()]();
    this.tplExecutedSub = this.tpl.onExecuted.subscribe((data) => {
      this.fightLineController.combineAndExecute([data]);
    });
    this.loadTable();
    ref.close();
  }

  private loadTable() {
    if (!this.tpl) {
      this.notification.error("Table template not found");
      return;
    }

    if (!this.options) {
      const cellOptions: ExportModels.TagsOptionsSetting = {
        name: "co",
        defaultValue: ["icon", "text", "target"],
        displayName: "Cell Options",
        kind: ExportModels.TableOptionSettingType.Tags,
        description: "",
        visible: true,
        options: {
          items: [
            { id: "icon", checked: true, text: "Icon" },
            { id: "text", checked: true, text: "Text" },
            { id: "offset", checked: false, text: "Offset" },
            { id: "target", checked: true, text: "Target" },
          ],
        },
      };

      const iconSize: ExportModels.NumberRangeOptionsSetting = {
        name: "is",
        defaultValue: 16,
        displayName: "Icon Size",
        visible: true,
        kind: ExportModels.TableOptionSettingType.NumberRange,
        description: "Changes size of icons",
        options: {
          min: 16,
          max: 48,
          step: 1,
        },
      };

      const level: ExportModels.NumberRangeOptionsSetting = {
        name: "l",
        defaultValue: 100,
        displayName: "Fight Level",
        visible: true,
        kind: ExportModels.TableOptionSettingType.NumberRange,
        description: "Set level of fight",
        options: {
          min: 50,
          max: 100,
          step: 10,
        },
      };

      const fflogs: ExportModels.BooleanOptionsSetting = {
        name: "ff",
        defaultValue: false,
        displayName: "FFLogs Attack Source",
        visible: this.visStorage.presenter.fflogsSource,
        kind: ExportModels.TableOptionSettingType.Boolean,
        description: "FFLogs Attack Source",
        options: {
          true: "Cast",
          false: "Damage",
        },
      };

      this.options = [
        level,
        fflogs,
        ...(this.tpl.loadOptions(this.visStorage.holders) || []),
        cellOptions,
        iconSize,
      ].filter(Boolean);

      const [_, search] = this.location.path().split("?");
      const params = new URLSearchParams(search);
      this.options.forEach((opts) => {
        const p = params.get(opts.name);
        if (p != null) {
          opts.initialValue = parseOptions(opts.kind, p);
          if (opts.kind === ExportModels.TableOptionSettingType.Tags) {
            opts.options.items.forEach((opt) => {
              opt.checked = opts.initialValue.indexOf(opt.id) >= 0;
            });
          }
        }
      });

      this.currentOptions = this.options.reduce((acc, c) => {
        acc[c.name] = c.initialValue || c.defaultValue;
        return acc;
      }, {});
    }

    const ff = this.currentOptions.ff as boolean;
    if (ff !== this.ff) {
      this.visStorage.presenter.fflogsSource = ff;
      this.ff = ff;
    }

    const lvl = this.currentOptions.l;
    if (lvl !== this.lvl) {
      this.visStorage.presenter.fightLevel = lvl;
      this.gameService.jobRegistry.setLevel(lvl);
      this.fightLineController.applyFilter(null, "level");
      this.lvl = lvl;
    }

    const context = {
      presenter: this.visStorage.presenter,
      jobRegistry: this.gameService.jobRegistry,
      options: this.currentOptions,
      holders: this.visStorage.holders,
    } as ExportTemplateContext;
    this.set = this.tpl.buildTable(context);

    this.filterChange(null, null);
  }

  select(id: string, $event?: MouseEvent) {
    if ($event) {
      $event.stopPropagation();
      $event.preventDefault();
    }

    this.sidepanel.setSidePanel({ items: [id] });

    this.setDragContext(id);
  }

  private setDragContext(id: string) {
    if (!id) {
      this.draggingContext = undefined;
      return;
    }

    const u = this.visStorage.holders.itemUsages.get(id);
    if (!u) return;

    const p = getAvailabilitiesForAbility(
      this.visStorage.holders,
      id
    )(u.ability);
    
    const ids = this.set.rows
      .map((r) => ({
        r,
        m: this.visStorage.holders.bossAttacks.get(r.filterData.id),
      }))
      .filter((r) => {
        if (!p) return true;
        const start = r.m.start;
        return p.some((d) => d.data.start <= start && d.data.end >= start);
      })
      .map((r) => r.m.id);
    this.draggingContext = { a: new Set(ids), jid: u.ability.job.id };
  }

  dragStarted(id: string) {
    this.setDragContext(id);
  }
  private draggingContext: { a: Set<string>; jid: string } = undefined;

  isAvailableToDrop(d: DropData) {
    if (!this.draggingContext) return false;

    const colId = d.col.refId;
    if (this.draggingContext.jid !== colId) return false;

    const rowId = d.row.filterData.id;
    if (this.idgen.isBossAttack(rowId)) {
      if (!this.draggingContext.a) return true;
      return this.draggingContext.a.has(rowId);
    }
    return false;
  }

  canDrop(drag: CdkDrag, drop: CdkDropList) {
    const itemId = drag.data.refId;
    const colId = drop.data.col.refId;
    const rowId = drop.data.row.filterData.id;
    if (this.idgen.isAbilityUsage(itemId)) {
      const u = this.visStorage.holders.itemUsages.get(itemId);
      const jid = u.ability.job.id;
      if (jid === colId) {
        if (this.idgen.isBossAttack(rowId)) {
          const avail = calculateAvailDefsForAttack(
            this.visStorage.holders,
            rowId,
            itemId
          );
          return (
            avail.defs
              ?.filter((a) => a.jobId === jid)?.[0]
              ?.abilities.some(
                (ab) => ab.ability.name === u.ability.ability.name
              ) || false
          );
        }
      }
    }
    return false;
  }

  onDrop(ev: CdkDragDrop<DropData>) {
    this.draggingContext = undefined;

    const { item, container } = ev;
    const itemId = item.data.refId;
    const colId = container.data.col.refId;
    const rowId = container.data.row.filterData.id;
    if (this.idgen.isAbilityUsage(itemId)) {
      const u = this.visStorage.holders.itemUsages.get(itemId);
      const jid = u.ability.job.id;
      if (jid === colId) {
        if (this.idgen.isBossAttack(rowId)) {
          const att = this.visStorage.holders.bossAttacks.get(rowId);
          console.log(
            `dropping ${u.ability.ability.name} on ${att.attack.name} at ${att.attack.offset}`
          );

          const at = getTimeGoodAbilityToUse(
            this.visStorage.holders,
            u.ability,
            att,
            itemId
          );

          this.fightLineController.combineAndExecute([
            new MoveCommand(itemId, at),
          ]);
        }
      } else {
        console.log("not same job");
      }
    }
    console.log(ev);
  }

  @HostListener("window:resize", ["$event"])
  resizeHandler(event: any) {
    this.tableHeight = event.target.innerHeight - 100 + "px";
  }

  trackByName(_: number, item: ExportModels.IExportColumn): string {
    return item.refId;
  }

  optionsChanged(values: ExportModels.ITableOptions) {
    this.currentOptions = values;
    const serialized = Utils.serializeOptions(values, this.options);
    const [path] = this.location.path().split("?");
    this.location.replaceState(path + "?" + serialized);
    this.loadTable();
  }

  ngOnDestroy(): void {
    if (this.tplExecutedSub) {
      this.tplExecutedSub.unsubscribe();
    }
    this.dispatcher.destroy();
  }

  langChanged() {
    this.loadTable();
  }
}

function parseOptions(
  type: ExportModels.TableOptionSettingType,
  p: string
): any {
  switch (type) {
    case ExportModels.TableOptionSettingType.Boolean:
      return p === "true";
    case ExportModels.TableOptionSettingType.NumberRange:
      return +p;
    case ExportModels.TableOptionSettingType.Tags:
      return p.split(",");
    case ExportModels.TableOptionSettingType.LimitedNumberRange:
      return p.split(",").map((x) => +x);
  }
}
