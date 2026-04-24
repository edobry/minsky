/**
 * Session PR Wait-For-Review Command (mt#1203)
 *
 * Adapter command that blocks until a review appears on a session's PR or
 * the configured timeout elapses, then returns the review metadata. Read-only
 * tool; goes through TokenProvider for GitHub auth.
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrWaitForReviewCommandParams } from "./session-parameters";
import { sessionPrWaitForReview } from "../../../../domain/session/commands/pr-subcommands";

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
              name: params.name as string | undefined,
              task: params.task as string | undefined,
              repo: params.repo as string | undefined,
              timeoutSeconds: params.timeoutSeconds as number | undefined,
              intervalSeconds: params.intervalSeconds as number | undefined,
              reviewer: params.reviewer as string | undefined,
              since: params.since as string | undefined,
            },
            { sessionDB: deps.sessionProvider }
          );

          if (params.json) {
            return { success: true, ...result };
          }

          // --- Text output ---
          if (result.matched) {
            const { review, elapsedMs, pollCount } = result;
            const lines = [
              `✓ Review posted by ${review.reviewerLogin ?? "unknown"} ` +
                `(${review.state}) after ${Math.round(elapsedMs / 1000)}s / ${pollCount} poll(s)`,
              review.submittedAt ? `  Submitted: ${review.submittedAt}` : undefined,
              review.htmlUrl ? `  URL:       ${review.htmlUrl}` : undefined,
              "",
              // First 40 lines of the body — enough to see the structure;
              // callers who want full content use session_pr_review_context
              // or the URL.
              review.body
                ? review.body.split("\n").slice(0, 40).join("\n")
                : "  (empty review body)",
            ].filter((line): line is string => line !== undefined);
            return { success: true, message: lines.join("\n") };
          }

          const { elapsedMs, pollCount } = result;
          return {
            success: true,
            message:
              `⏳ No matching review after ${Math.round(elapsedMs / 1000)}s ` +
              `(${pollCount} poll(s)). Timeout reached without a match.`,
          };
        } catch (error) {
          throw new MinskyError(`Failed to wait for session PR review: ${getErrorMessage(error)}`);
        }
      }
    ),
  };
}
