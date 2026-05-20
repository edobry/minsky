/**
 * Session PR Close Command (mt#1955)
 */

import {
  CommandCategory,
  type CommandDefinition,
  type CommandExecutionContext,
} from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { log } from "../../../../utils/logger";
import { type SessionCommandDependencies, type LazySessionDeps } from "./types";
import { sessionPrCloseCommandParams } from "./session-parameters";
import { sessionPrClose } from "../../../../domain/session/commands/pr-subcommands";

export interface SessionPrCloseParams {
  sessionId?: string;
  task?: string;
  repo?: string;
  comment?: string;
  json?: boolean;
  debug?: boolean;
}

function handlePrCloseError(error: unknown, params: SessionPrCloseParams): Error {
  const errorMessage = getErrorMessage(error);

  if (errorMessage.includes("already merged")) {
    return new MinskyError(
      `Cannot close PR for session '${params.sessionId || params.task}': PR is already merged.\n\n` +
        `Technical details: ${errorMessage}`
    );
  }
  if (errorMessage.includes("already closed")) {
    return new MinskyError(
      `Cannot close PR for session '${params.sessionId || params.task}': PR is already closed.\n\n` +
        `Technical details: ${errorMessage}`
    );
  }
  if (errorMessage.includes("No GitHub pull request found")) {
    return new MinskyError(
      `No PR found for this session.\n\n` +
        `The session '${params.sessionId || params.task}' does not have an existing pull request to close.\n\n` +
        `Technical details: ${errorMessage}`
    );
  }
  if (
    errorMessage.includes("Permission denied") ||
    errorMessage.includes("authentication") ||
    errorMessage.includes("403") ||
    errorMessage.includes("401")
  ) {
    return new MinskyError(
      `GitHub authentication error while closing PR.\n\n` +
        `Check that the bot identity has write access to the PR and that the GitHub App token has not expired.\n\n` +
        `Technical details: ${errorMessage}`
    );
  }
  return new MinskyError(`Failed to close session PR: ${errorMessage}`);
}

/**
 * Core execute logic for session.pr.close. Exported for tests.
 */
export async function executeSessionPrClose(
  deps: SessionCommandDependencies,
  params: SessionPrCloseParams,
  context: CommandExecutionContext
): Promise<Record<string, unknown>> {
  try {
    let workingDirectory = process.cwd();
    const interfaceType = context.interface as "cli" | "mcp";

    if (interfaceType === "mcp") {
      let sessionId = params.sessionId;
      if (!sessionId && params.task) {
        const { resolveSessionContextWithFeedback } = await import(
          "../../../../domain/session/session-context-resolver"
        );
        const resolvedContext = await resolveSessionContextWithFeedback({
          task: params.task,
          repo: params.repo,
          sessionProvider: deps.sessionProvider,
          allowAutoDetection: false,
        });
        sessionId = resolvedContext.sessionId;
      }

      if (sessionId) {
        const sessionRecord = await deps.sessionProvider.getSession(sessionId);
        if (sessionRecord) {
          workingDirectory = await deps.sessionProvider.getRepoPath(sessionRecord);
        }
      }
    }

    const result = await sessionPrClose(
      {
        sessionId: params.sessionId,
        task: params.task,
        repo: params.repo,
        comment: params.comment,
        debug: params.debug,
      },
      { sessionDB: deps.sessionProvider },
      {
        interface: interfaceType,
        workingDirectory,
      }
    );

    return {
      success: true,
      prNumber: result.prNumber,
      url: result.url,
      state: result.state,
      commentPosted: result.commentPosted,
    };
  } catch (error) {
    throw handlePrCloseError(error, params);
  }
}

export function createSessionPrCloseCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.close",
    category: CommandCategory.SESSION,
    name: "close",
    description:
      "Close a pull request WITHOUT merging, optionally posting a comment first (mt#1955). " +
      "Use this for the absorb-and-close pattern: when work in PR A is absorbed into PR B " +
      "(B's broader refresh subsumes A's narrower scope), close A with a comment pointing at B. " +
      "The optional `comment` is posted as a regular PR comment (not a review) BEFORE the state " +
      "flip, so it appears chronologically before the close event in the PR timeline. Refuses " +
      "to close already-closed or already-merged PRs — returns a clear error naming the state " +
      "(checked via live GitHub API, not the session DB record). Routes through TokenProvider " +
      "(implementer App by default), like the rest of the session.pr.* family. This is the " +
      "Minsky equivalent for `gh pr close` and for the state-flip-to-closed path of " +
      "`mcp__github__update_pull_request` (both hook-banned per mt#1030).",
    parameters: sessionPrCloseCommandParams,
    mutating: true,
    execute: async (params, context) => {
      try {
        const deps = await getDeps();
        return await executeSessionPrClose(deps, params as SessionPrCloseParams, context);
      } catch (error) {
        log.debug(`Error in session.pr.close`, {
          params,
          error: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    },
  };
}
