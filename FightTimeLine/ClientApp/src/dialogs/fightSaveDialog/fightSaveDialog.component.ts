import { Component, inject, Inject, Input, OnInit } from "@angular/core";
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

export class FightSaveDialogComponent {

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
    this.nostrService.publishFight(this.data.data, this.data.name, visibility).subscribe({
      next: (source) => {
        this.publishingNostr = false;
        this.nostrShareUrl = this.nostrService.getShareUrl("fight", source.pubkey, source.id);
      },
      error: (error) => {
        this.publishingNostr = false;
        this.notification.error(error?.message ?? "Failed to publish to Nostr.");
      },
    });
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
    this.dialogRef.destroy();
  }

}
