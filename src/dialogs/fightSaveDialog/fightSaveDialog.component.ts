import { Component, inject, Inject, OnInit } from "@angular/core";
import { UntypedFormBuilder, UntypedFormControl } from "@angular/forms";
import { IFight } from "../../core/Models";
import { IFightService } from "../../services/fight/fight.service-interface";
import { INostrService } from "../../services/nostr/nostr.service-interface";
import { NostrStatusService } from "../../services/nostr/nostr-status.service";
import { ScreenNotificationsService } from "../../services/ScreenNotificationsService";
import { fightServiceToken } from "../../services/fight/fight.service-provider";
import { nostrServiceToken } from "../../services/nostr/nostr.service-provider";
import { NZ_MODAL_DATA, NzModalRef } from "ng-zorro-antd/modal";

@Component({
  selector: "fightSaveDialog",
  templateUrl: "./fightSaveDialog.component.html",
  styleUrls: ["./fightSaveDialog.component.css"]
})

export class FightSaveDialogComponent implements OnInit {

  constructor(
    private formBuilder: UntypedFormBuilder,
    private notification: ScreenNotificationsService,
    public dialogRef: NzModalRef,
    @Inject(fightServiceToken) public service: IFightService,
    @Inject(nostrServiceToken) public nostrService: INostrService,
    public nostrStatus: NostrStatusService
  ) {

  }

  fightNameControl = new UntypedFormControl();
  data: IFight = inject(NZ_MODAL_DATA);
  submitted = false;
  publishingNostr = false;
  nostrShareUrl: string | null = null;
  currentPubkey: string | null = null;
  private initialNostrLinkId: string | undefined;

  ngOnInit(): void {
    this.initialNostrLinkId = this.data.nostr?.id;
    this.nostrService.getPubkey().subscribe((pubkey) => {
      this.currentPubkey = pubkey;
    });
  }

  /** True when this draft was already published under whatever key is currently active — a
   *  re-publish should update that same document (stable share URL) rather than mint a new one.
   *  Re-checked against the *current* key each time, not cached from when the fight was loaded —
   *  the active key can change mid-session via import/generate. */
  get isLinkedToNostr(): boolean {
    return !!this.data.nostr && this.data.nostr.pubkey === this.currentPubkey;
  }

  publishLabel(visibility: "public" | "private"): string {
    return this.isLinkedToNostr ? "Update" : "Publish";
  }

  onSaveClick(): void {
    this.submitted = true;
    if (!this.fightNameControl.valid) {
      this.fightNameControl.markAsTouched({ onlySelf: true });
      return;
    }

    this.service
      .saveFight(this.data)
      .subscribe((data) => {
        this.dialogRef.close(data);
      }, this.handleSaveError.bind(this));
  }

  onSaveAsNewClick(): void {
    this.submitted = true;
    if (!this.fightNameControl.valid) {
      this.fightNameControl.markAsTouched({ onlySelf: true });
      return;
    }
    this.data.id = "";
    // A forked local draft is a distinct thing going forward — its next Nostr publish must mint
    // a fresh document, not silently overwrite the fight it was forked from.
    this.data.nostr = undefined;
    this.service
      .saveFight(this.data)
      .subscribe((data) => {
        this.dialogRef.close(data);
      }, this.handleSaveError.bind(this));

  }

  onPublishNostrClick(visibility: "public" | "private"): void {
    this.submitted = true;
    if (!this.fightNameControl.valid) {
      this.fightNameControl.markAsTouched({ onlySelf: true });
      return;
    }

    this.publishingNostr = true;
    this.nostrShareUrl = null;
    const reuseId = this.isLinkedToNostr ? this.data.nostr!.id : undefined;
    this.nostrService.publishFight(this.data.data, this.data.name, visibility, reuseId).subscribe({
      next: (source) => {
        this.publishingNostr = false;
        this.data.nostr = { pubkey: source.pubkey, id: source.id, visibility };
        this.nostrShareUrl = this.nostrService.getShareUrl("fight", source.pubkey, source.id);
        // Persist the linkage onto the local draft immediately (creating one if this fight had
        // never been saved locally yet) — so a later re-publish from this same draft, even in a
        // future session, still finds the link without the user needing to click "Save" too.
        this.service.saveFight(this.data).subscribe((saved) => {
          this.data.id = saved.id;
        });
      },
      error: (error) => {
        this.publishingNostr = false;
        this.notification.error(error?.message ?? "Failed to publish to Nostr.");
      },
    });
  }

  copyShareUrl(): void {
    if (!this.nostrShareUrl) return;
    navigator.clipboard?.writeText(this.nostrShareUrl).then(
      () => this.notification.success("Link copied."),
      () => {} // clipboard permission denied — the input is still select()-ed for manual copy
    );
  }

  handleSaveError(error: any) {
    // console.log(error);
    let text: string = error.statusText;
    if (error.status === 403) {
      text = "Invalid Username or Secret used to update this Fight";
    }
    this.notification.error(text);
  }

  onNoClick(): void {
    // A publish while the dialog was open still needs to reach the caller (fightline.component's
    // saveFight()) so its notion of the current fight's id/Nostr link updates — even though the
    // user is dismissing via Cancel, not the explicit Save button. Only do this if something
    // actually changed, so a genuine no-op Cancel doesn't spuriously show a "saved" notification.
    if (this.data.nostr?.id !== this.initialNostrLinkId) {
      this.dialogRef.close(this.data);
    } else {
      this.dialogRef.destroy();
    }
  }

}
