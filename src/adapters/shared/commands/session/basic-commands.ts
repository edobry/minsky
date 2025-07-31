/**
 * Basic Session Commands
 *
 * Commands for basic session operations (list, get, start, dir).
 * Extracted from session.ts as part of modularization effort.
 */
import { BaseSessionCommand, type SessionCommandDependencies } from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import {
  sessionListCommandParams,
  sessionGetCommandParams,
  sessionStartCommandParams,
  sessionDirCommandParams,
  sessionOutdatedCommandParams,
  sessionCheckSyncCommandParams,
  sessionSyncSummaryCommandParams,
} from "./session-parameters";

/**
 * Session List Command
 */
export class SessionListCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.list";
  }

  getCommandName(): string {
    return "list";
  }

  getCommandDescription(): string {
    return "List all sessions";
  }

  getParameterSchema(): Record<string, any> {
    return sessionListCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { listSessionsFromParams } = await import("../../../../domain/session");

    const sessions = await listSessionsFromParams({
      repo: params.repo,
      json: params.json,
      showSyncStatus: params.showSyncStatus,
    });

    return this.createSuccessResult({ sessions });
  }
}

/**
 * Session Get Command
 */
export class SessionGetCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.get";
  }

  getCommandName(): string {
    return "get";
  }

  getCommandDescription(): string {
    return "Get details of a specific session";
  }

  getParameterSchema(): Record<string, any> {
    return sessionGetCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { getSessionFromParams } = await import("../../../../domain/session");

    const session = await getSessionFromParams({
      name: params.name,
      task: params.task,
      repo: params.repo,
      json: params.json,
    });

    if (!session) {
      const identifier = params.name || `task #${params.task}`;
      throw new Error(`Session '${identifier}' not found`);
    }

    return this.createSuccessResult({ session });
  }
}

/**
 * Session Start Command
 */
export class SessionStartCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.start";
  }

  getCommandName(): string {
    return "start";
  }

  getCommandDescription(): string {
    return "Start a new session";
  }

  getParameterSchema(): Record<string, any> {
    return sessionStartCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    // Validate that task association is provided
    if (!params.task && !params.description) {
      throw new Error(
        'Task association is required for proper tracking.\nPlease provide one of:\n  --task <id>           Associate with existing task\n  --description <text>  Create new task automatically\n\nExamples:\n  minsky session start --task 123\n  minsky session start --description "Fix login issue" my-session'
      );
    }

    const { startSessionFromParams } = await import("../../../../domain/session");

    const session = await startSessionFromParams({
      name: params.name,
      task: params.task,
      description: params.description,
      branch: params.branch,
      repo: params.repo,
      session: params.session,
      json: params.json,
      quiet: params.quiet,
      noStatusUpdate: params.noStatusUpdate,
      skipInstall: params.skipInstall,
      packageManager: params.packageManager,
    });

    return this.createSuccessResult({ session });
  }
}

/**
 * Session Directory Command
 */
export class SessionDirCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.dir";
  }

  getCommandName(): string {
    return "dir";
  }

  getCommandDescription(): string {
    return "Get the directory of a session";
  }

  getParameterSchema(): Record<string, any> {
    return sessionDirCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { getSessionDirFromParams } = await import("../../../../domain/session");

    const directory = await getSessionDirFromParams({
      name: params.name,
      task: params.task,
      repo: params.repo,
      json: params.json,
    });

    return this.createSuccessResult({ directory });
  }
}

/**
 * Session Outdated Command
 * TASK 360: Command to list all outdated sessions
 */
export class SessionOutdatedCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.outdated";
  }

  getCommandName(): string {
    return "outdated";
  }

  getCommandDescription(): string {
    return "List all outdated sessions";
  }

  getParameterSchema(): Record<string, any> {
    return sessionOutdatedCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { sessionOutdated } = await import(
      "../../../../domain/session/commands/outdated-command"
    );

    const result = await sessionOutdated({
      severity: params.severity,
      sort: params.sort,
      json: params.json,
      verbose: params.verbose,
    });

    return this.createSuccessResult(result);
  }
}

/**
 * Session Check Sync Command
 * TASK 360: Command to check sync status for all sessions
 */
export class SessionCheckSyncCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.check-sync";
  }

  getCommandName(): string {
    return "check-sync";
  }

  getCommandDescription(): string {
    return "Check sync status for all sessions";
  }

  getParameterSchema(): Record<string, any> {
    return sessionCheckSyncCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { sessionCheckSync } = await import(
      "../../../../domain/session/commands/check-sync-command"
    );

    const result = await sessionCheckSync({
      updateCache: params.updateCache,
      verbose: params.verbose,
      json: params.json,
    });

    return this.createSuccessResult(result);
  }
}

/**
 * Session Sync Summary Command
 * TASK 360: Command to show sync status summary
 */
export class SessionSyncSummaryCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.sync-summary";
  }

  getCommandName(): string {
    return "sync-summary";
  }

  getCommandDescription(): string {
    return "Show sync status summary for all sessions";
  }

  getParameterSchema(): Record<string, any> {
    return sessionSyncSummaryCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { sessionSyncSummary } = await import(
      "../../../../domain/session/commands/check-sync-command"
    );

    const result = await sessionSyncSummary({
      json: params.json,
    });

    return this.createSuccessResult(result);
  }
}

/**
 * Factory functions for creating basic session commands
 */
export const createSessionListCommand = (deps?: SessionCommandDependencies) =>
  new SessionListCommand(deps);

export const createSessionGetCommand = (deps?: SessionCommandDependencies) =>
  new SessionGetCommand(deps);

export const createSessionStartCommand = (deps?: SessionCommandDependencies) =>
  new SessionStartCommand(deps);

export const createSessionDirCommand = (deps?: SessionCommandDependencies) =>
  new SessionDirCommand(deps);

export const createSessionOutdatedCommand = (deps?: SessionCommandDependencies) =>
  new SessionOutdatedCommand(deps);

export const createSessionCheckSyncCommand = (deps?: SessionCommandDependencies) =>
  new SessionCheckSyncCommand(deps);

export const createSessionSyncSummaryCommand = (deps?: SessionCommandDependencies) =>
  new SessionSyncSummaryCommand(deps);
