/**
 * Interceptor state + attention-count derivation (mt#4057, `/interceptors` slice 2).
 *
 * The pure half of the health column. Slice 1 rendered no health at all
 * (mt#4010 §Slicing decision: absent rather than stubbed, because a
 * placeholder reads as a value); this is what replaces that absence.
 *
 * WHY THIS IS NOT A FIRE-COUNT HEURISTIC. mt#3754 SC4 requires the quiet
 * states to be canary-backed and "never inferred from fire count alone". The
 * canary vocabulary is three-valued — `never-verified` / `passing` / `broken`
 * (`../observability/guard-canary-history.ts`) — so it alone decides whether an
 * interceptor WORKS. Fire history is consulted only AFTER the canary has
 * already established that it works, and only to split that population into
 * deterrent (it has fired before and is quiet now) and dormant (its condition
 * has never arisen). No path here lets a fire count produce or suppress a
 * broken verdict.
 *
 * ABSENT SOURCES STAY ABSENT. A null `canary` section means the canary source
 * failed THIS refresh (mt#2758 convention: named in the snapshot's
 * `sourceFailures`), which is a different fact from `never-verified` and is
 * rendered as its own kind rather than folded into either a healthy or a quiet
 * state. Same for the attention counts: a failed source yields `null`, never
 * `0` — a zero would read as "nothing needs attention", which is the exact
 * conflation this umbrella exists to prevent.
 *
 * @see mt#4057 §State derivation — the spec table this implements
 * @see ./aggregates.ts — the snapshot shape consumed here
 */
import type { InterceptorAggregateRow, InterceptorAggregatesSnapshot } from "./aggregates";

/**
 * The rendered health states.
 *
 * `canary-unavailable` is deliberately a STATE KIND rather than a null return:
 * every caller has to decide how to show it, and an optional return type lets a
 * caller forget.
 */
export type InterceptorStateKind =
  | "broken"
  | "never-verified"
  | "active"
  | "deterrent"
  | "dormant"
  | "canary-unavailable";

export interface InterceptorState {
  kind: InterceptorStateKind;
  /** Fires inside the snapshot's window. */
  windowFires: number;
  /** All-time fires — what separates deterrent from dormant. */
  lifetimeFires: number;
  /** Set only for `broken`: when the canary first failed. */
  brokenSinceAt: string | null;
  /** Set only for the canary-passing kinds: when it last passed. */
  lastVerifiedAt: string | null;
  lastFireAt: string | null;
}

/**
 * Read an ISO-8601 string off the canary join.
 *
 * `CanaryStatusJoin` is a STRUCTURAL mirror with an index signature, so its
 * real fields arrive typed as `unknown`; this narrows without asserting. A
 * non-string (or an absent field) degrades to null rather than throwing — the
 * state kind is still correct without its timestamp, and a crash in a
 * render-path derivation would take the whole catalog down.
 */
function readIsoField(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === "string" && value !== "" ? value : null;
}

export function deriveInterceptorState(row: InterceptorAggregateRow): InterceptorState {
  const windowFires = row.fireLog.window.fires;
  const lifetimeFires = row.fireLog.lifetime.totalFires;
  const base = {
    windowFires,
    lifetimeFires,
    brokenSinceAt: null,
    lastVerifiedAt: null,
    lastFireAt: row.fireLog.lifetime.lastFireAt,
  };

  if (row.canary === null) return { ...base, kind: "canary-unavailable" };

  if (row.canary.state === "broken") {
    return { ...base, kind: "broken", brokenSinceAt: readIsoField(row.canary, "brokenSinceAt") };
  }

  // Anything that is neither `broken` nor `passing` is unverified. An
  // UNRECOGNIZED value lands here too, deliberately: a vocabulary this code
  // does not know must not be read as evidence that the interceptor works.
  if (row.canary.state !== "passing") return { ...base, kind: "never-verified" };

  const lastVerifiedAt = readIsoField(row.canary, "lastVerifiedAt");
  if (windowFires > 0) return { ...base, kind: "active", lastVerifiedAt };
  if (lifetimeFires > 0) return { ...base, kind: "deterrent", lastVerifiedAt };
  return { ...base, kind: "dormant", lastVerifiedAt };
}

