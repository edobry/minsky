/**
 * Session Repair Command - DatabaseCommand Migration
 *
 * This command migrates from the old pattern (using BaseSessionCommand with PersistenceService.getProvider())
 * to the new DatabaseSessionCommand pattern with automatic provider injection.
 *
 * MIGRATION NOTES:
 * - OLD: Extended BaseSessionCommand, used createSessionProvider() that internally calls PersistenceService.getProvider()
 * - NEW: Extends DatabaseSessionCommand, passes injected provider to createSessionProvider via dependency injection
 * - BENEFIT: No singleton access, proper dependency injection, lazy initialization
 */
import { DatabaseSessionCommand } from "../../../../domain/commands/database-session-command";
import { sessionRepairCommandParams } from "./session-parameters";
import {
  sessionRepair,
  SessionRepairParameters,
} from "../../../../domain/session/commands/repair-command";
import { DatabaseCommandContext } from "../../../../domain/commands/types";
import { log } from "../../../../utils/logger";
import { z } from "zod";

// Using existing sessionRepairCommandParams for parameter definitions

export class SessionRepairCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.repair" as const;
  readonly name = "repair";
  readonly description = "Repair session state issues (PR state, backend sync, etc.)";
  readonly parameters = sessionRepairCommandParams;

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

      const repairParams: SessionRepairParameters = {
        name: params.name,
        task: params.task,
        repo: params.repo,
        dryRun: params.dryRun,
        auto: params.auto,
        interactive: params.interactive,
        prState: params.prState,
        backendSync: params.backendSync,
        force: params.force,
        debug: params.debug,
      };

      // Call sessionRepair with dependencies that have injected provider
      const result = await sessionRepair(repairParams, {
        sessionDB: sessionProvider,
      });

      if (params.json) {
        return {
          success: true,
          data: result,
        };
      }

      // CLI output
      if (result.success) {
        log.cli(`✅ Session repair completed for '${result.sessionName}'`);

        if (result.issuesFound.length === 0) {
          log.cli("No issues found - session is healthy");
        } else {
          log.cli(`📊 Summary:`);
          log.cli(`  • Issues found: ${result.issuesFound.length}`);
          log.cli(`  • Repairs applied: ${result.repairsApplied.length}`);
          log.cli(`  • Repairs skipped: ${result.repairsSkipped.length}`);

          if (result.repairsApplied.length > 0) {
            log.cli("\n🔧 Repairs applied:");
            result.repairsApplied.forEach((repair) => {
              log.cli(`  ✅ ${repair.description}`);
            });
          }

          if (result.repairsSkipped.length > 0) {
            log.cli("\n⏭️  Repairs skipped:");
            result.repairsSkipped.forEach((repair) => {
              log.cli(`  ⚠️  ${repair.description}`);
            });
          }
        }
      } else {
        log.cli(`❌ Session repair failed for '${result.sessionName}'`);
      }

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Session repair failed", { error: errorMessage });

      if (params.json) {
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
 * 5. Updated sessionRepair call to pass sessionDB with injected provider
 * 6. Preserved all repair functionality (dry-run, auto-repair, interactive modes, CLI output)
 * 7. Maintained full compatibility with existing parameter structure
 *
 * BENEFITS:
 * - No more PersistenceService.getProvider() singleton access
 * - Proper dependency injection through DatabaseCommand architecture
 * - Lazy database initialization (only when repair command is executed)
 * - Type-safe parameters with compile-time validation
 * - Consistent error handling with other DatabaseCommands
 */
