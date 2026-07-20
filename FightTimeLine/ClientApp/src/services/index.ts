import { IFightService } from "./fight/fight.service-interface";
import { fightServiceToken, fightServiceProvider } from "./fight/fight.service-provider";
import { INostrService } from "./nostr/nostr.service-interface";
import { nostrServiceToken, nostrServiceProvider } from "./nostr/nostr.service-provider";
import { NostrStatusService } from "./nostr/nostr-status.service";
import { DialogService } from "./DialogService";
import { RecentActivityService } from "./RecentActivitiesService";
import { SettingsService } from "./SettingsService";
import { ScreenNotificationsService } from "./ScreenNotificationsService";
import { LocalStorageService } from "./LocalStorageService";
import { DispatcherPayloads, DispatcherService } from "./dispatcher.service";
import { ChangeNotesService, IChangeNote } from "./changeNotes.service";
import { FightHubService, IConnectToSessionHandlers, IStartSessionHandlers } from "./FightHubService";
import * as Gameserviceprovider from "./game.service-provider";
import { FFXIVApiService } from "./FFxivApiService";
import { VisStorageService } from "./VisStorageService";
import { SessionStorageService } from "./SessionStorageService";

export {
  DialogService,
  IFightService,
  RecentActivityService,
  SettingsService,
  ScreenNotificationsService,
  SessionStorageService,
  LocalStorageService,
  DispatcherService,
  IConnectToSessionHandlers,
  IStartSessionHandlers,
  fightServiceProvider,
  fightServiceToken,
  INostrService,
  nostrServiceProvider,
  nostrServiceToken,
  NostrStatusService,
  FFXIVApiService,
  FightHubService,
  IChangeNote,
  ChangeNotesService
};

export const ServicesModuleComponents =
  [
    DialogService,
    RecentActivityService,
    SettingsService,
    ScreenNotificationsService,
    LocalStorageService,
    SessionStorageService,
    { provide: "DispatcherPayloads", useFactory: () => new DispatcherService<DispatcherPayloads>() },
    FightHubService,
    ChangeNotesService,
    fightServiceProvider,
    nostrServiceProvider,
    NostrStatusService,
    Gameserviceprovider.gameServiceProvider,
    VisStorageService,
    FFXIVApiService
  ];
