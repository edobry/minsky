/**
 * Task Migration Command
 *
 * CLI command for migrating legacy task IDs to qualified format
 */

import { z } from "zod";
import type { CommandExecutionContext } from "../../command-registry";
import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import { TaskMigrationService } from "../../../../domain/tasks/task-migration-service";
import { log } from "../../../../utils/logger";
import { tasksMigrateParams } from "./task-parameters";

/**
 * Schema for migrate command parameters
 */
const migrateTasksParamsSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  toBackend: z.string().optional().default("md"),
  statusFilter: z.string().optional(),
  createBackup: z.boolean().optional().default(true),
  force: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false),
  json: z.boolean().optional().default(false),
});

export type MigrateTasksParams = z.infer<typeof migrateTasksParamsSchema>;

/**
 * Command for migrating legacy task IDs to qualified format
 */
export class MigrateTasksCommand extends BaseTaskCommand<MigrateTasksParams, any> {
  readonly id = "tasks.migrate";
  readonly name = "migrate";
  readonly description = "Migrate legacy task IDs to qualified format";
  readonly parameters = tasksMigrateParams;

  getCommandId(): string {
    return "tasks.migrate";
  }

  getCommandName(): string {
    return "migrate";
  }

  getCommandDescription(): string {
    return "Migrate legacy task IDs (#123) to qualified format (md#123)";
  }

  getParameterSchema(): Record<string, any> {
    return {
      dryRun: {
        schema: z.boolean().default(false),
        description: "Show what would be changed without making changes",
        required: false,
      },
      toBackend: {
        schema: z.string().default("md"),
        description: "Target backend for migration (e.g., 'md', 'gh')",
        required: false,
      },
      statusFilter: {
        schema: z.string(),
        description: "Filter tasks by status (TODO, IN-PROGRESS, DONE, etc.)",
        required: false,
      },
      createBackup: {
        schema: z.boolean().default(true),
        description: "Create backup before migration",
        required: false,
      },
      force: {
        schema: z.boolean().default(false),
        description: "Force migration even if some tasks might be lost",
        required: false,
      },
      quiet: {
        schema: z.boolean().default(false),
        description: "Suppress output",
        required: false,
      },
      json: {
        schema: z.boolean().default(false),
        description: "Output in JSON format",
        required: false,
      },
    };
  }

  async execute(params: MigrateTasksParams, context: CommandExecutionContext): Promise<any> {
    const validatedParams = migrateTasksParamsSchema.parse(params);

    const { dryRun, toBackend, statusFilter, createBackup, force, quiet, json } = validatedParams;

    if (!quiet) {
      if (dryRun) {
        log.cli("🔍 DRY RUN: Previewing task ID migration...");
      } else {
        log.cli("🚀 Starting task ID migration...");
      }

      if (statusFilter) {
        log.cli(`📋 Filtering by status: ${statusFilter}`);
      }

      log.cli(`🎯 Target backend: ${toBackend}`);
    }

    try {
      // Initialize migration service
      const migrationService = new TaskMigrationService(context.workspacePath || process.cwd());

      // Perform migration
      const result = await migrationService.migrateTaskIds({
        dryRun,
        toBackend,
        statusFilter,
        createBackup,
        force,
      });

      // Output results
      if (json) {
        return this.createSuccessResult(result);
      }

      // Human-readable output
      if (!quiet) {
        this.displayMigrationResults(result, dryRun);
      }

      return this.createSuccessResult({
        summary: {
          totalTasks: result.totalTasks,
          migratedTasks: result.migratedTasks,
          alreadyQualified: result.alreadyQualified,
          failedTasks: result.failedTasks,
        },
        backupPath: result.backupPath,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (json) {
        return this.createErrorResult(`Migration failed: ${errorMessage}`);
      }

      log.cli(`❌ Migration failed: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Display migration results in human-readable format
   */
  private displayMigrationResults(result: any, dryRun: boolean): void {
    const { totalTasks, migratedTasks, alreadyQualified, failedTasks } = result;

    if (dryRun) {
      log.cli("\n📊 DRY RUN RESULTS:");
    } else {
      log.cli("\n📊 MIGRATION RESULTS:");
    }

    log.cli(`📝 Total tasks processed: ${totalTasks}`);

    if (migratedTasks > 0) {
      log.cli(`✅ Tasks migrated: ${migratedTasks}`);
    }

    if (alreadyQualified > 0) {
      log.cli(`✨ Already qualified: ${alreadyQualified}`);
    }

    if (failedTasks > 0) {
      log.cli(`❌ Failed migrations: ${failedTasks}`);
    }

    if (result.backupPath) {
      log.cli(`💾 Backup created: ${result.backupPath}`);
    }

    // Show detailed results if there are migrations or failures
    if (migratedTasks > 0 || failedTasks > 0) {
      log.cli("\n📋 DETAILED RESULTS:");

      for (const detail of result.details) {
        if (detail.status === "migrated") {
          log.cli(`  ✅ ${detail.originalId} → ${detail.newId} (${detail.title})`);
        } else if (detail.status === "failed") {
          log.cli(`  ❌ ${detail.originalId} - ${detail.reason} (${detail.title})`);
        }
      }
    }

    if (dryRun && migratedTasks > 0) {
      log.cli("\n💡 To perform the actual migration, run the same command without --dry-run");
    }

    if (!dryRun && migratedTasks > 0) {
      log.cli("\n🎉 Migration completed successfully!");
      log.cli("💡 You can now use qualified task IDs throughout the system");
    }
  }
}

/**
 * Factory function to create the migrate command
 */
export function createMigrateTasksCommand(): MigrateTasksCommand {
  return new MigrateTasksCommand();
}
