/**
 * Basic Session Commands (Migrated to DatabaseCommand)
 *
 * Commands for basic session operations (list, get, start, dir).
 * Migrated from BaseSessionCommand to DatabaseSessionCommand for type-safe persistence.
 */
import { DatabaseSessionCommand } from "../../../../domain/commands/database-session-command";
import { DatabaseCommandContext, CommandExecutionResult } from "../../command-registry";
import {
  sessionListCommandParams,
  sessionGetCommandParams,
  sessionStartCommandParams,
  sessionDirCommandParams,
  sessionSearchCommandParams,
} from "./session-parameters";
import { createSessionProvider } from "../../../../domain/session/session-db-adapter";

/**
 * Session List Command
 */
export class SessionListCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.list";
  readonly name = "list";
  readonly description = "List all sessions";
  readonly parameters = sessionListCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const { listSessionsFromParams } = await import("../../../../domain/session");

      // Create session provider with injected persistence provider
      const sessionProvider = await createSessionProvider({
        persistenceProvider: context.provider,
      });

      let sessions = await listSessionsFromParams(
        {
          repo: params.repo,
          json: params.json,
        },
        {
          sessionDB: sessionProvider,
        }
      );

      // Apply time filtering on createdAt
      try {
        const {
          parseTime,
          filterByTimeRange,
        } = require("../../../../utils/result-handling/filters");
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
    } catch (error) {
      this.logError(params, error);
      throw error;
    }
  }
}

/**
 * Session Get Command
 */
export class SessionGetCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.get";
  readonly name = "get";
  readonly description = "Get details of a specific session";
  readonly parameters = sessionGetCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const { getSessionFromParams } = await import("../../../../domain/session");

      // Create session provider with injected persistence provider
      const sessionProvider = await createSessionProvider({
        persistenceProvider: context.provider,
      });

      const session = await getSessionFromParams(
        {
          name: params.name,
          task: params.task,
          repo: params.repo,
          json: params.json,
        },
        {
          sessionDB: sessionProvider,
        }
      );

      if (!session) {
        const identifier = params.name || `task-${params.task}`;
        throw new Error(`Session '${identifier}' not found`);
      }

      // Optional time constraint: createdAt within window
      try {
        const {
          parseTime,
          filterByTimeRange,
        } = require("../../../../utils/result-handling/filters");
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
    } catch (error) {
      this.logError(params, error);
      throw error;
    }
  }
}

/**
 * Session Start Command
 */
export class SessionStartCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.start";
  readonly name = "start";
  readonly description = "Start a new session";
  readonly parameters = sessionStartCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const { startSessionFromParams } = await import("../../../../domain/session");
      const { createConfiguredTaskService } = await import("../../../../domain/tasks/taskService");
      const { createGitService } = await import("../../../../domain/git");
      const { createWorkspaceUtils } = await import("../../../../domain/workspace");

      // Create session provider with injected persistence provider
      const sessionProvider = await createSessionProvider({
        persistenceProvider: context.provider,
      });

      // Create task service with injected persistence provider
      const taskService = await createConfiguredTaskService({
        workspacePath: process.cwd(),
        persistenceProvider: context.provider,
      });

      const session = await startSessionFromParams(
        {
          name: params.name,
          task: params.task,
          description: params.description,
          branch: params.branch,
          packageManager: params.packageManager,
          skipInstall: params.skipInstall,
          noStatusUpdate: params.noStatusUpdate,
          quiet: params.quiet,
          repo: params.repo,
        },
        {
          sessionDB: sessionProvider,
          taskService: taskService,
          gitService: createGitService(),
          workspaceUtils: createWorkspaceUtils(),
        }
      );

      return this.createSuccessResult({ session });
    } catch (error) {
      this.logError(params, error);
      throw error;
    }
  }
}

/**
 * Session Dir Command
 */
export class SessionDirCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.dir";
  readonly name = "dir";
  readonly description = "Get the working directory of a session";
  readonly parameters = sessionDirCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const { getSessionDirFromParams } = await import("../../../../domain/session");

      // Create session provider with injected persistence provider
      const sessionProvider = await createSessionProvider({
        persistenceProvider: context.provider,
      });

      const result = await getSessionDirFromParams(
        {
          name: params.name,
          task: params.task,
          repo: params.repo,
        },
        {
          sessionDB: sessionProvider,
        }
      );

      return this.createSuccessResult(result);
    } catch (error) {
      this.logError(params, error);
      throw error;
    }
  }
}

/**
 * Session Search Command
 */
export class SessionSearchCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.search";
  readonly name = "search";
  readonly description = "Search sessions by name or task";
  readonly parameters = sessionSearchCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const { searchSessionsFromParams } = await import("../../../../domain/session");

      // Create session provider with injected persistence provider
      const sessionProvider = await createSessionProvider({
        persistenceProvider: context.provider,
      });

      const result = await searchSessionsFromParams(
        {
          query: params.query,
          repo: params.repo,
        },
        {
          sessionDB: sessionProvider,
        }
      );

      return this.createSuccessResult(result);
    } catch (error) {
      this.logError(params, error);
      throw error;
    }
  }
}
