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

    let sessions = await listSessionsFromParams({
      repo: params.repo,
      json: params.json,
    });

    // Apply time filtering on createdAt
    try {
      const { parseTime, filterByTimeRange } = require("../../../../utils/result-handling/filters");
      const sinceTs = parseTime(params.since);
      const untilTs = parseTime(params.until);
      sessions = filterByTimeRange(
        sessions.map((s: any) => ({ ...s, updatedAt: s.createdAt })),
        sinceTs,
        untilTs
      );
    } catch {
      // ignore
    }

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

    // Optional time constraint: createdAt within window
    try {
      const { parseTime, filterByTimeRange } = require("../../../../utils/result-handling/filters");
      const sinceTs = parseTime(params.since);
      const untilTs = parseTime(params.until);
      const [matched] = filterByTimeRange([{ updatedAt: session.createdAt }], sinceTs, untilTs);
      if ((sinceTs !== null || untilTs !== null) && !matched) {
        throw new Error("Session does not match time constraints");
      }
    } catch {
      // ignore
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

    return this.createSuccessResult({
      session,
      quiet: params.quiet,
      json: params.json,
    });
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
    const { getSessionDirFromParams } = await import(
      "../../../../domain/session/commands/dir-command"
    );

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