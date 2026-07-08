/**
 * Session PR Drive Subcommand (mt#2647)
 *
 * The convergence-tail driver: composes the EXISTING `session_pr_wait-for-review`
 * and `session_pr_checks` (wait mode) subcommands into a single call that carries
 * an in-review PR from "review posted" through "checks green" and reports a
 * terminal state — replacing the ~4-6 manual tool calls (`wait-for-review` ->
 * branch -> `checks wait:true` -> branch) an orchestrator previously hand-drove
 * for every PR.
 *
 * DESIGN DECISION (mt#2647 spec): the actual `session.pr.merge` call is
 * DELIBERATELY left to the caller (the orchestrator), not folded into this
 * tool. Every merge gate in this repo (bundle-boot-smoke, deploy-verification,
 * bypass-merge guards, etc.) is a harness-side Claude Code PreToolUse hook
 * matched on the MCP tool name `mcp__minsky__session_pr_merge`. A server-side
 * driver that internally called the merge domain function would bypass every
 * one of those hooks — the mt#2647 spec's "no gate bypass" criterion forbids
 * that. So this driver returns a terminal state (READY_TO_MERGE / ... ) and
 * the caller makes the ONE `session.pr.merge` call itself, letting all
 * harness-side gates fire normally. This reduces the manual tail from ~6
 * calls to 2 (drive, then merge) with zero gate risk.
 *
 * On CHANGES_REQUESTED or COMMENT this function STOPS and returns the review
 * payload (body + submittedAt + reviewer) so the caller can route a fix and
 * re-invoke with `since` set to the returned review's `submittedAt` — it
 * never treats COMMENT as an approval (mt#2647 acceptance criterion).
 *
 * Does not reimplement any polling loop: `sessionPrWaitForReview` and
 * `sessionPrChecks` (wait mode) already own their poll loops with injected
 * now/sleep test seams (mirroring `askWaitForResponse`,
 * `packages/domain/src/ask/wait-for-response.ts`); this module only
 * sequences them and threads the same seams through.
 */

import { MinskyError, ResourceNotFoundError, getErrorMessage } from "../../errors/index";
import type { SessionProviderInterface } from "../types";
import type { ChecksResult } from "../../repository/index";
import {
  sessionPrWaitForReview,
  type AnnotatedReview,
  type SessionPrWaitForReviewDependencies,
  type TrimmedReview,
} from "./pr-wait-for-review-subcommand";
import {
  sessionPrChecks,
  trimChecksResult,
  type SessionPrChecksDependencies,
  type TrimmedChecksResult,
} from "./pr-checks-subcommand";
import type { ReviewListEntry } from "../../repository/index";

// ── Params / dependencies ───────────────────────────────────────────────────

export interface SessionPrDriveParams {
  sessionId?: string;
  task?: string;
  repo?: string;
  /** Reviewer filter — see `SessionPrWaitForReviewParams.reviewer`. Defaults to any reviewer. */
  reviewer?: string;
  /** See `SessionPrWaitForReviewParams.since`. */
  since?: string;
  /** See `SessionPrWaitForReviewParams.requireCurrentHead`. Default true. */
  requireCurrentHead?: boolean;
  /** Max seconds to wait for a matching review (default 600, max 1800). */
  reviewTimeoutSeconds?: number;
  /** Review polling interval in seconds (default 15, [5,60]). */
  reviewIntervalSeconds?: number;
  /** Max seconds to wait for checks to complete (default 600). */
  checksTimeoutSeconds?: number;
  /** Checks polling interval in seconds (default 30). */
  checksIntervalSeconds?: number;
  /**
   * Skip the checks-wait step entirely (e.g. the repo has no CI configured).
   * When true, an APPROVED review alone resolves to READY_TO_MERGE.
   */
  skipChecks?: boolean;
  /**
   * When true, return the full `ReviewListEntry` (raw body) and full
   * `ChecksResult` (per-check breakdown) instead of the default trimmed
   * payloads (mt#2656). Defaults to false. See
   * `pr-wait-for-review-subcommand.ts`'s `fullBody` doc for the review-side
   * rationale; `pr-checks-subcommand.ts`'s `trimChecksResult` for the
   * checks-side trimming.
   */
  fullBody?: boolean;
}

export type SessionPrDriveDependencies = SessionPrWaitForReviewDependencies &
  SessionPrChecksDependencies;

// ── Result shape (discriminated union on `state`) ───────────────────────────

export type SessionPrDriveState =
  | "READY_TO_MERGE"
  | "CHANGES_REQUESTED"
  | "COMMENT"
  | "CHECKS_FAILED"
  | "CHECKS_TIMEOUT"
  | "REVIEW_TIMEOUT"
  | "UNRECOGNIZED_REVIEW_STATE";

interface SessionPrDriveResultBase {
  elapsedMs: number;
}

/**
 * Review payload shape returned in every drive result: trimmed by default
 * (mt#2656), full `ReviewListEntry` when `params.fullBody: true`. See
 * `pr-wait-for-review-subcommand.ts`'s `SessionPrWaitForReviewMatch.review`
 * doc for the discrimination rule (`findings` array vs. `body` string).
 */
export type SessionPrDriveReviewPayload = ReviewListEntry | TrimmedReview;

