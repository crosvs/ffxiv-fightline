import { IAuthenticationService } from "./authentication/authentication.service-interface";
import { authenticationServiceProvider, authenticationServiceToken } from "./authentication/authentication.service-provider";
import { IFightService } from "./fight/fight.service-interface";
import { fightServiceToken, fightServiceProvider } from "./fight/fight.service-provider";
import { INostrService } from "./nostr/nostr.service-interface";
import { nostrServiceToken, nostrServiceProvider } from "./nostr/nostr.service-provider";
import { DialogService } from "./DialogService";
import { RecentActivityService } from "./RecentActivitiesService";
import { SettingsService } from "./SettingsService";
import { UserService } from "./UserService";
import { ScreenNotificationsService } from "./ScreenNotificationsService";
import { LocalStorageService } from "./LocalStorageService";
import { DispatcherPayloads, DispatcherService } from "./dispatcher.service";
import { ChangeNotesService, IChangeNote } from "./changeNotes.service";
import { FightHubService, IConnectToSessionHandlers, IStartSessionHandlers } from "./FightHubService";
import * as Gameserviceprovider from "./game.service-provider";
import { FFXIVApiService } from "./FFxivApiService";
import { VisStorageService } from "./VisStorageService";
import { UserStorageService } from "./UserStorageService";
import { SessionStorageService } from "./SessionStorageService";

export {
  IAuthenticationService,
  DialogService,
  IFightService,
  RecentActivityService,
  SettingsService,
  UserService,
  ScreenNotificationsService,
  SessionStorageService,
  LocalStorageService,
  DispatcherService,
  IConnectToSessionHandlers,
  IStartSessionHandlers,
  authenticationServiceProvider,
  authenticationServiceToken,
  fightServiceProvider,
  fightServiceToken,
  INostrService,
  nostrServiceProvider,
  nostrServiceToken,
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
    UserService,
    ScreenNotificationsService,
    LocalStorageService,
    SessionStorageService,
    { provide: "DispatcherPayloads", useFactory: () => new DispatcherService<DispatcherPayloads>() },
    FightHubService,
    ChangeNotesService,
    authenticationServiceProvider,
    fightServiceProvider,
    nostrServiceProvider,
    Gameserviceprovider.gameServiceProvider,
    UserStorageService,
    VisStorageService,
    FFXIVApiService
  ];

