import { InjectionToken } from '@angular/core';

import { FightsService } from "./fight.service";
import { IFightService } from "./fight.service-interface";

import * as Gameserviceprovider from "../game.service-provider";
import * as Gameserviceinterface from "../game.service-interface";

const fightServiceFactory = (gameService: Gameserviceinterface.IGameService): IFightService => {
  return new FightsService(gameService);
};

export let fightServiceToken = new InjectionToken("IFightService");

export let fightServiceProvider =
{
  provide: fightServiceToken,
  useFactory: fightServiceFactory,
  deps: [
    Gameserviceprovider.gameServiceToken
  ]
};
