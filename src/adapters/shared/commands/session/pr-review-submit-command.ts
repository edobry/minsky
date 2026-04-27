/**
 * Session PR Review Submit Command
 *
 * Adapter command that exposes session.pr.review.submit as an MCP tool
 * (mcp__minsky__session_pr_review_submit). Posts a GitHub PR review through
 * Minsky, using the bot / service-account identity.
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrReviewSubmitCommandParams } from "./session-parameters";
import { sessionPrReviewSubmit } from "../../../../domain/session/commands/pr-subcommands";
import type { ReviewComment } from "../../../../domain/repository/github-pr-review";

export function createSessionPrReviewSubmitCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.review.submit",
    category: CommandCategory.SESSION,
    name: "review-submit",
    description:
      "Submit a GitHub PR review (APPROVE / COMMENT / REQUEST_CHANGES) through Minsky " +
      "using the configured bot identity",
    parameters: sessionPrReviewSubmitCommandParams,
    mutating: true,
    execute: withErrorLogging(
      "session.pr.review.submit",
      async (params: Record<string, unknown>) => {
        try {
          const deps = await getDeps();

          const result = await sessionPrReviewSubmit(
            {
              sessionId: params.sessionId as string | undefined,
              task: params.task as string | undefined,
              repo: params.repo as string | undefined,
              body: params.body as string,
              event: params.event as "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
              comments: params.comments as ReviewComment[] | undefined,
            },
            { sessionDB: deps.sessionProvider }
          );

          return {
            success: true,
            reviewId: result.reviewId,
            htmlUrl: result.htmlUrl,
            prNumber: result.prNumber,
            sessionId: result.sessionId,
          };
        } catch (error) {
          throw new MinskyError(`Failed to submit PR review: ${getErrorMessage(error)}`);
        }
      }
    ),
  };
}
