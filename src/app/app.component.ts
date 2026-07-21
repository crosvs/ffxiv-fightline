import { Component, OnInit } from '@angular/core';
import { Location } from '@angular/common';
import { ChangeNotesService } from 'src/services/changeNotes.service';
import { DialogService } from 'src/services/DialogService';
import { LocalStorageService } from 'src/services/LocalStorageService';
import { environment } from "../environments/environment";
import {TranslateService} from '@ngx-translate/core';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {

  title = 'ClientApp';
  version = environment.version;

  constructor(
    private storage: LocalStorageService,
    private changeNotesService: ChangeNotesService,
    private dialogService: DialogService,
    private translate: TranslateService,
    private location: Location
  ) {
    this.translate.setDefaultLang("en");
    this.translate.use((localStorage.getItem("lang") || "en").replace("jp", "ja"));
  }

  ngOnInit(): void {
    // A changelog popup assumes the visitor already knows the app — meaningless (and
    // confusing) for someone whose very first visit is via a Nostr/FFLogs share link straight
    // into one specific fight, rather than the homepage. Checked before load() stamps the
    // "whatsnew_shown" marker, so this only fires for a true first-ever visit — a returning
    // user who happens to open a share link still sees it.
    const suppressDialog = !this.storage.getString("whatsnew_shown") && this.isSharedLinkEntry();
    setTimeout(() => {
      this.showWhatsNew(suppressDialog).then(() => { }).catch(() => { });
    });
  }

  private isSharedLinkEntry(): boolean {
    const path = this.location.path(false).replace(/^\/+/, "");
    return path.startsWith("nostr/") || path.startsWith("fflogs/");
  }

  showHelpForFirstTimers(): Promise<void> {
    if (!this.storage.getString("help_shown")) {
      return this.showHelp();
    }
    return Promise.resolve();
  }

  showWhatsNew(suppressDialog: boolean = false) {
    const promise = new Promise<void>((resolve) => {
      this.changeNotesService.load()
        .then(value => {
          if (suppressDialog) {
            resolve();
            return;
          }
          this.dialogService.openWhatsNew(value)
            .catch(() => {  })
            .finally(() => {
              resolve();
            });
        })
        .catch(() => { })
        .finally(() => {
          resolve();
        });
    });
    return promise;
  }

  showHelp(): Promise<void> {
    return this.dialogService.openHelp();
  }




}
