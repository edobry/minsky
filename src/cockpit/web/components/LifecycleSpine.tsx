/**
 * LifecycleSpine — one turn's trajectory with interceptors placed, sized, and
 * health-colored (mt#4011, mt#3754 phase 5).
 *
 * Answers "where do these apply" spatially: every interception point as a
 * station in trajectory order, each interceptor a dot at its station — sized
 * by fire volume in the aggregates window, colored by canary-backed health,
 * clicking through to the catalog detail view.
 *
 * Every figure comes from the same layers the catalog reads (SC4): placement
 * from the static catalog via `spine-model.ts`'s one definition, health from
 * `deriveInterceptorState`, volume from the aggregates snapshot row. Nothing
 * is recomputed here.
 *
 * Absence discipline, inherited from the page: a pending aggregates source
 * renders placement-only dots with a note (never zero-sized, never
 * health-colored by default); the CI and review stations render their
 * population gap as text rather than being omitted; unplaced, stationless and
 * excluded names are counted in a note rather than dropped.
 *
 * Layout: the band WRAPS, it does not scroll (mt#4599). Twelve stations cannot
 * fit one row inside the page's `max-w-4xl` shell — measured, the row needs
 * 1755px against an 864px container — so the original single-row
 * `overflow-x-auto` hid 7 of 12 stations behind a scrollbar nothing signalled,
 * and `items-stretch` propagated the densest station's height (192px, from
 * PreToolUse's 60 dots) onto every sparse one, rendering them as empty boxes.
 * Wrapping fits at every width from 360px up, and reading order across a
 * wrapped row IS trajectory order, so nothing about the spine's meaning is
 * traded away. Cards size to their own content; the `→` separator trails.
 */
import { Link } from "react-router-dom";
import type { InterceptorAggregateRow } from "@minsky/domain/guard-events/aggregates";
import {
  deriveInterceptorState,
  type InterceptorStateKind,
} from "@minsky/domain/guard-events/interceptor-state";
import type { InterceptorEntry } from "../hooks/useInterceptors";
import { SPINE_STATIONS, dotSizePx, spinePopulation } from "../lib/spine-model";

/**
 * Same state vocabulary as `InterceptorHealth.tsx`'s chips, as dot fills.
 * Color is not the only carrier: each dot's title names the state in words,
 * and the legend below the spine spells the mapping out.
 */
const STATE_DOT_CLASSES: Record<InterceptorStateKind, string> = {
  broken: "bg-warn-red",
  "never-verified": "bg-warn-amber",
  active: "bg-liveness-healthy",
  deterrent: "bg-liveness-idle",
  dormant: "bg-liveness-stale",
  "canary-unavailable": "bg-muted-foreground/40",
};

const STATE_LEGEND: readonly { kind: InterceptorStateKind; word: string }[] = [
  { kind: "broken", word: "broken" },
  { kind: "never-verified", word: "never verified" },
  { kind: "active", word: "active" },
  { kind: "deterrent", word: "deterrent" },
  { kind: "dormant", word: "dormant" },
  { kind: "canary-unavailable", word: "no canary data" },
];

function dotTitle(
  entry: InterceptorEntry,
  aggregate: InterceptorAggregateRow | undefined,
  snapshotReady: boolean
): string {
  const parts: string[] = [entry.guardName];
  if (!snapshotReady) {
    parts.push("aggregates pending — placement only");
  } else if (!aggregate) {
    parts.push("not in the aggregates snapshot");
  } else {
    const state = deriveInterceptorState(aggregate);
    parts.push(`${state.kind} · ${state.windowFires} fire(s) in window`);
  }
  if (entry.trajectory === "delivery") {
    parts.push("subject: delivery — intercepts the merge via an agent-side PreToolUse denial");
  }
  if (entry.subject === "system") {
    parts.push("subject: system — classifies other interceptors, not this turn");
  }
  return parts.join(" — ");
}

function SpineDot({
  entry,
  aggregate,
  snapshotReady,
  maxWindowFires,
}: {
  entry: InterceptorEntry;
  aggregate: InterceptorAggregateRow | undefined;
  snapshotReady: boolean;
  maxWindowFires: number;
}) {
  const state = snapshotReady && aggregate ? deriveInterceptorState(aggregate) : null;
  const size = state ? dotSizePx(state.windowFires, maxWindowFires) : dotSizePx(0, 0);
  const fill = state ? STATE_DOT_CLASSES[state.kind] : "bg-muted-foreground/25";

  return (
    <Link
      to={`/interceptors/${encodeURIComponent(entry.guardName)}`}
      title={dotTitle(entry, aggregate, snapshotReady)}
      data-testid="spine-dot"
      data-guard={entry.guardName}
      data-state={state?.kind ?? "pending"}
      data-subject={entry.subject}
      className="inline-flex items-center justify-center"
    >
      <span
        className={`block rounded-full ${fill} ${
          // `outline`, not `ring`: Tailwind's ring has no style variant, so a
          // dashed marker is only expressible as a dashed outline (PR #2989 R1
          // — `ring-dashed` is not a utility and rendered a solid ring).
          entry.subject === "system"
            ? "outline outline-1 outline-dashed outline-muted-foreground/70 outline-offset-1"
            : ""
        }`}
        style={{ width: size, height: size }}
      />
    </Link>
  );
}