/**
 * Which review-due reasons mean "a graduation deadline passed" rather than
 * "new evidence accumulated".
 *
 * `computeReviewDueLogs` (`src/domain/calibration/calibration-sweep.ts`) emits
 * four reasons across two mechanisms. `past-threshold` and `time-stale` are
 * EVIDENCE-driven: enough new fires (with enough phrase diversity), or a stale
 * prior review with new fires since. `never-reviewed` and `never-fired` are
 * DEADLINE-driven: both compare an age against the log's `reviewByDays`
 * graduation contract, so both mean the same thing — we said we would decide
 * about this detector by a date, and that date has passed with no disposition.
 * That is what mt#3754 SC1 calls graduation-overdue.
 */
export const GRADUATION_OVERDUE_REASONS: readonly string[] = ["never-reviewed", "never-fired"];

export function isGraduationOverdue(reason: string): boolean {
  return GRADUATION_OVERDUE_REASONS.includes(reason);
}

/**
 * The four above-the-fold counts (mt#3754 SC1).
 *
 * `null` means the source that answers this count failed on the snapshot's
 * last refresh — the caller must render that differently from zero.
 */
export interface AttentionCounts {
  /** Canary-broken. Null when the canary source failed. */
  broken: number | null;
  /** Canary never ran. Null when the canary source failed. */
  neverVerified: number | null;
  /** Calibration logs due on accumulated evidence. Null when the calibration source failed. */
  reviewDue: number | null;
  /** Calibration logs past their graduation deadline. Null when the calibration source failed. */
  graduationOverdue: number | null;
}

/**
 * Every row the snapshot carries — the fire-log population plus the declared
 * names that have never fired (mt#4057).
 *
 * The two are stored separately because `population` is contractually the
 * fire-log count, but for HEALTH they are one corpus: a never-fired
 * interceptor is as capable of being broken as a busy one, and counting only
 * `rows` would silently exclude exactly the guards nobody is watching.
 */
export function allAggregateRows(
  snapshot: Pick<InterceptorAggregatesSnapshot, "rows" | "declaredOnlyRows">
): InterceptorAggregateRow[] {
  return [...snapshot.rows, ...snapshot.declaredOnlyRows];
}

export function computeAttentionCounts(
  snapshot: Pick<
    InterceptorAggregatesSnapshot,
    "rows" | "declaredOnlyRows" | "calibrationReviewDue" | "sourceFailures"
  >
): AttentionCounts {
  const canaryFailed = snapshot.sourceFailures.includes("canary");
  // `calibrationReviewDue` defaults to `[]` when the sweep failed
  // (`assembleInterceptorAggregates`), so an empty list is ambiguous on its
  // own — `sourceFailures` is the only thing that disambiguates it.
  const calibrationFailed = snapshot.sourceFailures.includes("calibration");

  let broken = 0;
  let neverVerified = 0;
  for (const row of allAggregateRows(snapshot)) {
    const state = deriveInterceptorState(row);
    if (state.kind === "broken") broken += 1;
    else if (state.kind === "never-verified") neverVerified += 1;
  }

  let reviewDue = 0;
  let graduationOverdue = 0;
  for (const due of snapshot.calibrationReviewDue) {
    if (isGraduationOverdue(due.reason)) graduationOverdue += 1;
    else reviewDue += 1;
  }

  return {
    broken: canaryFailed ? null : broken,
    neverVerified: canaryFailed ? null : neverVerified,
    reviewDue: calibrationFailed ? null : reviewDue,
    graduationOverdue: calibrationFailed ? null : graduationOverdue,
  };
}

/**
 * Total wall-clock the interceptor spent inside the window, and the fires that
 * figure was measured over.
 *
 * `measuredFires` is NOT the same as the window's fire count: only records
 * carrying a `duration_ms` reach the duration aggregate, so a guard can have
 * 400 fires and 12 measured ones. Returning the denominator beside the figure
 * is what makes the rendered cost traceable rather than merely plausible
 * (mt#3754 SC6) — the UI must show both.
 */
export interface InterceptorCost {
  totalMs: number;
  avgMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  measuredFires: number;
  /** Fires in the window that carried NO duration, so are outside the figure. */
  unmeasuredFires: number;
}

export function deriveInterceptorCost(row: InterceptorAggregateRow): InterceptorCost | null {
  const duration = row.fireLog.window.duration;
  if (!duration) return null;
  return {
    totalMs: duration.totalMs,
    avgMs: duration.avgMs,
    p95Ms: duration.p95Ms,
    maxMs: duration.maxMs,
    measuredFires: duration.measuredFires,
    unmeasuredFires: Math.max(0, row.fireLog.window.fires - duration.measuredFires),
  };
}
