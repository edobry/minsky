/**
 * Session PR Review Thread Resolve Command
 *
 * Adapter command that exposes session.pr.review.thread.resolve as an MCP tool
 * (mcp__minsky__session_pr_review_thread_resolve). Resolves or unresolves a
 * GitHub PR review thread through Minsky, using the bot / service-account
 * identity.
 *
 * GitHub REST API does not support review-thread resolution; both actions use
 * GraphQL mutations (`resolveReviewThread` / `unresolveReviewThread`). A single
 * tool handles both via the `action` parameter.
 *
 * When to use this tool:
 *   - Manual reviewer override: after addressing a reviewer's finding in a
 *     follow-up commit, resolve the thread to signal it is done.
 *   - Automation hook: downstream tooling (mt#1345) can call this tool to
 *     auto-resolve threads when the associated finding is fixed.
 *   - Round-trip testing / correction: unresolve a thread that was resolved
 *     prematurely.
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrReviewThreadResolveCommandParams } from "./session-parameters";
import { sessionPrReviewThreadResolve } from "../../../../domain/session/commands/pr-subcommands";

export function createSessionPrReviewThreadResolveCommand(
  getDeps: LazySessionDeps
): CommandDefinition {
  return {
    id: "session.pr.review.thread.resolve",
    category: CommandCategory.SESSION,
    name: "review-thread-resolve",
    description:
      "Resolve or unresolve a GitHub PR review thread (GraphQL-only) through Minsky " +
      "using the configured bot identity. Use action='resolve' to mark a thread as done " +
      "after addressing the finding; use action='unresolve' to reopen it.",
    parameters: sessionPrReviewThreadResolveCommandParams,
    mutating: true,
    execute: withErrorLogging(
      "session.pr.review.thread.resolve",
      async (params: Record<string, unknown>) => {
        try {
          const deps = await getDeps();

          const result = await sessionPrReviewThreadResolve(
            {
              sessionId: params.sessionId as string | undefined,
              task: params.task as string | undefined,
              repo: params.repo as string | undefined,
              threadId: params.threadId as string,
              action: params.action as "resolve" | "unresolve",
            },
            { sessionDB: deps.sessionProvider }
          );

          return {
            success: true,
            threadId: result.threadId,
            action: result.action,
            sessionId: result.sessionId,
          };
        } catch (error) {
          throw new MinskyError(
            `Failed to ${params.action} PR review thread: ${getErrorMessage(error)}`
          );
        }
      }
    ),
  };
}
