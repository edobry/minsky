/**
 * Task Migration/Import Command - DatabaseCommand Migration
 *
 * This command migrates from the old pattern (using PersistenceService.getProvider() via TasksImporterService)
 * to the new DatabaseCommand pattern with automatic provider injection.
 *
 * MIGRATION NOTES:
 * - OLD: Extended BaseTaskCommand, used TasksImporterService that internally calls PersistenceService.getProvider()
 * - NEW: Extends DatabaseCommand, passes injected provider to TasksImporterService constructor
 * - BENEFIT: No singleton access, proper dependency injection, lazy initialization
 */

import { z } from "zod";
import {
  DatabaseCommand,
  DatabaseCommandContext,
} from "../../../../domain/commands/database-command";
import { CommandCategory } from "../../command-registry";
import { log } from "../../../../utils/logger";
import { tasksMigrateParams } from "./task-parameters";
import { TasksImporterService } from "../../../../domain/tasks/tasks-importer-service";

const migrateParamsSchema = z.object({
  execute: z.boolean().optional().default(false),
  limit: z.number().int().positive().optional(),
  filterStatus: z.string().optional(),
  quiet: z.boolean().optional().default(false),
  json: z.boolean().optional().default(false),
});

export type MigrateParams = z.infer<typeof migrateParamsSchema>;

/**
 * Task migration command - migrated to DatabaseCommand
 *
 * Imports markdown task specs/metadata into DB by default (dry-run by default).
 */
export class MigrateTasksCommand extends DatabaseCommand {
  readonly id = "tasks.migrate";
  readonly category = CommandCategory.TASKS;
  readonly name = "migrate";
  readonly description = "Import markdown task specs/metadata into DB (dry-run by default)";
  readonly parameters = tasksMigrateParams;

  async execute(
    params: {
      execute?: boolean;
      limit?: number;
      filterStatus?: string;
      quiet?: boolean;
      json?: boolean;
      backend?: string;
      repo?: string;
      workspace?: string;
      session?: string;
    },
    context: DatabaseCommandContext
  ): Promise<any> {
    const { provider } = context;
    const p = migrateParamsSchema.parse(params);
    const dryRun = !p.execute;

    if (!p.quiet) {
      log.cli(
        dryRun ? "🔍 DRY RUN: Previewing markdown → DB import..." : "🚀 Importing markdown → DB..."
      );
      if (p.filterStatus) log.cli(`📋 Filter status: ${p.filterStatus}`);
      if (typeof p.limit === "number") log.cli(`🔢 Limit: ${p.limit}`);
    }

    // Create TasksImporterService with injected provider
    const importer = new TasksImporterService(
      context.workspacePath || process.cwd(),
      provider // Pass injected provider
    );

    const result = await importer.importMarkdownToDb({
      dryRun,
      limit: p.limit,
      filterStatus: p.filterStatus,
    });

    if (p.json || context.format === "json") {
      return {
        success: true,
        ...result,
        summary: {
          total: result.total,
          inserted: result.inserted,
          updated: result.updated,
          skipped: result.skipped,
          errors: result.errors,
        },
      };
    }

    this.display(result, dryRun);
    return {
      success: true,
      summary: {
        total: result.total,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors,
      },
      message: dryRun ? "Migration preview completed" : "Migration completed",
    };
  }

  private display(result: any, dryRun: boolean): void {
    log.cli("\n📊 RESULTS:");
    log.cli(`📝 Total: ${result.total}`);
    if (result.inserted > 0) {
      log.cli(`✅ Inserted: ${result.inserted}`);
    }
    if (result.updated > 0) {
      log.cli(`🔄 Updated: ${result.updated}`);
    }
    if (result.skipped > 0) {
      log.cli(`⏭️  Skipped: ${result.skipped}`);
    }
    if (result.errors > 0) {
      log.cli(`❌ Errors: ${result.errors}`);
    }

    if (dryRun && result.inserted + result.updated > 0) {
      log.cli(`\n💡 Add --execute to apply these changes`);
    }
  }
}

/**
 * MIGRATION SUMMARY FOR MIGRATE COMMAND:
 *
 * 1. Changed from BaseTaskCommand to DatabaseCommand
 * 2. Added required category property (CommandCategory.TASKS)
 * 3. Updated execute method to receive DatabaseCommandContext with provider
 * 4. Updated TasksImporterService instantiation to pass injected provider
 * 5. Simplified return structures (removed BaseTaskCommand helper methods)
 * 6. Preserved all migration functionality and dry-run capabilities
 *
 * BENEFITS:
 * - Automatic provider initialization via CommandDispatcher
 * - Type-safe parameter handling with DatabaseCommand
 * - Clean dependency injection for testing
 * - No manual PersistenceService calls needed
 * - Lazy initialization - no upfront database connections
 * - All migration features preserved
 */
