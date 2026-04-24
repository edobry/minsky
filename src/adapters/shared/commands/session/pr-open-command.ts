/**
 * Session PR Open Command
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrOpenCommandParams } from "./session-parameters";
import { sessionPrOpen } from "../../../../domain/session/commands/pr-subcommands";

export function createSessionPrOpenCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.open",
    category: CommandCategory.SESSION,
    name: "open",
    description: "Open the pull request in the default web browser",
    parameters: sessionPrOpenCommandParams,
    execute: withErrorLogging("session.pr.open", async (params: Record<string, unknown>) => {
      try {
        const deps = await getDeps();
        const result = await sessionPrOpen(
          {
            sessionId: params.sessionId as string | undefined,
            task: params.task as string | undefined,
            repo: params.repo as string | undefined,
          },
          { sessionDB: deps.sessionProvider }
        );

        return {
          success: true,
          message: `✅ Opened PR #${result.prNumber || "N/A"} for session '${result.sessionId}' in browser\n🔗 ${result.url}`,
          url: result.url,
          sessionId: result.sessionId,
          prNumber: result.prNumber,
        };
      } catch (error) {
        throw new MinskyError(`Failed to open session PR: ${getErrorMessage(error)}`);
      }
    }),
  };
}
