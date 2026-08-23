/**
 * useInterceptors — the interceptor catalog (mt#4010 slice 1).
 *
 * Data source: GET /api/widget/interceptors/data — see
 * `src/cockpit/widgets/interceptors.ts` for the payload shape and
 * `scripts/build-interceptor-catalog.ts` for the generator behind it.
 *
 * The underlying artifact only changes when the repo does (a commit
 * regenerates it; a cockpit restart picks it up), so this is cached
 * aggressively and never polled — unlike the live widgets, there is no clock
 * on the other side of this fetch.
 *
 * Query key: ["interceptors", "catalog"]
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";

export type InterceptorStratum = "registry" | "standalone" | "precommit" | "retired" | "fixture";

export type InterceptorCoverageGap = "tuningOwnership" | "attentionCost" | "canary";

/**
 * Axis 1 — where in the trajectory an interceptor sits (ontology §2).
 *
 * **One of THREE copies of this union**, and they must agree: this one (the
 * cockpit-web reader), `src/cockpit/widgets/interceptors.ts` (the widget model),
 * and `.minsky/hooks/interceptor-coordinates.ts` (the resolver). The duplication
 * is structurally forced rather than sloppy — the hook tree may not import from
 * `src/` (mt#4010's generated-artifact boundary, pinned by
 * `tests/unit/hook-tree-import-boundary.test.ts`) and cockpit-web may not import
 * from `.minsky/hooks/**` (the `no-node-import-in-cockpit-web` guard, mt#3239).
 * `interceptor-points.test.ts` asserts the three stay identical, because a
 * one-sided widening is silently unenforced coverage.
 *
 * The six events after `MessageDisplay` were added by mt#4129: hooks were
 * registered at each in `.claude/settings.json` while no value could represent
 * them, so the resolver dropped them and the catalog carried neither the hook
 * nor a gap.
 */
export type InterceptionPoint =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStop"
  | "UserPromptSubmit"
  | "SessionEnd"
  | "MessageDisplay"
  | "SessionStart"
  | "StopFailure"
  | "Notification"
  | "PermissionRequest"
  | "PreCompact"
  | "PostCompact"
  | "pre-commit"
  | "merge-time";

/** Axis 2 — the eight intervention types. */
export type InterventionType =
  | "deny"
  | "allow"
  | "inject"
  | "mutate"
  | "record"
  | "notify-escalate"
  | "delegate"
  | "ask-and-pause";

export type InterventionAudience = "agent" | "principal" | "operator" | "framework" | "review";

export interface Intervention {
  type: InterventionType;
  audience?: InterventionAudience;
}

/** Axis 3 — how it decides. */
export type DecisionMechanism = "constant" | "structural" | "lexical" | "embedding" | "model";

export type InterceptorRole = "judge" | "feeder" | "infrastructure";

export type CoordinateGap = "point" | "interventions" | "mechanism" | "role";

/** Computed filters over axis 2, never stored kinds (ontology §4). */
export type InterceptorFamily = "guard" | "detector" | "injector";

/**
 * ONE discriminated value, never two booleans.
 *
 * `out-of-model` — coordinates ARE authored and land in none of the three
 * families, which is a finding about the ontology rather than missing data.
 * `unclassified` — nobody wrote the coordinates down. Rendering these two the
 * same way tells the reader a falsehood about one of them, so the UI is
 * required to keep them apart (mt#4056 SC3).
 */
export type InterceptorFamilyState = "classified" | "out-of-model" | "unclassified";

export interface InterceptorEntry {
  guardName: string;
  description: string | null;
  failureClasses: string[];
  provenance: string[];
  stratum: InterceptorStratum | null;
  subject: "trajectory" | "system";
  filenameNote?: string;
  note?: string;
  provenanceStatus: "implementation" | "declaration-only" | "none";
  coverageGaps: InterceptorCoverageGap[];
  registered: boolean;
  undescribed: boolean;
  /**
   * The implementing hook file's basename, or null when there is none BY
   * CONSTRUCTION (a pre-commit step, a retired or fixture name). The join key to
   * the install provenance the detail view renders (mt#4229).
   *
   * One of the fields this type duplicates from `src/cockpit/widgets/interceptors.ts`
   * — cockpit-web cannot import the widget module, which is why both copies exist
   * and why adding a field means adding it twice. The generator derives it; the
   * duplication is only of the SHAPE.
   */
  sourceFile: string | null;
  point: InterceptionPoint | null;
  pointSource: "registry" | "settings" | "stratum" | "authored" | "none";
  /**
   * Authored dimension-1 stratum marker (mt#4011): `"delivery"` for the merge
   * gates, null where the stratum derives from point/subject. The lifecycle
   * spine places `delivery` entries at the merge station; their `point` keeps
   * mechanism truth (PreToolUse).
   */
  trajectory: "delivery" | null;
  interventions: Intervention[];
  mechanism: DecisionMechanism | null;
  role: InterceptorRole | null;
  coordinateGaps: CoordinateGap[];
  families: InterceptorFamily[];
  familyState: InterceptorFamilyState;
  deliberatelyUnauthored: boolean;
}

