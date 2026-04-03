/**
 * Session PR Get Command
 * Gets detailed PR information for a session
 */

import {
  BaseSessionCommand,
  type BaseSessionCommandParams,
  type SessionCommandDependencies,
} from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { sessionPrGetCommandParams } from "./session-parameters";
import { sessionPrGet } from "../../../../domain/session/commands/pr-subcommands";
import { formatPrTitleLine } from "./pr-shared-helpers";

/**
 * Parameters for session PR get command
 */
interface SessionPrGetParams extends BaseSessionCommandParams {
  sessionId?: string;
  status?: string;
  since?: string;
  until?: string;
  content?: boolean;
}

export class SessionPrGetCommand extends BaseSessionCommand<
  SessionPrGetParams,
  Record<string, unknown>
> {
  getCommandId(): string {
    return "session.pr.get";
  }

  getCommandName(): string {
    return "get";
  }

  getCommandDescription(): string {
    return "Get detailed information about a session pull request";
  }

  getParameterSchema(): Record<string, unknown> {
    return sessionPrGetCommandParams;
  }

  async executeCommand(
    params: SessionPrGetParams,
    _context: CommandExecutionContext
  ): Promise<Record<string, unknown>> {
    try {
      const result = await sessionPrGet({
        sessionId: params.sessionId,
        name: params.name,
        task: params.task,
        repo: params.repo,
        json: params.json,
        status: params.status,
        since: params.since,
        until: params.until,
        content: params.content,
      });

      if (params.json) {
        return this.createSuccessResult(result);
      }

      // Format detailed output
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

      // Show branch info only if it differs from the session ID (avoid redundant noise)
      if (pullRequest.branch && pullRequest.branch !== pullRequest.sessionId) {
        output.splice(4, 0, `Branch:      ${pullRequest.branch}`);
      }

      if (pullRequest.url) {
        output.push(`URL:         ${pullRequest.url}`);
      }

      if ((pullRequest as { description?: string }).description) {
        output.push("", "Description:");
        output.push((pullRequest as { description?: string }).description!);
      }

      if (pullRequest.filesChanged) {
        output.push("", `Files Changed: ${pullRequest.filesChanged}`);
      }

      return this.createSuccessResult({
        message: output.join("\n"),
      });
    } catch (error) {
      throw new MinskyError(`Failed to get session PR: ${getErrorMessage(error)}`);
    }
  }
}

export const createSessionPrGetCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrGetCommand(deps);
