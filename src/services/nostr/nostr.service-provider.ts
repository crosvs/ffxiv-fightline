import { InjectionToken } from "@angular/core";

import { NostrService } from "./nostr.service";
import { INostrService } from "./nostr.service-interface";

// No dev/prod branching here, unlike fight.service-provider.ts's old real-HTTP-vs-mock split —
// there's nothing unsafe or costly about hitting real Nostr relays in dev, and faking it produces
// exactly the bug that motivated removing the mock: a "shared" link that only ever resolves
// against whatever's in the current browser's own local storage, not a real relay-backed link
// usable from anywhere else.
const nostrServiceFactory = (): INostrService => new NostrService();

export let nostrServiceToken = new InjectionToken("INostrService");

export let nostrServiceProvider = {
  provide: nostrServiceToken,
  useFactory: nostrServiceFactory,
  deps: [],
};