/**
 * Checks payload shape returned when checks were waited on: trimmed by
 * default (mt#2656), full `ChecksResult` when `params.fullBody: true`.
 */
export type SessionPrDriveChecksPayload = ChecksResult | TrimmedChecksResult;

/** Review approved and checks passed (or checks were explicitly skipped). */
export interface SessionPrDriveReadyToMerge extends SessionPrDriveResultBase {
  state: "READY_TO_MERGE";
  review: SessionPrDriveReviewPayload;
  checks: SessionPrDriveChecksPayload | null;
}

/**
 * Review posted a blocking or neutral verdict — CHANGES_REQUESTED,
 * COMMENT (never treated as approval), or a state this driver does not
 * recognize (e.g. DISMISSED). The caller routes a fix (or investigates)
 * and re-invokes with `since` set to `review.submittedAt`.
 */
export interface SessionPrDriveReviewBlocked extends SessionPrDriveResultBase {
  state: "CHANGES_REQUESTED" | "COMMENT" | "UNRECOGNIZED_REVIEW_STATE";
  review: SessionPrDriveReviewPayload;
}

/** Review approved, but CI checks failed or timed out waiting for them. */
export interface SessionPrDriveChecksBlocked extends SessionPrDriveResultBase {
  state: "CHECKS_FAILED" | "CHECKS_TIMEOUT";
  review: SessionPrDriveReviewPayload;
  checks: SessionPrDriveChecksPayload;
}

/** No matching review appeared within the review-wait timeout. */
export interface SessionPrDriveReviewTimeout extends SessionPrDriveResultBase {
  state: "REVIEW_TIMEOUT";
  pollCount: number;
  sinceUsed: string;
  lastSeenReviews: AnnotatedReview[];
}

export type SessionPrDriveResult =
  | SessionPrDriveReadyToMerge
  | SessionPrDriveReviewBlocked
  | SessionPrDriveChecksBlocked
  | SessionPrDriveReviewTimeout;

// ── Driver ───────────────────────────────────────────────────────────────

/**
 * Drive an in-review session PR from "waiting for review" through "checks
 * green," returning a terminal state. Does NOT merge — see the module
 * doc-comment for why the merge call stays with the caller.
 */
export async function sessionPrDrive(
  params: SessionPrDriveParams,
  deps: SessionPrDriveDependencies
): Promise<SessionPrDriveResult> {
  const now = deps.now ?? (() => Date.now());
  const start = now();

  try {
    const waitResult = await sessionPrWaitForReview(
      {
        sessionId: params.sessionId,
        task: params.task,
        repo: params.repo,
        reviewer: params.reviewer,
        since: params.since,
        requireCurrentHead: params.requireCurrentHead,
        timeoutSeconds: params.reviewTimeoutSeconds,
        intervalSeconds: params.reviewIntervalSeconds,
        fullBody: params.fullBody,
      },
      deps
    );

    if (!waitResult.matched) {
      return {
        state: "REVIEW_TIMEOUT",
        elapsedMs: now() - start,
        pollCount: waitResult.pollCount,
        sinceUsed: waitResult.sinceUsed,
        lastSeenReviews: waitResult.lastSeenReviews,
      };
    }

    const { review } = waitResult;

    // Never treat COMMENT (or anything but APPROVED) as approval.
    if (review.state === "CHANGES_REQUESTED") {
      return { state: "CHANGES_REQUESTED", review, elapsedMs: now() - start };
    }
    if (review.state === "COMMENTED") {
      return { state: "COMMENT", review, elapsedMs: now() - start };
    }
    if (review.state !== "APPROVED") {
      // DISMISSED (or any future state `findMatchingReview` doesn't reject) —
      // stop rather than guess; the caller decides how to proceed.
      return { state: "UNRECOGNIZED_REVIEW_STATE", review, elapsedMs: now() - start };
    }

    if (params.skipChecks) {
      return { state: "READY_TO_MERGE", review, checks: null, elapsedMs: now() - start };
    }

    const rawChecks = await sessionPrChecks(
      {
        sessionId: params.sessionId,
        task: params.task,
        repo: params.repo,
        wait: true,
        timeoutSeconds: params.checksTimeoutSeconds,
        intervalSeconds: params.checksIntervalSeconds,
      },
      deps
    );

    // mt#2656: trimmed by default (drop the per-check breakdown once all
    // pass — only failing/pending checks are worth surfacing). Branching on
    // timedOut/allPassed below reads `rawChecks` (always the full shape) so
    // the branch decisions are unaffected by the payload trim.
    const checks: SessionPrDriveChecksPayload = params.fullBody
      ? rawChecks
      : trimChecksResult(rawChecks);

    if (rawChecks.timedOut) {
      return { state: "CHECKS_TIMEOUT", review, checks, elapsedMs: now() - start };
    }
    if (!rawChecks.allPassed) {
      return { state: "CHECKS_FAILED", review, checks, elapsedMs: now() - start };
    }

    return { state: "READY_TO_MERGE", review, checks, elapsedMs: now() - start };
  } catch (error) {
    if (error instanceof ResourceNotFoundError || error instanceof MinskyError) {
      throw error;
    }
    throw new MinskyError(`Failed to drive session PR to convergence: ${getErrorMessage(error)}`);
  }
}

// Re-export the sessionDB type for adapter-layer convenience imports.
export type { SessionProviderInterface };
