/**
 * Session PR Wait-For-Review Subcommand (mt#1203)
 *
 * Blocks until a matching review appears on the session's pull request, or
 * a timeout elapses. Uses polling under the hood; the tool is the transport
 * primitive that mt#1180's Ask subsystem composes for its `quality.review`
 * resolution.
 *
 * Resolution criteria: a review on the PR with `submittedAt >= since` (default
 * = call start), optionally filtered by reviewer login.
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { SessionProviderInterface } from "../types";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../../errors/index";
import { log } from "../../../utils/logger";
import type { RepositoryBackend, ReviewListEntry } from "../../repository/index";
import { createRepositoryBackendFromSession } from "../session-pr-operations";

export interface SessionPrWaitForReviewDependencies {
  sessionDB: SessionProviderInterface;
  /** Test seam: override backend creation. Defaults to the session-derived backend. */
  createBackend?: (
    sessionRecord: Parameters<typeof createRepositoryBackendFromSession>[0],
    sessionDB: SessionProviderInterface
  ) => Promise<RepositoryBackend>;
  /** Test seam: override the clock. Defaults to Date.now. */
  now?: () => number;
  /** Test seam: override the delay between polls. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SessionPrWaitForReviewParams {
  sessionId?: string;
  name?: string;
  task?: string;
  repo?: string;
  /** Max seconds to wait (default 600; capped at 1800 by the parameter schema). */
  timeoutSeconds?: number;
  /** Polling interval in seconds (default 15). Clamped to [5, 60] internally. */
  intervalSeconds?: number;
  /** Optional reviewer login filter (e.g., "minsky-reviewer[bot]"). */
  reviewer?: string;
  /** Optional ISO timestamp; reviews with submittedAt earlier than this are ignored. */
  since?: string;
}

export interface SessionPrWaitForReviewMatch {
  matched: true;
  review: ReviewListEntry;
  elapsedMs: number;
  pollCount: number;
}

export interface SessionPrWaitForReviewTimeout {
  matched: false;
  elapsedMs: number;
  pollCount: number;
}

export type SessionPrWaitForReviewResult =
  | SessionPrWaitForReviewMatch
  | SessionPrWaitForReviewTimeout;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Pick the first review, in listing order, that matches the filter criteria.
 *
 * Exported for unit tests — keeps the filter logic independent of the polling
 * loop so corner cases (missing submittedAt, case-sensitive reviewer match,
 * since boundary) can be exercised in isolation.
 */
export function findMatchingReview(
  reviews: ReviewListEntry[],
  since: number,
  reviewer: string | undefined
): ReviewListEntry | undefined {
  for (const review of reviews) {
    if (review.submittedAt === undefined) continue;
    const submittedMs = Date.parse(review.submittedAt);
    if (Number.isNaN(submittedMs)) continue;
    if (submittedMs < since) continue;
    if (reviewer !== undefined) {
      // GitHub logins are case-insensitive at the platform level; be lenient.
      if ((review.reviewerLogin ?? "").toLowerCase() !== reviewer.toLowerCase()) continue;
    }
    return review;
  }
  return undefined;
}

/**
 * Block until a matching review appears, or the timeout elapses.
 *
 * Contract:
 * - Resolves the session's PR via `resolveSessionContextWithFeedback`.
 * - Calls `backend.review.listReviews` at each poll tick.
 * - Returns the first review matching `since` (default = call start) and
 *   optional `reviewer` filter.
 * - On timeout, returns `{ matched: false, elapsedMs, pollCount }` — does not
 *   throw. Downstream callers differentiate success from timeout on the
 *   `matched` flag, not on exception flow.
 * - Throws MinskyError / ResourceNotFoundError / ValidationError for
 *   structural failures (no PR on session, backend unsupported, auth issue).
 */
export async function sessionPrWaitForReview(
  params: SessionPrWaitForReviewParams,
  deps: SessionPrWaitForReviewDependencies
): Promise<SessionPrWaitForReviewResult> {
  const { sessionDB } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const createBackend = deps.createBackend ?? createRepositoryBackendFromSession;

  // Parameter schema enforces the outer cap of 1800s; clamp defensively here.
  const timeoutMs = clamp(params.timeoutSeconds ?? 600, 1, 1800) * 1000;
  // Polling interval: 15s default, clamped [5, 60] so callers can't hammer
  // the API (lower bound) or wait forever between checks (upper bound).
  const intervalMs = clamp(params.intervalSeconds ?? 15, 5, 60) * 1000;

  const start = now();
  // `since` establishes the threshold for "new" reviews. Default is call start;
  // explicit override lets callers watch past a known-stale review.
  const since = params.since !== undefined ? Date.parse(params.since) : start;
  if (Number.isNaN(since)) {
    throw new ValidationError(`Invalid --since timestamp: ${params.since}`);
  }

  try {
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: params.sessionId ?? params.name,
      task: params.task,
      repo: params.repo,
      sessionProvider: sessionDB,
      allowAutoDetection: true,
    });

    const sessionRecord = await sessionDB.getSession(resolvedContext.sessionId);
    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
    }

    const prNumber = sessionRecord.pullRequest?.number;
    if (!prNumber) {
      throw new ResourceNotFoundError(
        `No pull request found for session '${resolvedContext.sessionId}'. ` +
          `Use 'minsky session pr create' to create a PR first.`
      );
    }

    const backend = await createBackend(sessionRecord, sessionDB);
    if (!backend.review.listReviews) {
      throw new MinskyError(
        `Repository backend does not support listing reviews. ` +
          `session_pr_wait_for_review currently requires a GitHub backend.`
      );
    }

    const deadline = start + timeoutMs;
    let pollCount = 0;

    while (true) {
      // After the first poll, the sleep may have brought us exactly to (or
      // past) the deadline. Re-check before polling again so we never start
      // an API call that would overshoot the configured timeout. The
      // `pollCount > 0` guard guarantees at least one poll even on zero
      // or sub-interval budgets — the contract is "one check minimum."
      if (pollCount > 0 && now() >= deadline) {
        return {
          matched: false,
          elapsedMs: now() - start,
          pollCount,
        };
      }

      pollCount += 1;
      const reviews = await backend.review.listReviews(prNumber);
      const match = findMatchingReview(reviews, since, params.reviewer);
      if (match) {
        return {
          matched: true,
          review: match,
          elapsedMs: now() - start,
          pollCount,
        };
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        return {
          matched: false,
          elapsedMs: now() - start,
          pollCount,
        };
      }

      const sleepMs = Math.min(intervalMs, remaining);
      log.debug(
        `session_pr_wait_for_review: PR #${prNumber} poll ${pollCount} no match; ` +
          `sleeping ${Math.round(sleepMs / 1000)}s (${Math.round(remaining / 1000)}s remaining)`
      );
      await sleep(sleepMs);
    }
  } catch (error) {
    if (
      error instanceof ResourceNotFoundError ||
      error instanceof ValidationError ||
      error instanceof MinskyError
    ) {
      throw error;
    }
    throw new MinskyError(`Failed to wait for PR review: ${getErrorMessage(error)}`);
  }
}
