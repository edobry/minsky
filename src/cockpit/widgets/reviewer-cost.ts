/**
 * Reviewer cost widget (mt#4557).
 *
 * Backs the "/reviewer/cost" cockpit page: "where is the reviewer's money
 * going?" — a 30-day stacked-by-token-class spend chart with a $/review line
 * overlaid, a per-config cohort table, a cap-pin share, and an outlier tail
 * of the ten most expensive reviews in the window.
 *
 * Payload types and the `NOT_YET_WIRED_REASON_PREFIX` constant live in
 * ./reviewer-cost-contract.ts (re-exported below) — that module is
 * DELIBERATELY dependency-free so the CLIENT-side hook
 * (../web/hooks/useReviewerCost.ts) can import it without pulling this
 * SERVER-only module's Node dependencies (db-providers.ts ->
 * @minsky/domain/persistence) into the browser bundle. See that module's
 * docblock for the mt#3348 R2 incident this split fixes ("process is not
 * defined" crashing the page at runtime, invisible to component tests).
 *
 * ---------------------------------------------------------------------------
 * BLOCKED on mt#4546 (2026-08-25) — read this before touching `fetch()` below
 * ---------------------------------------------------------------------------
 * mt#4557's own SC3 requires this page to read through mt#4546's domain-side
 * `review_timing` accessor, with NO second query layer — the two must not be
 * able to drift. mt#4546 has not landed (its session was created and never
 * touched again; no accessor/command code exists anywhere in the repo as of
 * this writing). Filed as ask#10301 (routed to the operator).
 *
 * So `fetch()` below deliberately does NOT query `review_timing` — doing so
 * would stand up exactly the parallel query layer SC3 forbids. It returns an
 * explicit `degraded` state instead, which is the same "explicit error, never
 * a rendered zero" contract this widget will need anyway once wired (mt#2757:
 * this exact corner of the cockpit rendered healthy zeros for five weeks while
 * every underlying query failed).
 *
 * TO WIRE ONCE mt#4546 SHIPS: replace the body of the `try` block with a call
 * into mt#4546's accessor, build a `ReviewerCostPayload` from its result, and
 * return `{ state: "ok", payload }`. Leave the surrounding try/catch — any
 * accessor failure (stale connection, query error) will then convert into a
 * `degraded` state via `describeWidgetDegradedReason`, exactly like every
 * other DB-backed cockpit widget.
 *
 * ---------------------------------------------------------------------------
 * Domain semantics this module's types encode (mapped from investigation of
 * services/reviewer/src/db/schemas/review-timing-schema.ts and its callers —
 * useful groundwork for whoever wires mt#4546's accessor to this shape):
 * ---------------------------------------------------------------------------
 *  - R1 vs R>=2 split: `iterationIndex` is 1-based for real reviews (R1 = 1,
 *    R>=2 = everything else). `iterationIndex === 0` is reserved for the two
 *    pre-model skip-path rows and must be EXCLUDED, not treated as R1
 *    (mem#800; services/reviewer/src/review-finalize.ts, convergence-detector.ts).
 *  - Cap-pin share: the reviewer's tool-use loop caps at
 *    `MAX_TOOL_ROUNDS = 10` (services/reviewer/src/providers.ts:430). A review
 *    that hit the cap has `array_length(per_round_latencies_ms, 1) = 10`. No
 *    richer cap-hit signal is persisted to `review_timing` today.
 *  - Per-config cohort key: `configFingerprint` (mt#4556, shipped) — a
 *    readable `v1;k=v;k=v...` string encoding provider, model, effort, tier2,
 *    toolloop_retry, and six behavioral flags (config-fingerprint.ts). NULL on
 *    pre-mt#4556 rows and must render as "unknown configuration", never a
 *    default (per the schema's own doc comment) — never grouped with a
 *    populated fingerprint.
 *  - Reasoning share: `reasoningTokens` is a SUBSET of `outputTokens`, not a
 *    fourth token class — the spec's "reasoning marked as a share of output"
 *    requirement.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { describeWidgetDegradedReason } from "../db-providers";
import { NOT_YET_WIRED_REASON_PREFIX } from "./reviewer-cost-contract";

export type {
  ReviewerCostDailyBucket,
  ReviewerCostCohortRow,
  ReviewerCostOutlierEntry,
  ReviewerCostPayload,
} from "./reviewer-cost-contract";
export { NOT_YET_WIRED_REASON_PREFIX } from "./reviewer-cost-contract";

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

/** Tracking ref for the blocking coordination ask — surfaced in the degraded
 * reason string so an operator reading the cockpit sees where to look. */
const BLOCKING_ASK_REF = "ask#10301";

export const reviewerCostWidget: WidgetModule = {
  id: "reviewer-cost",
  title: "Reviewer Cost",
  updateMode: { type: "polling", intervalMs: 60_000 },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    try {
      // See the module docblock above — this branch is the mt#4546
      // coordination blocker, not a placeholder for convenience. Do not
      // replace it with a direct review_timing query; replace it with a call
      // into mt#4546's accessor once that exists.
      return {
        state: "degraded",
        reason:
          `${NOT_YET_WIRED_REASON_PREFIX} (review_timing accessor not yet ` +
          `implemented — see ${BLOCKING_ASK_REF})`,
      };
    } catch (err) {
      return { state: "degraded", reason: describeWidgetDegradedReason("reviewer-cost", err) };
    }
  },
};
