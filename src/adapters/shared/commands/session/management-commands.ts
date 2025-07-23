/**
 * Session Management Commands
 *
 * Commands for session management operations (delete, update).
 * Extracted from session.ts as part of modularization effort.
 */
import { BaseSessionCommand, type SessionCommandDependencies } from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import { sessionDeleteCommandParams, sessionUpdateCommandParams } from "./session-parameters";

/**
 * Session Delete Command
 */
export class SessionDeleteCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.delete";
  }

  getCommandName(): string {
    return "delete";
  }

  getCommandDescription(): string {
    return "Delete a session";
  }

  getParameterSchema(): Record<string, any> {
    return sessionDeleteCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { deleteSessionFromParams } = await import("../../../../domain/session");

    const deleted = await deleteSessionFromParams({
      name: params.name,
      task: params.task,
      force: params.force,
      repo: params.repo,
      json: params.json,
    });

    return this.createSuccessResult({
      success: deleted,
      session: params.name || params.task,
    });
  }
}

/**
 * Session Update Command
 */
export class SessionUpdateCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.update";
  }

  getCommandName(): string {
    return "update";
  }

  getCommandDescription(): string {
    return "Update a session";
  }

  getParameterSchema(): Record<string, any> {
    return sessionUpdateCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { updateSessionFromParams } = await import("../../../../domain/session");

    await updateSessionFromParams({
      name: params.name,
      task: params.task,
      repo: params.repo,
      branch: params.branch,
      noStash: params.noStash,
      noPush: params.noPush,
      force: params.force,
      json: params.json,
      skipConflictCheck: params.skipConflictCheck,
      autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
      dryRun: params.dryRun,
      skipIfAlreadyMerged: params.skipIfAlreadyMerged,
    });

    return this.createSuccessResult({
      session: params.name || params.task,
    });
  }
}

/**
 * Factory functions for creating management commands
 */
export const createSessionDeleteCommand = (deps?: SessionCommandDependencies) =>
  new SessionDeleteCommand(deps);

export const createSessionUpdateCommand = (deps?: SessionCommandDependencies) =>
  new SessionUpdateCommand(deps);
