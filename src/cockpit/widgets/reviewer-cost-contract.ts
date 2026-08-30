/**
 * reviewer-cost's isomorphic contract — types + constants shared between the
 * SERVER-side widget (./reviewer-cost.ts, which imports Node-only modules
 * like db-providers.ts) and the CLIENT-side hook
 * (../web/hooks/useReviewerCost.ts, which runs in the browser bundle).
 *
 * Deliberately zero imports. mt#3348 R2 (post-review-fix regression): the
 * hook originally did `import { NOT_YET_WIRED_REASON_PREFIX } from
 * "../../widgets/reviewer-cost"` — a VALUE import, not `import type` — which
 * pulled the widget module's entire dependency graph (db-providers.ts ->
 * @minsky/domain/persistence -> process.env and other Node-only globals)
 * into the Vite client bundle, crashing the page with "process is not
 * defined" the moment it rendered (caught by a fresh screenshot after the
 * R1 fix, not by the component tests — bun's test DOM has `process` defined,
 * a real browser doesn't). `driven-session-cost.ts`'s sibling hook avoided
 * this only because it never imported a VALUE from its widget module, just
 * `import type`. Any future constant/helper both sides need should live
 * HERE, not be value-imported across the server/client boundary.
 */

/** One day's spend, split by token class, in the 30-day stacked chart. */
export interface ReviewerCostDailyBucket {
  /** UTC calendar date, "YYYY-MM-DD". */
  date: string;
  uncachedInputCostUsd: number;
  cachedInputCostUsd: number;
  /** Total output cost — INCLUDES reasoningCostUsd (a share, not a 4th class). */
  outputCostUsd: number;
  /** Subset of outputCostUsd attributable to reasoning tokens. */
  reasoningCostUsd: number;
  reviewCount: number;
  /** The $/review line overlay. Null when reviewCount is 0 for the day. */
  costPerReviewUsd: number | null;
}

/** One row of the per-config cohort table. */
export interface ReviewerCostCohortRow {
  /** Raw config-fingerprint string, or null for pre-mt#4556 rows (render as
   * "unknown configuration" — never grouped with a populated fingerprint). */
  configFingerprint: string | null;
  reviewCount: number;
  costPerReviewMedianUsd: number | null;
  costPerReviewP90Usd: number | null;
  /** cached_tokens / input_tokens, aggregated over the cohort. Null when no
   * priced rows are present. */
  cacheHitRatio: number | null;
  /** Share of this cohort's reviews that hit the 10-round tool-use cap. */
  capPinShare: number;
  /** iterationIndex === 1 (index-0 skip-path rows excluded per mem#800). */
  r1Count: number;
  /** iterationIndex >= 2. */
  r2PlusCount: number;
}

/** One entry in the ten-most-expensive-reviews outlier tail. */
export interface ReviewerCostOutlierEntry {
  reviewTimingId: string;
  prOwner: string;
  prRepo: string;
  prNumber: number;
  costUsd: number;
  configFingerprint: string | null;
  createdAt: string;
}

export type ReviewerCostPayload =
  | { status: "no-data" }
  | {
      status: "ok";
      windowStart: string;
      windowEnd: string;
      dailyBuckets: ReviewerCostDailyBucket[];
      cohorts: ReviewerCostCohortRow[];
      /** Overall cap-pin share across the full window (not per-cohort) — the
       * single prominent number SC1 asks for. */
      capPinShareOverall: number;
      /** Exactly the ten most expensive reviews in the window (fewer if the
       * window has fewer than ten priced reviews). */
      outlierTail: ReviewerCostOutlierEntry[];
    };

/**
 * Stable, matchable prefix for the "mt#4546 not wired yet" degraded reason —
 * lets the frontend hook tell this KNOWN, expected-until-mt#4546-lands state
 * apart from a genuine LIVE query failure once the accessor is wired
 * (mt#3348 R1, reviewer-bot BLOCKING finding). Both are `degraded` at the
 * WidgetData layer (accurate — the data genuinely isn't available either
 * way), but the REASON text is the distinguishing signal, and this constant
 * is the single place that contract is defined.
 */
export const NOT_YET_WIRED_REASON_PREFIX = "reviewer-cost: blocked on mt#4546";
