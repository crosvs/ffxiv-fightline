import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';
import { FightLineComponent } from "../pages/fightline/fightline.component";
import { TableViewComponent } from "../pages/tableview/tableview.component";
import { HomeComponent } from "../pages/home/home.component";

const routes: Routes = [
  { path: "fflogs/:code/:fight", component: FightLineComponent, /*canDeactivate: [CanDeactivateUnsaved]*/ },
  { path: "fflogs/:code", component: FightLineComponent, /*canDeactivate: [CanDeactivateUnsaved]*/ },
  { path: "boss/:boss", component: FightLineComponent, /*canDeactivate: [CanDeactivateUnsaved]*/ },
  // Boss-variant Nostr share-link (rare, one-shot import — see nostr-engine.ts's URL-helpers
  // comment) — /nostr/boss/<pubkeyToken>/<docIdToken>. `data.nostrDocType` lets
  // FightLineComponent.onStart() tell this apart from the bare fight route below, since both
  // resolve to the same :pubToken/:idToken param names.
  { path: "nostr/boss/:pubToken/:idToken", component: FightLineComponent, data: { nostrDocType: "boss" } },
  // Local (never-published) draft table view — see fightline.component.ts's onTable().
  { path: "table/:fightId/:template", component: TableViewComponent },
  // Serverless Nostr fight share-link: /<pubkeyToken>/<docIdToken>, optionally followed by a
  // table-view name to view that instead of the default timeline — see nostr-engine.ts's
  // getFightShareUrl/getFightRoutePath. Must stay below every literal-prefixed route above:
  // Angular tries routes in array order and a bare `:param` segment matches any literal text too.
  { path: ":pubToken/:idToken/:viewmode", component: TableViewComponent },
  { path: ":pubToken/:idToken", component: FightLineComponent },
  { path: ":fightId", component: FightLineComponent, /*canDeactivate: [CanDeactivateUnsaved]*/ },
  { path: "", component: HomeComponent },
  { path: "**", redirectTo: "" }
];

@NgModule({
  imports: [RouterModule.forRoot(routes, {
    urlUpdateStrategy: 'eager',
  })],
  exports: [RouterModule]
})
export class AppRoutingModule { }
