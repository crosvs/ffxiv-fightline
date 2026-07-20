import { Component, Input, OnInit } from "@angular/core";
import { Observable } from "rxjs";
import { map, startWith } from "rxjs/operators";
import { probeRelays, RelayHealth, ConsensusProgress } from "../../services/nostr/nostr-engine";
import { NostrStatusService, RelayStatusEntry } from "../../services/nostr/nostr-status.service";

const SIZE = 20;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const DOT_COLORS: Record<RelayHealth, string> = {
  connected: "#3fa142",
  error: "#d0342c",
  checking: "#e0a729",
  skipped: "#8c8c8c",
  stale: "#c98a1f",
  // Same severity tier as 'stale' — has the right version, just not all of it yet.
  incomplete: "#c98a1f",
};

const RELAY_LABELS: Record<RelayHealth, string> = {
  connected: "Agrees",
  error: "No response",
  checking: "Checking…",
  skipped: "Skipped",
  stale: "Outdated",
  incomplete: "Missing data",
};

type AggregateStatus = "checking" | "connected" | "partial" | "offline";

function aggregateRelayStatus(relays: RelayStatusEntry[]): AggregateStatus {
  const allChecked = relays.every((r) => r.status !== "checking");
  if (!allChecked) return "checking";
  const anyConnected = relays.some((r) => r.status === "connected");
  if (!anyConnected) return "offline";
  const anyTrouble = relays.some((r) => r.status === "error" || r.status === "stale" || r.status === "incomplete");
  return anyTrouble ? "partial" : "connected";
}

const AGGREGATE_COLORS: Record<AggregateStatus, string> = {
  connected: "#3fa142",
  partial: "#e0a729",
  offline: "#d0342c",
  checking: "#1890ff",
};

interface RingGeometry {
  determinate: boolean;
  dashArray: string;
  dashOffset: number;
  ringColor: string;
  spin: boolean;
}

/**
 * A single compact status element combining relay connectivity (fill color + hover breakdown)
 * with consensus progress (the ring around it) — the Angular equivalent of XIVPlan's
 * CircularRelayIndicator, meant to sit wherever a spinner would (a save/load button, a vault
 * list row) so a publish/fetch always shows both at a glance. Not wired into any page yet — see
 * nostr/09-porting-guide.md Phase 3 for where this gets consumed.
 */
@Component({
  selector: "nostr-status",
  templateUrl: "./nostr-status.component.html",
  styleUrls: ["./nostr-status.component.css"],
})
export class NostrStatusComponent implements OnInit {
  /** Omit for an indeterminate operation with no consensus target (e.g. loading a vault list). */
  @Input() progress$?: Observable<ConsensusProgress>;
  /** Per-relay breakdown for the hover popover. Defaults to general relay health if not provided
   *  by the caller (e.g. a caller tracking one specific in-flight fetch would pass fetchStatus$). */
  @Input() relayStatus$?: Observable<RelayStatusEntry[]>;
  @Input() size = SIZE;

  readonly svgSize = SIZE;
  readonly circumference = CIRCUMFERENCE;

  relays$!: Observable<RelayStatusEntry[]>;
  dotColor$!: Observable<string>;
  ring$!: Observable<RingGeometry>;
  relayLabel = RELAY_LABELS;
  dotColors = DOT_COLORS;

  constructor(private readonly status: NostrStatusService) {}

  ngOnInit(): void {
    void probeRelays();

    this.relays$ = this.relayStatus$ ?? this.status.relayStatus$;
    this.dotColor$ = this.relays$.pipe(map((relays) => AGGREGATE_COLORS[aggregateRelayStatus(relays)]));

    const progress$ = this.progress$;
    this.ring$ = (progress$ ?? this.status.relayStatus$.pipe(map(() => undefined))).pipe(
      startWith(undefined),
      map((progress): RingGeometry => {
        const determinate = !!progress && progress.threshold > 0;
        if (!determinate) {
          return {
            determinate: false,
            dashArray: `${CIRCUMFERENCE * 0.25} ${CIRCUMFERENCE * 0.75}`,
            dashOffset: 0,
            ringColor: "#1890ff",
            spin: true,
          };
        }
        const fraction = Math.min(progress!.agreeing, progress!.threshold) / progress!.threshold;
        return {
          determinate: true,
          dashArray: `${CIRCUMFERENCE}`,
          dashOffset: CIRCUMFERENCE * (1 - fraction),
          ringColor: progress!.status === "short" ? "#c98a1f" : "#1890ff",
          spin: false,
        };
      }),
    );
  }

  displayUrl(url: string): string {
    return url.replace(/^wss:\/\//, "");
  }
}
