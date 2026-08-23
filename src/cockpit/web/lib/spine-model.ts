/**
 * Spine model — the pure placement layer for the lifecycle-spine visual
 * (mt#4011, mt#3754 phase 5).
 *
 * ONE definition of "where does this interceptor sit on the turn trajectory",
 * shared by the `LifecycleSpine` component and its tests, so the spine's
 * membership can never diverge from the catalog data it renders (mt#4011 AT1 /
 * SC4: no figure or grouping recomputed with a second definition).
 *
 * Placement is the entry's interception point — the same axis-1 value the
 * catalog's point facet filters on — with exactly one authored exception: the
 * merge gates carry `trajectory: "delivery"` (authored in
 * `.minsky/hooks/interceptor-coordinates.ts`, threaded through the generated
 * catalog) and place at the merge station, because their SUBJECT is the merge
 * while their declared point stays `PreToolUse` (mechanism truth — the
 * mechanism decides who is bound; see `docs/architecture/interceptors.md` §5).
 *
 * The two trailing delivery stations (CI, review) have NO cataloged
 * population: CI checks are GitHub Actions workflows and the reviewer is a
 * GitHub App service — neither writes fire-log records nor appears in a
 * declaration source. They render as explicit population-gap stations rather
 * than being omitted (the umbrella's missing-rendered-as-missing discipline),
 * and never as invented entities.
 */
import {
  INTERCEPTION_POINT_ORDER,
  type InterceptionPoint,
  type InterceptorEntry,
} from "../hooks/useInterceptors";

export type SpineStationId = InterceptionPoint | "domain-command" | "ci" | "review";

export interface SpineStation {
  readonly id: SpineStationId;
  /** Reader-facing trajectory-phase word. */
  readonly label: string;
  /** The harness event / repo point name, verbatim, where one exists. */
  readonly point: InterceptionPoint | null;
  /** True for the delivery stations with no cataloged population. */
  readonly populationGap: boolean;
  /** For a gap station: who actually intercepts there, and why it is not cataloged. */
  readonly gapNote?: string;
}

/**
 * Phase labels beside the verbatim point names.
 *
 * `Record<InterceptionPoint, string>` is deliberately exhaustive: a point added
 * to the union without a label here is a type error, which is what forces this
 * file to be considered when the model grows. mt#4129 added six points and this
 * is where that widening became visible.
 */
const POINT_LABELS: Record<InterceptionPoint, string> = {
  UserPromptSubmit: "prompt",
  PreToolUse: "tool call · pre",
  PostToolUse: "tool call · post",
  Stop: "stop",
  SubagentStop: "subagent stop",
  SessionEnd: "session end",
  MessageDisplay: "display",
  SessionStart: "session start",
  StopFailure: "stop · failed",
  Notification: "notification",
  PermissionRequest: "permission request",
  PreCompact: "compact · pre",
  PostCompact: "compact · post",
  "pre-commit": "commit",
  "merge-time": "merge",
};

/**
 * The stations, in trajectory order: the nine interception points exactly as
 * `INTERCEPTION_POINT_ORDER` fixes them (SC1's "in trajectory order" is that
 * constant, not a second ordering), with the three uncataloged strata
 * interleaved at their trajectory positions — the domain-command paths ride
 * INSIDE tool calls, so their station sits after the tool-call points; CI and
 * review are the delivery tail. Together the station set covers every
 * Dimension-1 stratum from the ontology's §5 table (the interception system
 * itself is covered per-entry, via the `subject: "system"` marking, not as a
 * position — meta-level interceptions have no place on a turn's trajectory).
 */