export function LifecycleSpine({
  entries,
  aggregateRows,
  windowDays,
}: {
  entries: readonly InterceptorEntry[];
  /** Null while the aggregates snapshot is pending or failed. */
  aggregateRows: Map<string, InterceptorAggregateRow> | null;
  windowDays: number | null;
}) {
  // `stationless` is rendered in the population note alongside the other two
  // buckets (mt#4599). It was computed and discarded until now: mt#4129 added it
  // precisely so a declared point with no station is REPORTED rather than
  // dropped, and the component destructured around it, so the guard existed with
  // nothing wired to it. Empty today — `SPINE_STATIONS` covers every member of
  // `INTERCEPTION_POINT_ORDER` — which is exactly why the gap was invisible.
  const { placed, unplaced, stationless, excluded } = spinePopulation(entries);
  const snapshotReady = aggregateRows !== null;

  // The one population-wide figure the dots scale against; from the same rows
  // the catalog's cost column reads, never recomputed from the fire log here.
  let maxWindowFires = 0;
  if (aggregateRows) {
    for (const members of placed.values()) {
      for (const e of members) {
        const row = aggregateRows.get(e.guardName);
        if (row && row.fireLog.window.fires > maxWindowFires) {
          maxWindowFires = row.fireLog.window.fires;
        }
      }
    }
  }

  return (
    <section className="mb-4" data-testid="lifecycle-spine">
      <h2 className="text-[11px] font-mono font-semibold tracking-[0.04em] text-muted-foreground m-0">
        LIFECYCLE SPINE — one turn&apos;s trajectory
      </h2>
      <p className="text-[10px] font-mono text-muted-foreground/70 mt-0.5 mb-2" data-testid="spine-window-note">
        {snapshotReady && windowDays !== null
          ? `Sized by fires in the last ${windowDays} day(s), colored by canary-backed health.`
          : "Aggregates pending — placement only; size and health arrive with the first rollup."}
      </p>

      <div data-testid="spine-band">
        <ol className="flex flex-wrap items-start gap-y-2 list-none p-0 m-0">
          {SPINE_STATIONS.map((station, i) => (
            <li key={station.id} className="flex items-start">
              <div
                className={`flex flex-col rounded border p-2 min-w-[5.5rem] max-w-[9rem] ${
                  station.populationGap ? "border-dashed border-border/60" : "border-border/40"
                }`}
                data-testid={`spine-station-${station.id}`}
              >
                <span className="text-[10px] font-semibold text-foreground">{station.label}</span>
                {station.point && (
                  <span className="text-[9px] font-mono text-muted-foreground">{station.point}</span>
                )}
                {station.populationGap ? (
                  <span
                    className="mt-1 text-[9px] text-muted-foreground/80"
                    title={station.gapNote}
                    data-testid={`spine-gap-${station.id}`}
                  >
                    outside the cataloged population
                  </span>
                ) : (
                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    {(placed.get(station.id) ?? []).map((e) => (
                      <SpineDot
                        key={e.guardName}
                        entry={e}
                        aggregate={aggregateRows?.get(e.guardName)}
                        snapshotReady={snapshotReady}
                        maxWindowFires={maxWindowFires}
                      />
                    ))}
                    {(placed.get(station.id) ?? []).length === 0 && (
                      <span className="text-[9px] text-muted-foreground/60">none</span>
                    )}
                  </span>
                )}
              </div>
              {/* TRAILING, not leading (mt#4599). The band wraps, so a row that
                  continues onto the next row ends with an arrow — which reads
                  correctly. A leading arrow would dangle at a wrapped row's
                  start, pointing at nothing. */}
              {i < SPINE_STATIONS.length - 1 && (
                <span
                  aria-hidden
                  data-testid="spine-arrow"
                  className="mt-4 px-1 text-muted-foreground/50 text-[10px]"
                >
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div
        className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] font-mono text-muted-foreground/80"
        data-testid="spine-legend"
      >
        {STATE_LEGEND.map(({ kind, word }) => (
          <span key={kind} className="inline-flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-full ${STATE_DOT_CLASSES[kind]}`} />
            {word}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/25 outline outline-1 outline-dashed outline-muted-foreground/70 outline-offset-1" />
          dashed outline: subject is the interception system, not this turn
        </span>
      </div>

      {(unplaced.length > 0 || stationless.length > 0 || excluded.length > 0) && (
        <p className="mt-1 text-[9px] font-mono text-muted-foreground/70" data-testid="spine-population-note">
          {unplaced.length > 0 &&
            `${unplaced.length} unplaced (no declared point): ${unplaced.map((e) => e.guardName).join(", ")}. `}
          {stationless.length > 0 &&
            `${stationless.length} declared at a point this spine has no station for: ${stationless.map((e) => e.guardName).join(", ")}. `}
          {excluded.length > 0 &&
            `${excluded.length} fixture/retired name(s) excluded — fire-log history, not live interception.`}
        </p>
      )}
    </section>
  );
}
