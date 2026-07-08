/**
 * Session PR Wait-For-Review Command (mt#1203)
 *
 * Adapter command that blocks until a review appears on a session's PR or
 * the configured timeout elapses, then returns the review metadata. Read-only
 * tool; goes through TokenProvider for GitHub auth.
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "@minsky/domain/errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrWaitForReviewCommandParams } from "./session-parameters";
import { sessionPrWaitForReview } from "@minsky/domain/session/commands/pr-subcommands";
import type {
  SessionPrWaitForReviewMatch,
  SessionPrWaitForReviewTimeout,
  TrimmedReview,
} from "@minsky/domain/session/commands/pr-wait-for-review-subcommand";
import type { ReviewListEntry } from "@minsky/domain/repository/index";

/**
 * Discriminate the mt#2656 trimmed-vs-full review payload structurally:
 * `TrimmedReview` has a `findings` array that `ReviewListEntry` lacks.
 * Exported for reuse by `pr-drive-command.ts`'s text-mode rendering.
 */
export function isTrimmedReview(review: ReviewListEntry | TrimmedReview): review is TrimmedReview {
  return "findings" in review;
}

/**
 * Render the findings list of a trimmed review as text lines (mt#2656).
 * Mirrors the `[SEVERITY] location — summary` shape the review body itself
 * uses, minus the per-finding details paragraph. Exported for reuse by
 * `pr-drive-command.ts`'s text-mode rendering.
 */
export function formatTrimmedFindings(review: TrimmedReview): string {
  const lines = [
    `  Findings: ${review.blockingCount} BLOCKING / ${review.nonBlockingCount} NON-BLOCKING`,
  ];
  if (review.findings.length === 0) {
    lines.push("  (no findings)");
  } else {
    for (const finding of review.findings) {
      lines.push(`  - [${finding.severity}] ${finding.location} — ${finding.summary}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render the text-mode message for a successful match. Exported for unit
 * testing — the rendering contract should be independent of the underlying
 * wait-tool dependencies.
 */
export function formatMatchMessage(result: SessionPrWaitForReviewMatch): string {
  const { review, elapsedMs, pollCount } = result;
  const lines = [
    `✓ Review posted by ${review.reviewerLogin ?? "unknown"} ` +
      `(${review.state}) after ${Math.round(elapsedMs / 1000)}s / ${pollCount} poll(s)`,
    review.submittedAt ? `  Submitted: ${review.submittedAt}` : undefined,
    review.htmlUrl ? `  URL:       ${review.htmlUrl}` : undefined,
    "",
    isTrimmedReview(review)
      ? formatTrimmedFindings(review)
      : // Full body (params.fullBody: true) — first 40 lines are enough to
        // see the structure; callers who want the rest use
        // session.pr.review-context or the URL.
        review.body
        ? review.body.split("\n").slice(0, 40).join("\n")
        : "  (empty review body)",
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

/**
 * Render the text-mode message for a timeout. Exported for unit testing.
 *
 * Includes the mt#2043 diagnostic payload (sinceUsed + up to MAX_SHOWN
 * lastSeenReviews entries with rejectionReason) so text-mode callers can
 * diagnose the miss class without re-running with --json.
 */
export function formatTimeoutMessage(result: SessionPrWaitForReviewTimeout): string {
  const { elapsedMs, pollCount, sinceUsed, lastSeenReviews } = result;
  const header =
    `⏳ No matching review after ${Math.round(elapsedMs / 1000)}s ` +
    `(${pollCount} poll(s)). Timeout reached without a match.`;
  const lines: string[] = [header, `  Threshold (since): ${sinceUsed}`];
  if (lastSeenReviews.length === 0) {
    lines.push("  No reviews on the PR at the final poll.");
    return lines.join("\n");
  }
  const MAX_SHOWN = 5;
  const shown = lastSeenReviews.slice(0, MAX_SHOWN);
  lines.push(`  Last seen ${lastSeenReviews.length} review(s):`);
  for (const entry of shown) {
    const reviewer = entry.reviewerLogin ?? "<null>";
    const submitted = entry.submittedAt ?? "<no submittedAt>";
    lines.push(`    - [${entry.state}] ${reviewer} @ ${submitted} — ${entry.rejectionReason}`);
  }
  if (lastSeenReviews.length > MAX_SHOWN) {
    lines.push(`    ... and ${lastSeenReviews.length - MAX_SHOWN} more (use --json for full list)`);
  }
  return lines.join("\n");
}

export function createSessionPrWaitForReviewCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.wait-for-review",
    category: CommandCategory.SESSION,
    name: "wait-for-review",
    description:
      "Block until a review appears on the session's pull request, or the timeout elapses. " +
      "Polls the forge and returns the first review matching the given filters. " +
      "Read-only.",
    parameters: sessionPrWaitForReviewCommandParams,
    execute: withErrorLogging(
      "session.pr.wait-for-review",
      async (params: Record<string, unknown>) => {
        try {
          const deps = await getDeps();
          const result = await sessionPrWaitForReview(
            {
              sessionId: params.sessionId as string | undefined,
              task: params.task as string | undefined,
              repo: params.repo as string | undefined,
              timeoutSeconds: params.timeoutSeconds as number | undefined,
              intervalSeconds: params.intervalSeconds as number | undefined,
              reviewer: params.reviewer as string | undefined,
              since: params.since as string | undefined,
              requireCurrentHead: params.requireCurrentHead as boolean | undefined,
              fullBody: params.fullBody as boolean | undefined,
            },
            { sessionDB: deps.sessionProvider }
          );

          if (params.json) {
            return { success: true, ...result };
          }

          // --- Text output ---
          // Rendering logic lives in pure exported helpers (formatMatchMessage,
          // formatTimeoutMessage) so the format contract can be unit-tested
          // without the wait tool's full dependency chain.
          if (result.matched) {
            return { success: true, message: formatMatchMessage(result) };
          }
          return { success: true, message: formatTimeoutMessage(result) };
        } catch (error) {
          // Preserve domain error types so downstream handlers can branch
          // on ResourceNotFoundError (missing PR) vs ValidationError
          // (invalid --since) vs generic MinskyError. Only wrap truly
          // unknown errors to avoid swallowing unexpected failures silently.
          if (
            error instanceof ResourceNotFoundError ||
            error instanceof ValidationError ||
            error instanceof MinskyError
          ) {
            throw error;
          }
          throw new MinskyError(`Failed to wait for session PR review: ${getErrorMessage(error)}`);
        }
      }
    ),
  };
}
