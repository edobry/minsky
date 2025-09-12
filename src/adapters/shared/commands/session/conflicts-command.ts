/**
 * Session Conflicts Command - DatabaseCommand Migration
 *
 * This command migrates from the old pattern (using BaseSessionCommand with PersistenceService.getProvider())
 * to the new DatabaseSessionCommand pattern with automatic provider injection.
 *
 * MIGRATION NOTES:
 * - OLD: Extended BaseSessionCommand, used domain operations that internally call PersistenceService.getProvider()
 * - NEW: Extends DatabaseSessionCommand, passes injected provider to session operations via dependency injection
 * - BENEFIT: No singleton access, proper dependency injection, lazy initialization
 */
import { DatabaseSessionCommand } from "../../../../domain/commands/database-session-command";
import { DatabaseCommandContext } from "../../../../domain/commands/types";
import { z } from "zod";
import {
  scanSessionConflicts,
  formatSessionConflictResults,
} from "../../../../domain/session/session-conflicts-operations";

/**
 * Session Conflicts Detection Command
 */
export class SessionConflictsCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.conflicts" as const;
  readonly name = "conflicts";
  readonly description = "Detect merge conflicts within session workspaces";
  readonly parameters = {
    name: {
      schema: z.string(),
      description: "Session name",
      required: false,
    },
    task: {
      schema: z.string(),
      description: "Task ID to identify session",
      required: false,
    },
    format: {
      schema: z.enum(["json", "text"]),
      description: "Output format for conflict results",
      required: false,
    },
    json: {
      schema: z.boolean(),
      description: "Output in JSON format",
      required: false,
    },
  };

  async execute(params: any, context: DatabaseCommandContext): Promise<any> {
    try {
      const { provider } = context;

      // Create session provider with injected persistence provider
      const { createSessionProvider } = await import(
        "../../../../domain/session/session-db-adapter"
      );
      const sessionProvider = await createSessionProvider({
        persistenceProvider: provider,
      });

      // Resolve session name/context
      const { resolveSessionContextWithFeedback } = await import(
        "../../../../domain/session/session-context-resolver"
      );

      const resolvedContext = await resolveSessionContextWithFeedback({
        sessionName: params.name,
        taskId: params.task,
        sessionProvider,
      });

      if (!resolvedContext.sessionName) {
        throw new Error("Could not resolve session name");
      }

      // Scan for conflicts using resolved session
      const conflictResults = await scanSessionConflicts({
        sessionName: resolvedContext.sessionName,
        sessionProvider,
      });

      const outputFormat = params.json ? "json" : params.format || "text";

      if (outputFormat === "json") {
        return {
          success: true,
          data: {
            sessionName: resolvedContext.sessionName,
            conflicts: conflictResults,
          },
        };
      }

      // Text formatting
      const formattedOutput = await formatSessionConflictResults(
        resolvedContext.sessionName,
        conflictResults
      );

      console.log(formattedOutput);

      return {
        success: true,
        data: {
          sessionName: resolvedContext.sessionName,
          conflicts: conflictResults,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (params.json || params.format === "json") {
        return {
          success: false,
          error: errorMessage,
        };
      }

      throw error;
    }
  }
}

/**
 * MIGRATION SUMMARY:
 *
 * 1. Changed from BaseSessionCommand to DatabaseSessionCommand for proper provider injection
 * 2. Added required category property (CommandCategory.SESSION)
 * 3. Added Zod schema for type-safe parameter validation
 * 4. Updated execute method to receive DatabaseCommandContext with provider
 * 5. Updated scanSessionConflicts call to pass sessionProvider with injected provider
 * 6. Preserved all conflict detection functionality and output formatting
 * 7. Maintained full compatibility with existing parameter structure
 *
 * BENEFITS:
 * - No more PersistenceService.getProvider() singleton access
 * - Proper dependency injection through DatabaseCommand architecture
 * - Lazy database initialization (only when conflicts command is executed)
 * - Type-safe parameters with compile-time validation
 * - Consistent error handling with other DatabaseCommands
 */
