/**
 * Session PR Open Command
 * Opens the pull request in the default web browser
 */

import {
  BaseSessionCommand,
  type BaseSessionCommandParams,
  type SessionCommandDependencies,
} from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { sessionPrOpenCommandParams } from "./session-parameters";
import { sessionPrOpen } from "../../../../domain/session/commands/pr-subcommands";

/**
 * Parameters for session PR open command
 */
interface SessionPrOpenParams extends BaseSessionCommandParams {
  sessionId?: string;
}

export class SessionPrOpenCommand extends BaseSessionCommand<
  SessionPrOpenParams,
  Record<string, unknown>
> {
  getCommandId(): string {
    return "session.pr.open";
  }

  getCommandName(): string {
    return "open";
  }

  getCommandDescription(): string {
    return "Open the pull request in the default web browser";
  }

  getParameterSchema(): Record<string, unknown> {
    return sessionPrOpenCommandParams;
  }

  async executeCommand(
    params: SessionPrOpenParams,
    _context: CommandExecutionContext
  ): Promise<Record<string, unknown>> {
    try {
      const result = await sessionPrOpen({
        sessionId: params.sessionId,
        name: params.name,
        task: params.task,
        repo: params.repo,
      });

      return this.createSuccessResult({
        message: `✅ Opened PR #${result.prNumber || "N/A"} for session '${result.sessionId}' in browser\n🔗 ${result.url}`,
        url: result.url,
        sessionId: result.sessionId,
        prNumber: result.prNumber,
      });
    } catch (error) {
      throw new MinskyError(`Failed to open session PR: ${getErrorMessage(error)}`);
    }
  }
}

export const createSessionPrOpenCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrOpenCommand(deps);
