import { Component, inject } from "@angular/core";
import { NZ_MODAL_DATA, NzModalRef } from "ng-zorro-antd/modal";
import { NostrStatusService } from "../../services/nostr/nostr-status.service";

@Component({
    selector: "loadingDialog",
    templateUrl: "./loadingDialog.component.html",
    styleUrls: ["./loadingDialog.component.css"]
})
export class LoadingDialogComponent {

    data: { text: string; nostr?: boolean } = inject(NZ_MODAL_DATA) ?? { text: "Loading..." };

    constructor(
        public dialogRef: NzModalRef,
        public nostrStatus: NostrStatusService
        ) {
    }
}
