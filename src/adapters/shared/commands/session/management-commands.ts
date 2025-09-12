/**
 * Session Management Commands (Migrated to DatabaseCommand)
 *
 * Commands for session management operations (delete, update).
 * Migrated from BaseSessionCommand to DatabaseSessionCommand for type-safe persistence.
 */
import { DatabaseSessionCommand } from "../../../../domain/commands/database-session-command";
import { DatabaseCommandContext, CommandExecutionResult } from "../../command-registry";
import {
  sessionDeleteCommandParams,
  sessionUpdateCommandParams,
  sessionMigrateBackendCommandParams,
} from "./session-parameters";
import { createSessionProvider } from "../../../../domain/session/session-db-adapter";

/**
 * Session Delete Command
 */
export class SessionDeleteCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.delete";
  readonly name = "delete";
  readonly description = "Delete a session";
  readonly parameters = sessionDeleteCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const { deleteSessionFromParams } = await import("../../../../domain/session");

      // Create session provider with injected persistence provider
      const sessionProvider = await createSessionProvider({
        persistenceProvider: context.provider,
      });

      const deleted = await deleteSessionFromParams(
        {
          name: params.name,
          task: params.task,
          force: params.force,
          repo: params.repo,
          json: params.json,
        },
        {
          sessionDB: sessionProvider,
        }
      );

      return this.createSuccessResult({
        success: deleted,
        session: params.name || params.task,
      });
    } catch (error) {
      this.logError(params, error);
      throw error;
    }
  }
}

/**
 * Session Update Command
 */
export class SessionUpdateCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.update";
  readonly name = "update";
  readonly description = "Update a session";
  readonly parameters = sessionUpdateCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const { updateSessionFromParams } = await import("../../../../domain/session");

      // Create session provider with injected persistence provider
      const sessionProvider = await createSessionProvider({
        persistenceProvider: context.provider,
      });

      await updateSessionFromParams(
        {
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
        },
        {
          sessionDB: sessionProvider,
        }
      );

      return this.createSuccessResult({
        session: params.name || params.task,
      });
    } catch (error) {
      this.logError(params, error);
      throw error;
    }
  }
}

/**
 * Session Migrate Backend Command
 */
export class SessionMigrateBackendCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.migrate-backend";
  readonly name = "migrate-backend";
  readonly description =
    "Migrate session backend from local to GitHub by discovering repository details";
  readonly parameters = sessionMigrateBackendCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const { migrateSessionBackendFromParams } = await import("../../../../domain/session");

      // Create session provider with injected persistence provider
      const sessionProvider = await createSessionProvider({
        persistenceProvider: context.provider,
      });

      const result = await migrateSessionBackendFromParams(
        {
          name: params.name,
          task: params.task,
          repo: params.repo,
          dryRun: params.dryRun,
          json: params.json,
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
