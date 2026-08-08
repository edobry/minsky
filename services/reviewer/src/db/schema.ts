/**
 * Single assembled Drizzle schema for the reviewer service (mt#3498 / PR #2674 R2).
 *
 * Every consumer that constructs a Drizzle client MUST import this object
 * rather than spread-merging the per-table schema modules itself. The schema
 * was previously assembled independently in src/db/client.ts and
 * scripts/reconcile-schema.ts, and the script's copy silently drifted two
 * schemas behind — caught only when scripts/ entered typecheck coverage and
 * the narrower type failed against applyMigrations(db: ReviewerDb).
 */

import * as convergenceMetricsSchema from "./schemas/convergence-metrics-schema";
import * as webhookEventsSchema from "./schemas/webhook-events-schema";
import * as inflightReviewsSchema from "./schemas/inflight-reviews-schema";
import * as reviewTimingSchema from "./schemas/review-timing-schema";
import * as findingsSchema from "./schemas/findings-schema";

export const reviewerSchema = {
  ...convergenceMetricsSchema,
  ...webhookEventsSchema,
  ...inflightReviewsSchema,
  ...reviewTimingSchema,
  ...findingsSchema,
};
