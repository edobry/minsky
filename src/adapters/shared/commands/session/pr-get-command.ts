/**
 * Session PR Get Command
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrGetCommandParams } from "./session-parameters";
import { sessionPrGet } from "../../../../domain/session/commands/pr-subcommands";
import { formatPrTitleLine } from "./pr-shared-helpers";

export function createSessionPrGetCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.get",
    category: CommandCategory.SESSION,
    name: "get",
    description: "Get detailed information about a session pull request",
    parameters: sessionPrGetCommandParams,
    execute: withErrorLogging("session.pr.get", async (params: Record<string, unknown>) => {
      try {
        const deps = await getDeps();
        const result = await sessionPrGet(
          {
            sessionId: params.sessionId as string | undefined,
            task: params.task as string | undefined,
            repo: params.repo as string | undefined,
            json: params.json as boolean | undefined,
            status: params.status as string | undefined,
            since: params.since as string | undefined,
            until: params.until as string | undefined,
            content: params.content as boolean | undefined,
          },
          { sessionDB: deps.sessionProvider }
        );

        if (params.json) {
          return { success: true, ...result };
        }

        const { pullRequest } = result;

        const titleLine = formatPrTitleLine({
          status: pullRequest.status,
          rawTitle: pullRequest.title,
          prNumber: pullRequest.number,
          taskId: pullRequest.taskId,
          sessionId: pullRequest.sessionId,
        });

        const output = [
          titleLine,
          "",
          `Session:     ${pullRequest.sessionId}`,
          `Task:        ${pullRequest.taskId || "none"}`,
          `Status:      ${pullRequest.status}`,
          `Created:     ${pullRequest.createdAt || "unknown"}`,
          `Updated:     ${pullRequest.updatedAt || "unknown"}`,
        ];

        if (pullRequest.branch && pullRequest.branch !== pullRequest.sessionId) {
          output.splice(4, 0, `Branch:      ${pullRequest.branch}`);
        }

        if (pullRequest.url) {
          output.push(`URL:         ${pullRequest.url}`);
        }

        if ((pullRequest as { description?: string }).description) {
          output.push("", "Description:");
          output.push((pullRequest as { description?: string }).description ?? "");
        }

        if (pullRequest.filesChanged) {
          output.push("", `Files Changed: ${pullRequest.filesChanged}`);
        }

        return { success: true, message: output.join("\n") };
      } catch (error) {
        throw new MinskyError(`Failed to get session PR: ${getErrorMessage(error)}`);
      }
    }),
  };
}