export interface FailureClassDefinition {
  failure: string;
  question: string;
}

export interface InterceptorsPayload {
  population: number;
  divergence: {
    declaredButNotDescribed: string[];
    describedButNotDeclared: string[];
  };
  failureClasses: Record<string, FailureClassDefinition>;
  entries: InterceptorEntry[];
}

async function fetchInterceptors(): Promise<InterceptorsPayload> {
  const data = await fetchWidgetData("interceptors");
  if (data.state !== "ok") {
    throw new Error(`interceptors widget: ${data.reason}`);
  }
  return data.payload as InterceptorsPayload;
}

export function useInterceptors() {
  return useQuery({
    queryKey: ["interceptors", "catalog"],
    queryFn: fetchInterceptors,
    staleTime: 10 * 60_000,
  });
}

/**
 * Human-facing labels for the strata.
 *
 * `precommit` and `standalone` are the two whose bare identifiers read as
 * jargon to anyone who has not worked on the hook tree; the rest are expanded
 * for consistency rather than necessity.
 */
export const STRATUM_LABELS: Record<InterceptorStratum, string> = {
  registry: "Dispatcher registry",
  standalone: "Standalone hook",
  precommit: "Pre-commit step",
  retired: "Retired",
  fixture: "Test fixture",
};

/**
 * Display order for the strata — the live enforcement points first, then the
 * two classes that exist only because the fire log is append-only history.
 */
export const STRATUM_ORDER: InterceptorStratum[] = [
  "registry",
  "standalone",
  "precommit",
  "retired",
  "fixture",
];

export const COVERAGE_GAP_LABELS: Record<InterceptorCoverageGap, string> = {
  tuningOwnership: "no tuning owner",
  attentionCost: "no attention-cost annotation",
  canary: "no canary",
};

/**
 * Display order for axis 1 — the agent-runtime events in trajectory order,
 * then the two repo-side points.
 *
 * The agent-runtime names are the harness's own event names verbatim (identity
 * with the field, not convergence), so they are NOT prettified into sentence
 * case: a reader matching one against `.claude/settings.json` needs the exact
 * string.
 */
/**
 * A DELIBERATE SUBSET of `InterceptionPoint`, not a copy of it (mt#4129).
 *
 * This is the spine's station order — where each point sits on a turn's
 * trajectory — so it carries only points that HAVE a position there. The six
 * mt#4129 added do not: ordering `Notification` or `PreCompact` against a turn's
 * phases is a spine-design decision nobody has made, and inventing one would be
 * worse than declining. An entry at such a point lands in `spinePopulation`'s
 * `stationless` bucket, which reports it explicitly rather than dropping it.
 *
 * So do NOT "fix" this to match the union — `interceptor-points.test.ts`
 * deliberately does not assert equality here, and does assert it for the four
 * lists that must be complete.
 */
export const INTERCEPTION_POINT_ORDER: InterceptionPoint[] = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "SessionEnd",
  "MessageDisplay",
  "pre-commit",
  "merge-time",
];

export const MECHANISM_ORDER: DecisionMechanism[] = [
  "constant",
  "structural",
  "lexical",
  "embedding",
  "model",
];

export const MECHANISM_LABELS: Record<DecisionMechanism, string> = {
  constant: "constant — no classifier; always fires",
  structural: "structural — deterministic predicate over structured state",
  lexical: "lexical — pattern match over prose",
  embedding: "embedding — semantic similarity",
  model: "model — a model makes the call",
};

export const INTERVENTION_TYPE_ORDER: InterventionType[] = [
  "deny",
  "allow",
  "inject",
  "mutate",
  "record",
  "notify-escalate",
  "delegate",
  "ask-and-pause",
];

export const ROLE_ORDER: InterceptorRole[] = ["judge", "feeder", "infrastructure"];

export const ROLE_LABELS: Record<InterceptorRole, string> = {
  judge: "judge — classifies, then intervenes",
  feeder: "feeder — unconditional context provider",
  infrastructure: "infrastructure — writes state others consume",
};

export const FAMILY_ORDER: InterceptorFamily[] = ["guard", "detector", "injector"];

export const FAMILY_LABELS: Record<InterceptorFamily, string> = {
  guard: "guard — denies or allows",
  detector: "detector — records for review",
  injector: "injector — injects context",
};

/**
 * Render one intervention as `type(audience)`.
 *
 * The audience is load-bearing rather than decorative: `record(review)` is a
 * calibration detector and `record(framework)` is a state writer, and ontology
 * amendment (c) exists precisely because collapsing them under one word hid
 * the difference.
 */
export function formatIntervention(i: Intervention): string {
  return i.audience ? `${i.type}(${i.audience})` : i.type;
}

/**
 * Does this entry belong to the given computed family?
 *
 * Membership is NOT exclusive — `policy-coverage` is both a guard and a
 * detector by ontology amendment (a) — so this is a predicate over a set, not
 * an equality test against a stored kind.
 */
export function inFamily(entry: InterceptorEntry, family: InterceptorFamily): boolean {
  return entry.families.includes(family);
}
