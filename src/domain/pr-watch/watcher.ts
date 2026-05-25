/**
 * PR-Watch Reconciler — GitHub PR state polling loop.
 *
 * Polls all active PrWatch records and fires OperatorNotify when the watch
 * predicate matches. Mirrors the Ask reconciler shape (mt#1240).
 *
 * Event types:
 *   merged               — check GitHub PR merged field
 *   review-posted        — compare review IDs against lastSeen.lastReviewId
 *   check-status-changed — compare check_run conclusion against lastSeen.lastConclusion
 *
 * Per-watch errors are caught and logged; one failure does not stop the loop.
 * Notification failure does not roll back any state mutation.
 *
 * Reference: mt#1295 spec; mt#1240 reconciler for the parallel pattern.
 */

import { log } from "../../utils/logger";
import type { PrWatchRepository } from "./repository";
import type { PrWatch } from "./types";
import type { OperatorNotify } from "../notify/operator-notify";
import type { WakeSignalSink } from "../ask/wake-on-respond";
import type { EventEmitter } from "../events/emitter";

// ---------------------------------------------------------------------------
// GithubPrClient — narrow interface used by this reconciler
// ---------------------------------------------------------------------------

/** A minimal view of a GitHub pull request. */
export interface GithubPr {
  /** Whether the PR has been merged. */
  merged: boolean;
  /** PR title, used for notification bodies. */
  title: string;
}

/** A GitHub PR review summary. */
export interface GithubPrReview {
  /** Forge-assigned review ID (monotonically increasing). */
  id: number;
  /** Review state at submission time. */
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  /** Reviewer login (human or bot). */
  reviewerLogin: string | null;
}

/** A GitHub check run summary. */
export interface GithubCheckRun {
  /** Check run name. */
  name: string;
  /** Overall conclusion (null while in progress). */
  conclusion: string | null;
}

/**
 * Minimal GitHub client interface the PR-watch reconciler depends on.
 *
 * Production wiring of a real client is a follow-up (tracked separately from
 * mt#1295). Tests inject a fake that controls return values per test case.
 */
export interface GithubPrClient {
  /**
   * Fetch a single pull request by owner/repo/number.
   * Returns null when the PR does not exist.
   */
  getPr(owner: string, repo: string, prNumber: number): Promise<GithubPr | null>;

  /**
   * List all reviews for the given pull request.
   * Returns an empty array when no reviews are present.
   */
  listReviews(owner: string, repo: string, prNumber: number): Promise<GithubPrReview[]>;

