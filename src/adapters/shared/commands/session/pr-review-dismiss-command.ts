/**
 * Session PR Review Dismiss Command
 *
 * Adapter command exposing session.pr.review.dismiss as an MCP tool
 * (mcp__minsky__session_pr_review_dismiss). Dismisses a GitHub PR review
 * through Minsky using the bot / service-account identity.
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrReviewDismissCommandParams } from "./session-parameters";
import { sessionPrReviewDismiss } from "../../../../domain/session/commands/pr-subcommands";

export function createSessionPrReviewDismissCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.review.dismiss",
    category: CommandCategory.SESSION,
    name: "review-dismiss",
    description:
      "Dismiss a GitHub PR review (typically a stale adversarial review after " +
      "the blocker has been addressed) through Minsky using the configured bot identity",
    parameters: sessionPrReviewDismissCommandParams,
    mutating: true,
    execute: withErrorLogging(
      "session.pr.review.dismiss",
      async (params: Record<string, unknown>) => {
        try {
          const deps = await getDeps();

          const result = await sessionPrReviewDismiss(
            {
              sessionId: params.sessionId as string | undefined,
              task: params.task as string | undefined,
              repo: params.repo as string | undefined,
              reviewId: params.reviewId as number,
              message: params.message as string,
            },
            { sessionDB: deps.sessionProvider }
          );

          return {
            success: true,
            reviewId: result.reviewId,
            htmlUrl: result.htmlUrl,
            state: result.state,
            prNumber: result.prNumber,
            sessionId: result.sessionId,
          };
        } catch (error) {
          throw new MinskyError(`Failed to dismiss PR review: ${getErrorMessage(error)}`);
        }
      }
    ),
  };
}
