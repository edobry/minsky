/**
 * Local reviewer-bot watcher — barrel.
 *
 * mt#1310 (Option A — local watcher) — see `types.ts` for the full module
 * description.
 */

export type {
  MissingReviewPR,
  MissedReviewReason,
  ReviewerWatchCycleResult,
  ReviewerWatchConfig,
} from "./types";

export { REASON_NO_REVIEW_BY_BOT, REASON_COMMIT_ID_MISMATCH } from "./types";

export {
  detectMissingReviewForPR,
  detectMissingReviews,
  type MissedReviewClient,
  type OpenPR,
  type PRReviewSummary,
} from "./detector";

export { MissedReviewDedupState, missedReviewKey, type MissedReviewKey } from "./dedup";

export { runReviewerWatchCycle, formatAlertBody, formatAlertTitle } from "./watcher";
