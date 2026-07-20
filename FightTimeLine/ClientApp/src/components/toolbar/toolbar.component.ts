import { Component, OnInit, OnDestroy, Input, Output, EventEmitter, Inject, AfterViewInit } from "@angular/core";
import { Router } from "@angular/router";
import { DialogService } from "../../services/index";
import { ScreenNotificationsService } from "../../services/ScreenNotificationsService";
import { ChangeNotesService } from "../../services/index";
import { INostrService } from "../../services/nostr/nostr.service-interface";
import { nostrServiceToken } from "../../services/nostr/nostr.service-provider";
import { pubkeyToNpub, subscribePubkey, getCachedPubkey, refreshNostrPubkey } from "../../services/nostr/nostr-engine";
import * as Gameserviceprovider from "../../services/game.service-provider";
import * as Gameserviceinterface from "../../services/game.service-interface";
import * as _ from "lodash";
import { VisStorageService } from "src/services/VisStorageService";
import { TranslateService } from "@ngx-translate/core";

@Component({
  selector: "toolbar",
  templateUrl: "./toolbar.component.html",
  styleUrls: ["./toolbar.component.css"],
})
export class ToolbarComponent implements OnInit, OnDestroy {

  @Input() showHome: boolean;
  @Input() showRefresh: boolean;
  @Output() refresh: EventEmitter<void> = new EventEmitter<void>();
  @Output() langChanged: EventEmitter<void> = new EventEmitter<void>();

  container = { data: [] };
  private unsubscribePubkey: () => void;

  public constructor(
    private dialogService: DialogService,
    @Inject(nostrServiceToken) private nostrService: INostrService,
    @Inject(Gameserviceprovider.gameServiceToken) public gameService: Gameserviceinterface.IGameService,
    private notification: ScreenNotificationsService,
    private changeNotesService: ChangeNotesService,
    private router: Router,
    private visStorage: VisStorageService,
    private translate: TranslateService
  ) {

  }

  ngOnInit(): void {
    this.unsubscribePubkey = subscribePubkey(() => {});
    void refreshNostrPubkey();
  }

  ngOnDestroy(): void {
    this.unsubscribePubkey?.();
  }

  get displayIdentity(): string {
    const pubkey = getCachedPubkey();
    if (!pubkey) return "…";
    const npub = pubkeyToNpub(pubkey);
    return npub.slice(0, 12) + "…" + npub.slice(-6);
  }

  get currentLang() {
    return (this.visStorage.presenter.language || "en").toLocaleUpperCase();
  }

  setLang(lang: string) {

    this.visStorage.presenter.setLang(lang);
    {
      const all = this.visStorage.holders.abilities.getAll();
      all.forEach(a => a.applyData({}));
      this.visStorage.holders.abilities.update(all);
    }

    {
      const all = this.visStorage.holders.jobs.getAll();
      all.forEach(a => a.applyData({}));
      this.visStorage.holders.jobs.update(all);
    }

    this.translate.use((localStorage.getItem("lang") || "en").replace("jp", "ja"));
    this.langChanged.emit();

  }

  onHome() {
    this.router.navigateByUrl("/");
  }

  onRefresh() {
    this.refresh.emit();
  }

  openSettings(): void {
    this.dialogService.openSettings();
  }


  showWhatsNewInt() {
    this.changeNotesService.load(true)
      .then(value => {
        this.dialogService.openWhatsNew(null, value);
      });
  }

  gotoDiscord() {
    window.open("https://discord.gg/xRppKj4", "_blank");
  }

  gotoGithub() {
    window.open("https://github.com/Airex/ffxiv-fightline/issues", "_blank");
  }


  privacy() {
    window.open("/privacy", "_blank");
  }

  showHelp(): Promise<void> {
    return this.dialogService.openHelp();
  }

  changeTheme() {
    (window as any).changeTheme(this.darkTheme ? "default" : "dark");
  }

  get darkTheme() {
    return localStorage.getItem("theme") === "dark";
  }

  onLoad(): void {
    this.dialogService.openLoad();
  }

  /** Downloads the current Nostr secret key as a .txt file — the only backup a user has, since
   *  nothing is stored server-side. */
  exportKey(): void {
    this.nostrService.exportSecretKeyBlob().subscribe((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "fightline-nostr-key.txt";
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  /** Triggered by a hidden file input in the template — reads the selected .txt key file and
   *  imports it, replacing the currently active identity. */
  onImportKeyFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      this.nostrService.importSecretKey(text).subscribe({
        next: () => this.notification.success("Nostr key imported."),
        error: (err) => this.notification.error(err?.message ?? "Invalid key file."),
      });
    });
    input.value = "";
  }

  generateNewKey(): void {
    if (!confirm("This replaces your current Nostr identity with a brand-new one. Export your current key first if you want to keep access to anything published under it. Continue?")) {
      return;
    }
    this.nostrService.generateNewKey().subscribe(() => {
      this.notification.success("Generated a new Nostr key.");
    });
  }
}
