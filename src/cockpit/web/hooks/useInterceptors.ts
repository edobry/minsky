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

/** Axis 1 — where in the trajectory an interceptor sits (ontology §2). */
export type InterceptionPoint =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStop"
  | "UserPromptSubmit"
  | "SessionEnd"
  | "MessageDisplay"
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
  point: InterceptionPoint | null;
  pointSource: "registry" | "settings" | "stratum" | "authored" | "none";
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
