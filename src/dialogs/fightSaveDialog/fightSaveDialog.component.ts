import { Component, inject, Inject, OnInit } from "@angular/core";
import { UntypedFormBuilder, UntypedFormControl } from "@angular/forms";
import { IFight, INostrLink } from "../../core/Models";
import { IFightService } from "../../services/fight/fight.service-interface";
import { INostrService } from "../../services/nostr/nostr.service-interface";
import { NostrStatusService } from "../../services/nostr/nostr-status.service";
import { ScreenNotificationsService } from "../../services/ScreenNotificationsService";
import { fightServiceToken } from "../../services/fight/fight.service-provider";
import { nostrServiceToken } from "../../services/nostr/nostr.service-provider";
import { saveFightAndMaybePublish } from "../../services/fight/fightSave.helper";
import { baseHref, randomDocId } from "../../services/nostr/nostr-engine";
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
  saving = false;
  shareEnabled = false;
  visibility: "public" | "private" = "public";
  currentPubkey: string | null = null;
  private initialNostrLinkId: string | undefined;
  // What the link WOULD be if saved right now with the current toggle state — kept separate from
  // `data.nostr` (the last actually-committed link) so previewing/toggling never mutates anything
  // a Cancel needs to leave untouched.
  private previewNostr: INostrLink | undefined;

  ngOnInit(): void {
    this.initialNostrLinkId = this.data.nostr?.id;
    this.shareEnabled = !!this.data.nostrShareEnabled;
    this.visibility = this.data.nostr?.visibility ?? "public";
    this.previewNostr = this.data.nostr ? { ...this.data.nostr } : undefined;
    this.nostrService.getPubkey().subscribe((pubkey) => {
      this.currentPubkey = pubkey;
      if (this.shareEnabled) {
        this.ensurePreviewLink();
      }
    });
  }

  get saveButtonLabel(): string {
    if (this.saving) {
      return !this.shareEnabled ? "Saving..." : this.visibility === "public" ? "Publishing..." : "Uploading...";
    }
    return !this.shareEnabled ? "Save Locally" : this.visibility === "public" ? "Save & Publish" : "Save & Upload";
  }

  get previewUrl(): string {
    if (this.shareEnabled && this.previewNostr) {
      return this.nostrService.getShareUrl("fight", this.previewNostr.pubkey, this.previewNostr.id);
    }
    if (!this.shareEnabled && this.data.id) {
      return `${location.origin}${baseHref()}${this.data.id}`;
    }
    return "";
  }

  get urlNote(): string {
    if (!this.shareEnabled) {
      return "Local draft — only opens on this device, in this browser.";
    }
    return this.visibility === "public"
      ? "Public — anyone with this link can open it, no account needed."
      : "Private — encrypted so only your Nostr key can open it (e.g. your other devices with that same key imported); not meant for sharing with others.";
  }

  onShareToggleChange(enabled: boolean): void {
    this.shareEnabled = enabled;
    if (enabled) {
      this.ensurePreviewLink();
    }
  }

  onVisibilityToggle(): void {
    this.visibility = this.visibility === "public" ? "private" : "public";
    if (this.previewNostr) {
      this.previewNostr = { ...this.previewNostr, visibility: this.visibility };
    }
  }

  /** Reserves/refreshes the previewed link so `previewUrl` always matches what an actual Save
   *  right now would produce — a fresh id if there's no link yet (or the active key differs from
   *  whoever minted the existing one), otherwise the same stable id with the current visibility. */
  private ensurePreviewLink(): void {
    if (!this.previewNostr || this.previewNostr.pubkey !== this.currentPubkey) {
      this.previewNostr = { pubkey: this.currentPubkey, id: randomDocId(), visibility: this.visibility };
    } else {
      this.previewNostr = { ...this.previewNostr, visibility: this.visibility };
    }
  }

  onSaveClick(): void {
    this.submitted = true;
    if (!this.fightNameControl.valid) {
      this.fightNameControl.markAsTouched({ onlySelf: true });
      return;
    }

    this.data.nostrShareEnabled = this.shareEnabled;
    if (this.shareEnabled) {
      this.ensurePreviewLink();
      this.data.nostr = this.previewNostr;
    }

    this.saving = true;
    saveFightAndMaybePublish(this.data, this.service, this.nostrService, this.currentPubkey).subscribe({
      next: (saved) => {
        this.saving = false;
        this.dialogRef.close(saved);
      },
      error: (error) => {
        this.saving = false;
        this.handleSaveError(error);
      },
    });
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

  copyShareUrl(): void {
    if (!this.previewUrl) return;
    navigator.clipboard?.writeText(this.previewUrl).then(
      () => this.notification.success("Link copied."),
      () => {} // clipboard permission denied — the input is still select()-ed for manual copy
    );
  }

  handleSaveError(error: any) {
    let text: string = error?.message || error?.statusText || "Failed to save.";
    if (error?.status === 403) {
      text = "Invalid Username or Secret used to update this Fight";
    }
    this.notification.error(text);
  }

  onNoClick(): void {
    // A publish while the dialog was open still needs to reach the caller (fightline.component's
    // saveFight()) so its notion of the current fight's id/Nostr link updates — even though the
    // user is dismissing via Cancel, not the explicit Save button. Only do this if something
    // actually changed, so a genuine no-op Cancel doesn't spuriously show a "saved" notification.
    // Toggling/previewing alone never mutates `data.nostr` (see previewNostr), so this only fires
    // on a link that was actually committed by a completed Save before Cancel was clicked.
    if (this.data.nostr?.id !== this.initialNostrLinkId) {
      this.dialogRef.close(this.data);
    } else {
      this.dialogRef.destroy();
    }
  }

}