  /**
   * List all check runs for the latest commit of the given pull request.
   * Returns an empty array when no checks have run.
   */
  listCheckRuns(owner: string, repo: string, prNumber: number): Promise<GithubCheckRun[]>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Outcome for a single PrWatch during a watcher pass. */
export type PrWatchOutcome =
  | { kind: "no-match"; watchId: string }
  | { kind: "fired"; watchId: string; notified: boolean }
  | { kind: "error"; watchId: string; error: string };

/** Aggregate result of a full watcher pass. */
export interface WatcherResult {
  /** Total watches inspected. */
  inspected: number;
  /** Watches that fired (predicate matched). */
  fired: number;
  /** Watches with no match this pass. */
  unchanged: number;
  /** Watches that hit errors. */
  errors: number;
  /** Per-watch outcomes. */
  outcomes: PrWatchOutcome[];
}

// ---------------------------------------------------------------------------
// Core watcher function
// ---------------------------------------------------------------------------

/**
 * Run one pass of the PR-watch reconciler.
 *
 * 1. List all active PrWatches via `prWatchRepository.listActive()`.
 * 2. For each watch, delegate to the event-specific handler.
 * 3. On match: fire `operatorNotify.bell()` + `.notify(...)`, then either
 *    `delete()` (one-shot) or `markTriggered()` (keep). Also emits a wake
 *    signal via `wakeSink` when the watch has a `parentSessionId` so the
 *    registering agent receives the firing in its conversation context.
 * 4. Collect outcomes; wrap each watch in try/catch so one failure doesn't
 *    abort the rest.
 *
 * @param prWatchRepository  PrWatch persistence interface.
 * @param githubClient       GitHub data fetching interface.
 * @param operatorNotify     Operator notification delivery.
 * @param wakeSink           Optional WakeSignalSink for agent-context delivery
 *                           (mt#1725). When provided and the watch has a
 *                           `parentSessionId`, emits a `"pr.watch"` wake so
 *                           `enrichWakeResponse` can deliver it to the
 *                           registering agent on its next allowlisted MCP call.
 * @returns                  Aggregate watcher result.
 */
export async function runWatcher(
  prWatchRepository: PrWatchRepository,
  githubClient: GithubPrClient,
  operatorNotify: OperatorNotify,
  wakeSink?: WakeSignalSink,
  eventEmitter?: EventEmitter
): Promise<WatcherResult> {
  const watches = await prWatchRepository.listActive();
  log.debug("pr-watch: inspecting watches", { count: watches.length });

  const outcomes: PrWatchOutcome[] = [];

  for (const watch of watches) {
    try {
      const outcome = await processWatch(
        watch,
        prWatchRepository,
        githubClient,
        operatorNotify,
        wakeSink,
        eventEmitter
      );
      outcomes.push(outcome);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("pr-watch: unexpected error processing watch", {
        watchId: watch.id,
        error: errMsg,
      });
      outcomes.push({ kind: "error", watchId: watch.id, error: errMsg });
    }
  }

  return {
    inspected: watches.length,
    fired: outcomes.filter((o) => o.kind === "fired").length,
    unchanged: outcomes.filter((o) => o.kind === "no-match").length,
    errors: outcomes.filter((o) => o.kind === "error").length,
    outcomes,
  };
}

// ---------------------------------------------------------------------------
// Per-watch processing
// ---------------------------------------------------------------------------

/**
 * Process a single PrWatch in the reconciler loop.
 *
 * Dispatches to the correct event handler based on `watch.event`.
 * Separated from the main loop so errors are caught cleanly per-watch.
 */
async function processWatch(
  watch: PrWatch,
  prWatchRepository: PrWatchRepository,
  githubClient: GithubPrClient,
  operatorNotify: OperatorNotify,
  wakeSink?: WakeSignalSink,
  eventEmitter?: EventEmitter
): Promise<PrWatchOutcome> {
  const { prOwner, prRepo, prNumber } = watch;

  let matched = false;
  let notifyTitle = "";
  let notifyBody = "";
  let nextLastSeen: Record<string, unknown> | undefined;
  let reviewerLogin: string | undefined;
  let reviewState: string | undefined;

  switch (watch.event) {
    case "merged": {
      const result = await handleMerged(watch, githubClient);
      matched = result.matched;
      notifyTitle = result.title;
      notifyBody = result.body;
      nextLastSeen = result.nextLastSeen;
      break;
    }
    case "review-posted": {
      const result = await handleReviewPosted(watch, githubClient, prWatchRepository);
      matched = result.matched;
      notifyTitle = result.title;
      notifyBody = result.body;
      nextLastSeen = result.nextLastSeen;
      reviewerLogin = result.reviewerLogin;
      reviewState = result.reviewState;
      break;
    }
    case "check-status-changed": {
      const result = await handleCheckStatusChanged(watch, githubClient, prWatchRepository);
      matched = result.matched;
      notifyTitle = result.title;
      notifyBody = result.body;
      nextLastSeen = result.nextLastSeen;
      break;
    }
    default: {
      // Exhaustiveness guard — new event types will cause a compile error here.
      const _exhaustive: never = watch.event;
      log.warn("pr-watch: unknown event type", { watchId: watch.id, event: _exhaustive });
      return { kind: "no-match", watchId: watch.id };
    }
  }

  if (!matched) {
    log.debug("pr-watch: no match this pass", {
      watchId: watch.id,
      event: watch.event,
      pr: `${prOwner}/${prRepo}#${prNumber}`,
    });
    return { kind: "no-match", watchId: watch.id };
  }

  log.info("pr-watch: event matched, firing notification", {
    watchId: watch.id,
    event: watch.event,
    pr: `${prOwner}/${prRepo}#${prNumber}`,
    keep: watch.keep,
  });

  // Persist the lastSeen cursor before mutating triggered state so persistent
  // watches don't re-fire on the same event in subsequent passes. Skipped for
  // the merged event which has no cursor.
  if (nextLastSeen) {
    try {
      await prWatchRepository.updateLastSeen(watch.id, nextLastSeen);
    } catch (cursorErr: unknown) {
      // Cursor-update failure is logged but not fatal: the watch will still
      // mutate triggered state below, and worst-case will re-fire on the
      // next pass (which is the prior bug, no regression).
      const errMsg = cursorErr instanceof Error ? cursorErr.message : String(cursorErr);
      log.warn("pr-watch: failed to persist lastSeen cursor", {
        watchId: watch.id,
        error: errMsg,
      });
    }
  }

  // State mutation: delete one-shot watches, markTriggered persistent ones.
  if (watch.keep) {
    await prWatchRepository.markTriggered(watch.id);
  } else {
    await prWatchRepository.delete(watch.id);
  }

  // Notification: failure here must NOT roll back the state mutation.
  let notified = false;
  try {
    operatorNotify.bell();
    operatorNotify.notify(notifyTitle, notifyBody);
    notified = true;
  } catch (notifyErr: unknown) {
    const errMsg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
    log.warn("pr-watch: notification failed (state already mutated)", {
      watchId: watch.id,
      error: errMsg,
    });
  }

  // Wake-signal delivery (mt#1725): when a parentSessionId is recorded on the
  // watch and a WakeSignalSink is wired, emit a "pr.watch" wake so the
  // registering agent receives the firing via enrichWakeResponse on its next
  // allowlisted MCP tool call. Failure is logged but NEVER rolls back state.
  if (wakeSink && watch.parentSessionId) {
    try {
      await wakeSink.emit({
        kind: "pr.watch",
        askId: watch.id,
        parentSessionId: watch.parentSessionId,
        reviewBody: notifyBody,
        reviewState: watch.event,
        reviewAuthor: watch.watcherId,
        prNumber: watch.prNumber,
      });
      log.debug("pr-watch: wake signal emitted", {
        watchId: watch.id,
        parentSessionId: watch.parentSessionId,
      });
    } catch (wakeErr: unknown) {
      const errMsg = wakeErr instanceof Error ? wakeErr.message : String(wakeErr);
      log.warn("pr-watch: wake signal emission failed (state already mutated)", {
        watchId: watch.id,
        parentSessionId: watch.parentSessionId,
        error: errMsg,
      });
    }
  } else if (wakeSink && !watch.parentSessionId) {
    // No parentSessionId — this watch was registered without a session context
    // (legacy row or context-less registration). Telemetered here; the delivery
    // surface uses the same tag so operators can grep across both paths.
    log.cli(
      `pr_watch.no_session_id ${JSON.stringify({
        event: "pr_watch.no_session_id",
        watchId: watch.id,
        reason: "parentSessionId absent on fired watch",
      })}`
    );
  }

  // Event emission for review-posted (mt#2095): best-effort, never throws.
  if (eventEmitter && watch.event === "review-posted") {
    try {
      await eventEmitter.emit({
        eventType: "pr.review_posted",
        payload: {
          prNumber: watch.prNumber,
          repo: `${watch.prOwner}/${watch.prRepo}`,
          reviewer: reviewerLogin ?? "unknown",
          state: reviewState ?? "posted",
        },
        relatedTaskId: ((watch.metadata as Record<string, unknown>)?.taskId as string) ?? undefined,
      });
    } catch {
      // Best-effort: swallow any unexpected errors from emit
    }
  }

  return { kind: "fired", watchId: watch.id, notified };
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

interface EventHandlerResult {
  matched: boolean;
  title: string;
  body: string;
  /**
   * If matched, the new lastSeen cursor to persist. Used to dedup persistent
   * watches across passes. Omitted by handlers (like `merged`) that don't
   * need a cursor.
   */
  nextLastSeen?: Record<string, unknown>;
  /** Structured review data for event emission (review-posted only). */
  reviewerLogin?: string;
  /** Review state for event emission (review-posted only). */
  reviewState?: string;
}

/**
 * Handle the `merged` event: check whether the PR has been merged.
 */
async function handleMerged(
  watch: PrWatch,
  githubClient: GithubPrClient
): Promise<EventHandlerResult> {
  const pr = await githubClient.getPr(watch.prOwner, watch.prRepo, watch.prNumber);
  if (!pr) {
    log.debug("pr-watch: PR not found", {
      watchId: watch.id,
      pr: `${watch.prOwner}/${watch.prRepo}#${watch.prNumber}`,
    });
    return { matched: false, title: "", body: "" };
  }

  if (!pr.merged) {
    return { matched: false, title: "", body: "" };
  }

  return {
    matched: true,
    title: "Minsky: PR merged",
    body: `PR #${watch.prNumber} — ${pr.title}`,
  };
}

/**
 * Handle the `review-posted` event: check for new reviews since `lastSeen.lastReviewId`.
 *
 * On match, updates `lastSeen.lastReviewId` in the repository so subsequent
 * passes don't re-fire on the same review.
 */
async function handleReviewPosted(
  watch: PrWatch,
  githubClient: GithubPrClient,
  _repo: PrWatchRepository
): Promise<EventHandlerResult> {
  const reviews = await githubClient.listReviews(watch.prOwner, watch.prRepo, watch.prNumber);

  const lastReviewId =
    typeof watch.lastSeen?.lastReviewId === "number" ? watch.lastSeen.lastReviewId : 0;

  const newReviews = reviews.filter((r) => r.id > lastReviewId);

  if (newReviews.length === 0) {
    return { matched: false, title: "", body: "" };
  }

  // Pick the review with the highest ID (most recent).
  newReviews.sort((a, b) => b.id - a.id);
  const latest = newReviews[0];
  if (!latest) {
    // Unreachable: guarded by `newReviews.length === 0` check above, but the
    // type system can't prove that after the sort.
    return { matched: false, title: "", body: "" };
  }

  return {
    matched: true,
    title: "Minsky: PR review posted",
    body: `PR #${watch.prNumber} — ${latest.state} by ${latest.reviewerLogin ?? "unknown"}`,
    nextLastSeen: { lastReviewId: latest.id },
    reviewerLogin: latest.reviewerLogin ?? undefined,
    reviewState: latest.state,
  };
}

/**
 * Handle the `check-status-changed` event: compare overall conclusion against
 * `lastSeen.lastConclusion`.
 *
 * Fires when the overall conclusion (derived from all check runs) differs from
 * the last-seen value and is not `"pending"` or `"unknown"`. The persisted
 * `lastConclusion` value is always one of: `"success"`, `"failure"`,
 * `"neutral"`, `"cancelled"`, `"action_required"`, or `"stale"`.
 *
 * Note on flattening: `timed_out` check-run conclusions are folded into
 * `"failure"` by `deriveOverallConclusion`, so `"timed_out"` never surfaces
 * here. Similarly, `skipped` runs contribute to `"success"` or `"neutral"`
 * aggregates and never appear as a standalone stored conclusion.
 *
 * See `deriveOverallConclusion` for full aggregation precedence rules.
 */
async function handleCheckStatusChanged(
  watch: PrWatch,
  githubClient: GithubPrClient,
  _repo: PrWatchRepository
): Promise<EventHandlerResult> {
  const checkRuns = await githubClient.listCheckRuns(watch.prOwner, watch.prRepo, watch.prNumber);

  const currentConclusion = deriveOverallConclusion(checkRuns);

  const lastConclusion =
    typeof watch.lastSeen?.lastConclusion === "string" ? watch.lastSeen.lastConclusion : null;

  if (currentConclusion === lastConclusion) {
    return { matched: false, title: "", body: "" };
  }

  // No checks yet, or checks still pending — not a real conclusion change.
  if (currentConclusion === "pending" || currentConclusion === "unknown") {
    return { matched: false, title: "", body: "" };
  }

  return {
    matched: true,
    title: "Minsky: PR check status changed",
    body: `PR #${watch.prNumber} — checks: ${currentConclusion}`,
    nextLastSeen: { lastConclusion: currentConclusion },
  };
}

/**
 * Derive a single overall conclusion string from a list of check runs.
 *
 * Handles the full GitHub Checks API `check_run.conclusion` enum. `stale`
 * entries are filtered out before aggregation — a stale result means "a
 * re-run was triggered and this result is invalidated"; only the fresh runs
 * should determine the overall conclusion. Conclusions among the remaining
 * (fresh) runs are aggregated by precedence (highest priority first):
 *
 *  1. No runs present → `"unknown"`
 *  2. Any `null` conclusion  → `"pending"` (still in progress)
 *  3. Filter stale entries. If only stale entries remain → `"stale"`.
 *  4. Any `failure` or `timed_out` among fresh runs → `"failure"`
 *     (`timed_out` is flattened to `failure`; it is never stored as-is)
 *  5. Any `cancelled` among fresh runs → `"cancelled"`
 *  6. Any `action_required` among fresh runs → `"action_required"`
 *  7. All fresh runs are `success` or `skipped` → `"success"`
 *     (`skipped` contributes to success; it is never stored as-is)
 *  8. All fresh runs are `neutral` (or mix of neutral/success/skipped) → `"neutral"`
 *  9. Anything else → `"unknown"`
 *
 * The filter in `handleCheckStatusChanged` only fires on state changes where the
 * current conclusion is not `"pending"` or `"unknown"`. All other conclusions
 * (including `cancelled`, `neutral`, `action_required`, `stale`) do fire.
 */
function deriveOverallConclusion(checkRuns: GithubCheckRun[]): string {
  if (checkRuns.length === 0) return "unknown";

  const conclusions = checkRuns.map((r) => r.conclusion);

  // Rule 2: any null → pending (still in progress)
  if (conclusions.some((c) => c === null)) return "pending";

  // Rule 3: filter stale entries — stale means the result is invalidated by a re-run.
  // Fresh runs determine the overall conclusion.
  const fresh = conclusions.filter((c) => c !== "stale");
  if (fresh.length === 0) return "stale"; // all entries were stale

  // Rule 4: any failure or timed_out → failure (timed_out is flattened to failure)
  if (fresh.some((c) => c === "failure" || c === "timed_out")) return "failure";

  // Rule 5: any cancelled → cancelled
  if (fresh.some((c) => c === "cancelled")) return "cancelled";

  // Rule 6: any action_required → action_required
  if (fresh.some((c) => c === "action_required")) return "action_required";

  // Rule 7: all success or skipped → success (skipped contributes to success)
  if (fresh.every((c) => c === "success" || c === "skipped")) return "success";

  // Rule 8: all neutral (or mix of neutral with success/skipped) → neutral
  if (fresh.every((c) => c === "neutral" || c === "success" || c === "skipped")) {
    return "neutral";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Stub GithubPrClient — v1 placeholder; production wiring is a follow-up
// ---------------------------------------------------------------------------

/**
 * Stub `GithubPrClient` used until the production GitHub client is wired.
 *
 * Returns empty/null responses and logs a warning so operators understand
 * why no watches fire. Production wiring is a follow-up to mt#1295.
 */
export const stubGithubPrClient: GithubPrClient = {
  async getPr(_owner: string, _repo: string, _prNumber: number): Promise<GithubPr | null> {
    log.warn(
      "pr-watch: no GithubPrClient wired (production wiring is a follow-up to mt#1295); returning null"
    );
    return null;
  },
  async listReviews(_owner: string, _repo: string, _prNumber: number): Promise<GithubPrReview[]> {
    log.warn(
      "pr-watch: no GithubPrClient wired (production wiring is a follow-up to mt#1295); returning empty reviews"
    );
    return [];
  },
  async listCheckRuns(_owner: string, _repo: string, _prNumber: number): Promise<GithubCheckRun[]> {
    log.warn(
      "pr-watch: no GithubPrClient wired (production wiring is a follow-up to mt#1295); returning empty check runs"
    );
    return [];
  },
};
