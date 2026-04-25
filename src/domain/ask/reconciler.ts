/**
 * Ask Reconciler — GitHub PR review polling loop.
 *
 * Reconciles open `quality.review` Asks (in state `routed` or `suspended`) by
 * checking GitHub for new reviews. When a new review is found (review id >
 * `metadata.lastReviewId`), the Ask is transitioned to `responded` via
 * `askRepository.respond()` and the operator is notified.
 *
 * Errors for individual Asks are caught and logged; one failure does not stop
 * the overall loop.
 *
 * Reference: mt#1240 spec.
 */

import { log } from "../../utils/logger";
import type { AskRepository } from "./repository";
import type { Ask, AskState } from "./types";
import type { OperatorNotify } from "../notify/operator-notify";

// ---------------------------------------------------------------------------
// GitHub client interface — narrow projection used by the reconciler.
// ---------------------------------------------------------------------------

/**
 * A narrow view of a GitHub PR review as needed by the reconciler.
 */
export interface GithubReview {
  /** Forge-assigned review ID. */
  reviewId: number;
  /** Review verdict at submission time. */
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  /** Reviewer login (human or bot). */
  reviewerLogin: string | null;
  /** Review body. */
  body: string;
}

/**
 * Minimal GitHub client interface the reconciler depends on.
 *
 * The real implementation delegates to `listReviews` in
 * `src/domain/repository/github-pr-review.ts`. Tests inject a fake.
 */
export interface GithubReviewClient {
  /**
   * List all reviews for the given PR (owner/repo + number).
   * Returns an empty array when no reviews are present.
   */
  listReviews(owner: string, repo: string, prNumber: number): Promise<GithubReview[]>;
}

// ---------------------------------------------------------------------------
// PR contextRef parsing helpers
// ---------------------------------------------------------------------------

/**
 * Expected format for a PR contextRef: `github-pr:<owner>/<repo>/<pr-number>`
 */
const PR_REF_PATTERN = /^github-pr:([^/]+)\/([^/]+)\/(\d+)$/;

interface ParsedPrRef {
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * Parse a `github-pr` contextRef into owner/repo/prNumber.
 * Returns `null` when the ref does not match the expected format.
 */
export function parsePrRef(ref: string): ParsedPrRef | null {
  const match = PR_REF_PATTERN.exec(ref);
  if (!match) return null;
  const ownerPart = match[1];
  const repoPart = match[2];
  const prNumberStr = match[3];
  if (!ownerPart || !repoPart || !prNumberStr) return null;
  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber)) return null;
  return { owner: ownerPart, repo: repoPart, prNumber };
}

/**
 * Find the first `github-pr` contextRef on an Ask.
 * Returns `null` if no such ref is present.
 */
