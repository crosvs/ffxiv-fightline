import { InjectionToken } from "@angular/core";

import { NostrService } from "./nostr.service";
import { INostrService } from "./nostr.service-interface";
import { NostrMockService } from "./nostr.service-mock";

import { environment } from "../../environments/environment";

const nostrServiceFactory = () => {
  let serviceToReturn: INostrService;
  if (environment.production) {
    serviceToReturn = new NostrService();
  } else {
    serviceToReturn = new NostrMockService();
  }
  return serviceToReturn;
};

export let nostrServiceToken = new InjectionToken("INostrService");

export let nostrServiceProvider = {
  provide: nostrServiceToken,
  useFactory: nostrServiceFactory,
  deps: [],
};
