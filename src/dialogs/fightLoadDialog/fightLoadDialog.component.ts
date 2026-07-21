import {
  Component,
  Inject,
  ViewChild,
  TemplateRef,
  Input,
  OnInit,
} from "@angular/core";
import { Router } from "@angular/router";
import { IFightService } from "../../services/fight/fight.service-interface";
import { fightServiceToken } from "../../services/fight/fight.service-provider";
import { INostrService } from "../../services/nostr/nostr.service-interface";
import { nostrServiceToken } from "../../services/nostr/nostr.service-provider";
import { NostrStatusService } from "../../services/nostr/nostr-status.service";
import { NostrDocInfo } from "../../services/nostr/nostr-engine";
import { ScreenNotificationsService } from "../../services/ScreenNotificationsService";
import * as M from "../../core/Models";
import { NzSwitchComponent } from "ng-zorro-antd/switch";
import { NzModalRef } from "ng-zorro-antd/modal";

@Component({
  selector: "fightLoadDialog",
  templateUrl: "./fightLoadDialog.component.html",
  styleUrls: ["./fightLoadDialog.component.css"],
})
export class FightLoadDialogComponent implements OnInit {
  constructor(
    public dialogRef: NzModalRef,
    @Inject(fightServiceToken) public service: IFightService,
    @Inject(nostrServiceToken) public nostrService: INostrService,
    public nostrStatus: NostrStatusService,
    private router: Router,
    private notification: ScreenNotificationsService
  ) {}

  ngOnInit(): void {
    this.load();
  }

  @Input() data: any;
  @ViewChild("headerTemplate", { static: true })
  public headerTemplate: TemplateRef<any>;
  @ViewChild("showDrafts") public fg: NzSwitchComponent;
  container: { fights: M.IFight[] } = { fights: [] };
  loading = true;
  selectedRowsChecked = [];

  // --- Local drafts (IndexedDB) ---

  load() {
    this.loading = true;
    this.service.getFightsForUser().subscribe({
      next: (it: M.IFight[]) => {
        this.container.fights = it;
        this.loading = false;
      },
      error: (error) => {
        this.notification.showUnableToLoadFights();
        this.loading = false;
      },
    });
  }

  removevisiblechanged(el: HTMLElement, visible: any) {
    // todo: check passed value
    el.className = el.className.replace("forcevisible", "");
    if (visible) {
      el.className += " forcevisible";
    }
  }

  remove(item: any) {
    this.service.removeFights([item.id]).subscribe(
      () => {
        this.removeSelectedRows([item.id]);
        this.loading = false;
      },
      (error) => {
        this.notification.showUnableToRemoveFights();
        console.error(error);
      },
      () => {
        this.selectedRowsChecked.splice(0);
      }
    );
  }

  removeSelectedRows(itemsToRemove) {
    itemsToRemove.forEach((item) => {
      const index: number = this.container.fights.findIndex(
        (d) => d.id === item
      );
      if (index > -1) {
        this.container.fights.splice(index, 1);
      }
    });
  }

  onNoClick(): void {
    this.dialogRef.destroy();
  }

  select(item: any): void {
    this.dialogRef.afterClose.subscribe(() => {
      this.router.navigateByUrl("/" + item.id);
    });

    this.dialogRef.destroy();
  }

  // --- Nostr vault (published fights, read back from relays) ---

  vaultPlans: NostrDocInfo[] = [];
  vaultLoading = false;
  vaultHasMore = false;
  vaultLoaded = false;
  vaultPubkey: string | null = null;
  private vaultCursor: number | undefined;

  /** Only scans relays the first time the vault tab is opened per dialog instance — repeat tab
   *  switches reuse what's already loaded (matches nostr-engine's own vault cache TTL intent;
   *  "Refresh" below is the explicit way to force a rescan). */
  onVaultTabActivated(): void {
    if (this.vaultLoaded) return;
    this.loadVault();
  }

  loadVault(): void {
    this.vaultLoading = true;
    this.vaultPlans = [];
    this.vaultCursor = undefined;
    this.nostrService.getPubkey().subscribe((pubkey) => {
      this.vaultPubkey = pubkey;
      this.fetchVaultPage();
    });
  }

  private fetchVaultPage(): void {
    this.nostrService.listMyFights({ until: this.vaultCursor }).subscribe({
      next: (result) => {
        this.vaultPlans = [...this.vaultPlans, ...result.plans];
        this.vaultHasMore = result.hasMore;
        this.vaultLoading = false;
        this.vaultLoaded = true;
        const oldest = result.plans[result.plans.length - 1];
        if (oldest) {
          this.vaultCursor = Math.floor(oldest.publishedAt.getTime() / 1000);
        }
      },
      error: (error) => {
        console.error(error);
        this.notification.error(error?.message ?? "Unable to scan relays for your vault.");
        this.vaultLoading = false;
        this.vaultLoaded = true;
      },
    });
  }

  loadMoreVault(): void {
    this.vaultLoading = true;
    this.fetchVaultPage();
  }

  refreshVault(): void {
    this.vaultLoaded = false;
    this.loadVault();
  }

  selectVaultItem(item: NostrDocInfo): void {
    const path = this.nostrService.getRoutePath("fight", this.vaultPubkey, item.id);
    this.dialogRef.afterClose.subscribe(() => {
      this.router.navigateByUrl(path);
    });
    this.dialogRef.destroy();
  }

  removeVaultItem(item: NostrDocInfo): void {
    this.nostrService.deleteFight(item.id).subscribe({
      next: () => {
        this.vaultPlans = this.vaultPlans.filter((p) => p.id !== item.id);
        this.notification.success("Removed from your Nostr vault.");
      },
      error: (error) => {
        console.error(error);
        this.notification.error("Unable to remove — try again.");
      },
    });
  }
}