export function findPrRef(ask: Ask): ParsedPrRef | null {
  if (!ask.contextRefs) return null;
  for (const ref of ask.contextRefs) {
    if (ref.kind === "github-pr") {
      const parsed = parsePrRef(ref.ref);
      if (parsed) return parsed;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reconciler result types
// ---------------------------------------------------------------------------

/** Outcome for a single Ask during a reconcile pass. */
export type AskReconcileOutcome =
  | { kind: "skipped"; askId: string; reason: string }
  | { kind: "no-new-reviews"; askId: string }
  | { kind: "responded"; askId: string; reviewId: number; notified: boolean }
  | { kind: "error"; askId: string; error: string };

/** Aggregate result of a full reconcile pass. */
export interface ReconcileResult {
  /** Number of open quality.review Asks inspected. */
  inspected: number;
  /** Asks that were transitioned to responded. */
  responded: number;
  /** Asks that had no new reviews. */
  unchanged: number;
  /** Asks that were skipped (no PR contextRef, etc.). */
  skipped: number;
  /** Asks that hit errors. */
  errors: number;
  /** Per-Ask outcomes. */
  outcomes: AskReconcileOutcome[];
}

// ---------------------------------------------------------------------------
// Core reconcile function
// ---------------------------------------------------------------------------

/**
 * Truncate a string to at most `max` characters, appending "…" when truncated.
 */
function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max)}...`;
}

/**
 * Run one pass of the reconciler.
 *
 * 1. List all `quality.review` Asks in state `routed` or `suspended`.
 * 2. For each, find the PR contextRef.
 * 3. Query GitHub reviews.
 * 4. If a new review (id > `metadata.lastReviewId`) is found, call
 *    `askRepository.respond()` and fire `operatorNotify`.
 * 5. Collect outcomes; wrap each Ask in try/catch so one failure doesn't
 *    abort the rest.
 *
 * @param askRepository  Ask persistence interface.
 * @param githubClient   GitHub review fetching interface.
 * @param operatorNotify Operator notification delivery.
 * @returns              Aggregate reconcile result.
 */
export async function reconcile(
  askRepository: AskRepository,
  githubClient: GithubReviewClient,
  operatorNotify: OperatorNotify
): Promise<ReconcileResult> {
  // Gather all open quality.review Asks across non-terminal pre-responded states.
  // v1 short-circuit: mt#1069 (router) does not yet exist, so detected/classified
  // Asks won't otherwise advance. The reconciler walks them through to suspended
  // before recording a response.
  const [detectedAsks, classifiedAsks, routedAsks, suspendedAsks] = await Promise.all([
    askRepository.listByState("detected"),
    askRepository.listByState("classified"),
    askRepository.listByState("routed"),
    askRepository.listByState("suspended"),
  ]);

  const candidates = [...detectedAsks, ...classifiedAsks, ...routedAsks, ...suspendedAsks].filter(
    (a) => a.kind === "quality.review"
  );

  log.debug("reconcile: inspecting asks", { count: candidates.length });

  const outcomes: AskReconcileOutcome[] = [];

  for (const ask of candidates) {
    try {
      const outcome = await reconcileAsk(ask, askRepository, githubClient, operatorNotify);
      outcomes.push(outcome);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("reconcile: unexpected error processing ask", { askId: ask.id, error: errMsg });
      outcomes.push({ kind: "error", askId: ask.id, error: errMsg });
    }
  }

  return {
    inspected: candidates.length,
    responded: outcomes.filter((o) => o.kind === "responded").length,
    unchanged: outcomes.filter((o) => o.kind === "no-new-reviews").length,
    skipped: outcomes.filter((o) => o.kind === "skipped").length,
    errors: outcomes.filter((o) => o.kind === "error").length,
    outcomes,
  };
}

/**
 * Walk an Ask through the lifecycle to `suspended`, calling
 * `askRepository.transition()` for each intermediate hop.
 *
 * Used before recording a response on Asks that are still in early lifecycle
 * states (detected/classified/routed). v1 short-circuit; mt#1069 (router) will
 * own these intermediate transitions in the steady-state design.
 */
async function walkToSuspended(askRepository: AskRepository, ask: Ask): Promise<void> {
  const next: Partial<Record<AskState, AskState>> = {
    detected: "classified",
    classified: "routed",
    routed: "suspended",
  };

  let currentState: AskState = ask.state;
  while (currentState !== "suspended") {
    const target = next[currentState];
    if (!target) break;
    await askRepository.transition(ask.id, target);
    currentState = target;
  }
}

/**
 * Process a single Ask in the reconcile loop.
 *
 * Separated from the main loop so errors here are caught cleanly in the
 * per-Ask try/catch.
 */
async function reconcileAsk(
  ask: Ask,
  askRepository: AskRepository,
  githubClient: GithubReviewClient,
  operatorNotify: OperatorNotify
): Promise<AskReconcileOutcome> {
  // Find the github-pr contextRef.
  const prRef = findPrRef(ask);
  if (!prRef) {
    log.debug("reconcile: ask has no github-pr contextRef, skipping", { askId: ask.id });
    return { kind: "skipped", askId: ask.id, reason: "no github-pr contextRef" };
  }

  const { owner, repo, prNumber } = prRef;

  // Determine the last-seen review ID (0 = never seen any).
  const lastReviewId =
    typeof ask.metadata.lastReviewId === "number" ? ask.metadata.lastReviewId : 0;

  // Fetch reviews from GitHub.
  const reviews = await githubClient.listReviews(owner, repo, prNumber);

  // Find the newest review whose id > lastReviewId.
  // Pick the highest id among new reviews (chronologically latest).
  const newReviews = reviews.filter((r) => r.reviewId > lastReviewId);

  if (newReviews.length === 0) {
    log.debug("reconcile: no new reviews for ask", { askId: ask.id, prNumber, lastReviewId });
    return { kind: "no-new-reviews", askId: ask.id };
  }

  // Sort descending by reviewId to get the latest review first.
  newReviews.sort((a, b) => b.reviewId - a.reviewId);
  const latestReview = newReviews[0];
  if (!latestReview) {
    // Guarded above by newReviews.length === 0 check, but TypeScript can't
    // prove it after the sort. This branch is unreachable at runtime.
    return { kind: "no-new-reviews", askId: ask.id };
  }

  log.info("reconcile: new review found, responding to ask", {
    askId: ask.id,
    prNumber,
    reviewId: latestReview.reviewId,
    reviewState: latestReview.state,
  });

  // Walk the Ask through any intermediate states to `suspended` so the
  // respond() state-machine guard (suspended -> responded) succeeds.
  await walkToSuspended(askRepository, ask);

  // Transition Ask to responded via the respond() API.
  await askRepository.respond(ask.id, {
    response: {
      responder: `reviewer:service:${latestReview.reviewerLogin ?? "unknown"}`,
      payload: {
        reviewBody: latestReview.body,
        reviewState: latestReview.state,
        reviewAuthor: latestReview.reviewerLogin,
        reviewId: latestReview.reviewId,
        prNumber,
        owner,
        repo,
      },
      attentionCost: undefined,
    },
  });

  // Update metadata.lastReviewId so next pass won't re-fire.
  // Note: metadata update via respond() is not possible directly via the
  // AskRepository interface — the respond() method sets response+state only.
  // We store lastReviewId in the metadata field on the returned Ask via the
  // same call. Since we can't update metadata separately, we rely on the
  // responded state to prevent re-notification: once an Ask is `responded`,
  // it won't be in `routed`/`suspended` on the next pass and won't be
  // picked up again.
  //
  // For the idempotence guarantee: the state transition itself is the guard.
  // An Ask in `responded` is terminal relative to this reconciler's filter.

  // Fire notification. Failure here must NOT roll back the respond().
  let notified = false;
  try {
    const bodyPreview = truncate(latestReview.body, 100);
    const notifyBody = `PR #${prNumber} — ${bodyPreview}`;
    operatorNotify.bell();
    operatorNotify.notify("Minsky: review posted", notifyBody);
    notified = true;
  } catch (notifyErr: unknown) {
    const errMsg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
    log.warn("reconcile: notification failed (ask already responded)", {
      askId: ask.id,
      error: errMsg,
    });
  }

  return { kind: "responded", askId: ask.id, reviewId: latestReview.reviewId, notified };
}