export const SPINE_STATIONS: readonly SpineStation[] = [
  ...INTERCEPTION_POINT_ORDER.slice(0, 3).map((p) => ({
    id: p,
    label: POINT_LABELS[p],
    point: p,
    populationGap: false,
  })),
  {
    id: "domain-command" as const,
    label: "domain command",
    point: null,
    populationGap: true,
    gapNote:
      "Domain command paths intercept inside tool calls with no hook and no git — ask-form-lint runs on the asks_create command path. Not in the cataloged population: its records reach the calibration sweep, but no declaration source lists it.",
  },
  ...INTERCEPTION_POINT_ORDER.slice(3).map((p) => ({
    id: p,
    label: POINT_LABELS[p],
    point: p,
    populationGap: false,
  })),
  {
    id: "ci" as const,
    label: "CI",
    point: null,
    populationGap: true,
    gapNote:
      "CI checks (GitHub Actions — required checks, bundle-boot smoke) intercept here. They are workflows, not cataloged interceptors: they write no fire-log records and appear in no declaration source.",
  },
  {
    id: "review" as const,
    label: "review",
    point: null,
    populationGap: true,
    gapNote:
      "The reviewer (minsky-reviewer GitHub App) intercepts here at review time. It is a service, not a cataloged interceptor: it writes no fire-log records and appears in no declaration source.",
  },
];

/**
 * Where one entry sits on the spine. Null means unplaceable: no declared
 * point and no authored trajectory — rendered as an explicit note, never
 * dropped silently.
 */
export function spineStationOf(entry: InterceptorEntry): SpineStationId | null {
  if (entry.trajectory === "delivery") return "merge-time";
  return entry.point;
}

export interface SpinePopulation {
  /** Station id -> members, insertion-ordered by the caller's entry order. */
  readonly placed: ReadonlyMap<SpineStationId, InterceptorEntry[]>;
  /** Entries with no station: point undeclared and no authored trajectory. */
  readonly unplaced: readonly InterceptorEntry[];
  /**
   * Entries whose point IS declared but which the spine has no station for
   * (mt#4129).
   *
   * A distinct bucket from `unplaced`, deliberately. mt#4129 added six points to
   * the model without placing them on the trajectory — ordering `Notification`
   * or `PreCompact` against a turn's phases is a spine-design decision, not a
   * population one. Folding these into `unplaced` would report "point
   * undeclared" about entries whose point is declared and correct, and dropping
   * them into `placed` under a station id `SPINE_STATIONS` does not contain
   * renders them nowhere at all: an entry silently absent from the visual, which
   * is the exact defect class mt#4129 exists to remove, reproduced one layer up.
   */
  readonly stationless: readonly InterceptorEntry[];
  /**
   * Fixture and retired names, excluded by stratum: they exist because the
   * fire log is append-only history, and nothing intercepts a live turn
   * through them.
   */
  readonly excluded: readonly InterceptorEntry[];
}

/** Station ids the spine actually renders — the lookup `placed` keys must hit. */
const RENDERED_STATION_IDS: ReadonlySet<SpineStationId> = new Set(SPINE_STATIONS.map((s) => s.id));

export function spinePopulation(entries: readonly InterceptorEntry[]): SpinePopulation {
  const placed = new Map<SpineStationId, InterceptorEntry[]>();
  const unplaced: InterceptorEntry[] = [];
  const stationless: InterceptorEntry[] = [];
  const excluded: InterceptorEntry[] = [];

  for (const e of entries) {
    if (e.stratum === "fixture" || e.stratum === "retired") {
      excluded.push(e);
      continue;
    }
    const station = spineStationOf(e);
    if (station === null) {
      unplaced.push(e);
      continue;
    }
    // A declared point with no rendered station is reported, not filed under a
    // key nothing reads (mt#4129).
    if (!RENDERED_STATION_IDS.has(station)) {
      stationless.push(e);
      continue;
    }
    const list = placed.get(station);
    if (list) list.push(e);
    else placed.set(station, [e]);
  }

  return { placed, unplaced, stationless, excluded };
}

/** Dot-diameter bounds, exported so the component and its tests share them. */
export const MIN_DOT_PX = 8;
export const MAX_DOT_PX = 22;

/**
 * Dot diameter from window fire volume — sqrt-scaled against the population
 * maximum so area tracks volume, clamped to the readable range. Zero fires
 * (and a pending aggregates source) render at the minimum, never invisibly.
 */
export function dotSizePx(windowFires: number, maxWindowFires: number): number {
  if (windowFires <= 0 || maxWindowFires <= 0) return MIN_DOT_PX;
  const scale = Math.sqrt(Math.min(windowFires, maxWindowFires) / maxWindowFires);
  return Math.round(MIN_DOT_PX + scale * (MAX_DOT_PX - MIN_DOT_PX));
}
