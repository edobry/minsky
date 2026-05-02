/**
 * Session PR Review Context Command
 *
 * Adapter command that fetches all PR review data in a single composed call:
 * PR metadata, CI checks, diff, and task spec.
 */

import { z } from "zod";
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrReviewContext } from "../../../../domain/session/commands/pr-review-context-subcommand";

// ── Parameter definitions ────────────────────────────────────────────────

export const sessionPrReviewContextCommandParams = {
  sessionId: {
    schema: z.string(),
    description: "Session ID (positional)",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID to resolve session from",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
};

// ── Command factory ──────────────────────────────────────────────────────

export function createSessionPrReviewContextCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.review_context",
    category: CommandCategory.SESSION,
    name: "review_context",
    description:
      "Get all PR review data in a single call: metadata, CI checks, diff (raw + parsedDiff with structured hunks for line-anchored comment selection), and task spec",
    parameters: sessionPrReviewContextCommandParams,
    execute: withErrorLogging(
      "session.pr.review_context",
      async (params: Record<string, unknown>) => {
        try {
          const deps = await getDeps();
          const result = await sessionPrReviewContext(
            {
              sessionId: params.sessionId as string | undefined,
              task: params.task as string | undefined,
              repo: params.repo as string | undefined,
            },
            {
              sessionDB: deps.sessionProvider,
              taskService: deps.taskService,
            }
          );

          return { success: true, ...result };
        } catch (error) {
          throw new MinskyError(
            `Failed to get session PR review context: ${getErrorMessage(error)}`
          );
        }
      }
    ),
  };
}
