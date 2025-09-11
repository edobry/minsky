/**
 * Task Backend Migration Command - DatabaseCommand Migration
 *
 * This command migrates from the old pattern (using PersistenceService.getProvider() via createConfiguredTaskService)
 * to the new DatabaseCommand pattern with automatic provider injection.
 *
 * MIGRATION NOTES:
 * - OLD: Extended BaseTaskCommand, used createConfiguredTaskService() that internally calls PersistenceService.getProvider()
 * - NEW: Extends DatabaseCommand, passes injected provider to createConfiguredTaskService via dependency injection
 * - BENEFIT: No singleton access, proper dependency injection, lazy initialization
 */

import { z } from "zod";
import {
  DatabaseCommand,
  DatabaseCommandContext,
} from "../../../../domain/commands/database-command";
import { CommandCategory } from "../../command-registry";
import { log } from "../../../../utils/logger";
import { TaskServiceInterface } from "../../../../domain/tasks/taskService";
import {
  _backendDetectionService,
  TaskBackend,
} from "../../../../domain/configuration/backend-detection";
import { updateSessionTaskAssociation } from "../../../../domain/session/session-task-association";

// Supported backends for migration (subset of TaskBackend)
const MIGRATION_BACKENDS = [
  TaskBackend.MARKDOWN,
  TaskBackend.MINSKY,
  TaskBackend.GITHUB,
  TaskBackend.JSON_FILE,
] as const;

const migrateBackendParamsSchema = z.object({
  from: z.enum(MIGRATION_BACKENDS).optional(),
  to: z.enum(MIGRATION_BACKENDS),
  execute: z.boolean().optional().default(false),
  limit: z.number().int().positive().optional(),
  filterStatus: z.string().optional(),
  quiet: z.boolean().optional().default(false),
  json: z.boolean().optional().default(false),
  updateIds: z.boolean().optional().default(true),
});

export type MigrateBackendParams = z.infer<typeof migrateBackendParamsSchema>;

/**
 * Task backend migration command - migrated to DatabaseCommand
 *
 * Migrates tasks between different backends (markdown, db, github, etc.)
 */
export class TasksMigrateBackendCommand extends DatabaseCommand {
  readonly id = "tasks.migrate-backend";
  readonly category = CommandCategory.TASKS;
  readonly name = "migrate-backend";
  readonly description = `Migrate tasks between different backends (${MIGRATION_BACKENDS.join(", ")})`;
  readonly parameters = {
    from: {
      schema: z.enum(MIGRATION_BACKENDS).optional(),
      spec: "Source backend (auto-detect if not provided)",
      required: false,
    },
    to: {
      schema: z.enum(MIGRATION_BACKENDS),
      spec: "Target backend",
      required: true,
    },
    execute: {
      schema: z.boolean().default(false),
      spec: "Apply changes (defaults to dry-run without this flag)",
      required: false,
      defaultValue: false,
    },
    limit: {
      schema: z.number().int().positive().optional(),
      spec: "Limit number of tasks to migrate",
      required: false,
    },
    filterStatus: {
      schema: z.string().optional(),
      spec: "Filter tasks by status",
      required: false,
    },
    quiet: {
      schema: z.boolean().default(false),
      spec: "Suppress output",
      required: false,
      defaultValue: false,
    },
    json: {
      schema: z.boolean().default(false),
      spec: "Output in JSON format",
      required: false,
      defaultValue: false,
    },
    updateIds: {
      schema: z.boolean().default(true),
      spec: "Update task IDs after migration",
      required: false,
      defaultValue: true,
    },
  } as const;

  async execute(
    params: {
      from?: (typeof MIGRATION_BACKENDS)[number];
      to: (typeof MIGRATION_BACKENDS)[number];
      execute?: boolean;
      limit?: number;
      filterStatus?: string;
      quiet?: boolean;
      json?: boolean;
      updateIds?: boolean;
      backend?: string;
      repo?: string;
      workspace?: string;
      session?: string;
    },
    context: DatabaseCommandContext
  ) {
    const { provider } = context;
    const p = migrateBackendParamsSchema.parse(params);
    const dryRun = !p.execute;
    const workspacePath = context.workspacePath || process.cwd();

    // Auto-detect source backend if not provided
    const sourceBackend = p.from || (await this.detectCurrentBackend(workspacePath));
    const targetBackend = p.to;

    if (sourceBackend === targetBackend) {
      throw new Error(`Source and target backends are the same: ${sourceBackend}`);
    }

    if (!p.quiet) {
      log.cli(
        dryRun
          ? `🔍 DRY RUN: Previewing ${sourceBackend} → ${targetBackend} migration...`
          : `🚀 Migrating tasks ${sourceBackend} → ${targetBackend}...`
      );
      if (p.filterStatus) log.cli(`📋 Filter status: ${p.filterStatus}`);
      if (typeof p.limit === "number") log.cli(`🔢 Limit: ${p.limit}`);
      if (!p.updateIds) log.cli(`🔒 ID Update: DISABLED (preserving original IDs)`);
    }

    const result = await this.migrateTasksBetweenBackends({
      sourceBackend,
      targetBackend,
      workspacePath,
      dryRun,
      limit: p.limit,
      filterStatus: p.filterStatus,
      updateIds: p.updateIds ?? true,
      provider, // Pass injected provider
    });

    if (!p.quiet) {
      const { total, migrated, skipped, errors } = result;
      log.cli(`\n📊 Migration Summary:`);
      log.cli(`   Total: ${total}`);
      log.cli(`   Migrated: ${migrated}`);
      log.cli(`   Skipped: ${skipped}`);
      log.cli(`   Errors: ${errors}`);

      if (dryRun && migrated > 0) {
        log.cli(`\n💡 Add --execute to apply these changes`);
      }
    }

    if (params.json) {
      return result;
    }

    return {
      success: true,
      ...result,
      message: `Migration ${dryRun ? "preview" : "completed"}: ${result.migrated} tasks processed`,
    };
  }

  private async detectCurrentBackend(
    workspacePath: string
  ): Promise<(typeof MIGRATION_BACKENDS)[number]> {
    const detected = await _backendDetectionService.detectBackend(workspacePath);

    // Map the detected backend to our supported migration backends
    switch (detected.backend) {
      case "minsky":
        return TaskBackend.MINSKY;
      case "markdown":
        return TaskBackend.MARKDOWN;
      case "github":
        return TaskBackend.GITHUB;
      case "json-file":
        return TaskBackend.JSON_FILE;
      default:
        // Default to markdown if detection is unclear
        return TaskBackend.MARKDOWN;
    }
  }

  private async migrateTasksBetweenBackends(options: {
    sourceBackend: (typeof MIGRATION_BACKENDS)[number];
    targetBackend: (typeof MIGRATION_BACKENDS)[number];
    workspacePath: string;
    dryRun: boolean;
    limit?: number;
    filterStatus?: string;
    updateIds: boolean;
    provider: any; // Injected persistence provider
  }): Promise<{
    total: number;
    migrated: number;
    skipped: number;
    errors: number;
    details: any[];
  }> {
    const {
      sourceBackend,
      targetBackend,
      workspacePath,
      dryRun,
      limit,
      filterStatus,
      updateIds,
      provider,
    } = options;

    // Create source and target task services using injected provider
    const { createConfiguredTaskService } = await import("../../../../domain/tasks/taskService");

    const sourceService = await createConfiguredTaskService({
      workspacePath,
      backend: sourceBackend,
      persistenceProvider: provider, // Pass injected provider
    });

    const targetService = await createConfiguredTaskService({
      workspacePath,
      backend: targetBackend,
      persistenceProvider: provider, // Pass injected provider
    });

    // Get all tasks from source backend
    let tasks = await sourceService.listTasks({ all: true }); // Get all tasks including DONE/CLOSED

    // Apply filters
    if (filterStatus) {
      tasks = tasks.filter((task) => task.status?.toUpperCase() === filterStatus.toUpperCase());
    }
    if (limit && limit > 0) {
      tasks = tasks.slice(0, limit);
    }

    const result = {
      total: tasks.length,
      migrated: 0,
      skipped: 0,
      errors: 0,
      details: [] as any[],
    };

    for (const task of tasks) {
      try {
        const taskId = task.id;

        // Get full task details including spec content
        const fullTask = await sourceService.getTask(taskId);
        if (!fullTask) {
          result.errors++;
          result.details.push({ id: taskId, status: "error", error: "Task not found in source" });
          continue;
        }

        // Check if task already exists in target
        let targetExists = false;
        try {
          const existingTarget = await targetService.getTask(taskId);
          targetExists = !!existingTarget;
        } catch {
          // Task doesn't exist in target, which is expected for migration
        }

        if (targetExists) {
          result.skipped++;
          result.details.push({
            id: taskId,
            status: "skipped",
            reason: "Already exists in target",
          });
          continue;
        }

        // Migrate the task
        if (!dryRun) {
          try {
            // Create task in target backend
            const createdTask = await targetService.createTaskFromTitleAndSpec(
              fullTask.title,
              fullTask.spec || "",
              {
                // Preserve original metadata
                status: fullTask.status,
                backend: targetBackend,
              }
            );

            // Update session associations if needed
            if (updateIds) {
              try {
                await updateSessionTaskAssociation(taskId, createdTask.id);
              } catch (sessionError) {
                log.warn(`Failed to update session associations for ${taskId}:`, sessionError);
              }
            }

            result.migrated++;
            result.details.push({
              id: taskId,
              status: "migrated",
              newId: createdTask.id,
              title: fullTask.title,
            });
          } catch (migrationError) {
            result.errors++;
            result.details.push({
              id: taskId,
              status: "error",
              error: (migrationError as Error).message,
            });
          }
        } else {
          // Dry run - just count what would be migrated
          result.migrated++;
          result.details.push({
            id: taskId,
            status: "would-migrate",
            title: fullTask.title,
          });
        }
      } catch (error) {
        result.errors++;
        result.details.push({
          id: task.id,
          status: "error",
          error: (error as Error).message,
        });
      }
    }

    return result;
  }
}

/**
 * MIGRATION SUMMARY FOR MIGRATE-BACKEND COMMAND:
 *
 * 1. Changed from BaseTaskCommand to DatabaseCommand
 * 2. Added required category property (CommandCategory.TASKS)
 * 3. Updated execute method to receive DatabaseCommandContext with provider
 * 4. Updated migrateTasksBetweenBackends to accept provider parameter
 * 5. Replaced all createConfiguredTaskService calls to pass provider via dependency injection
 * 6. Preserved all complex migration functionality (source detection, filtering, dry-run, etc.)
 *
 * BENEFITS:
 * - Automatic provider initialization via CommandDispatcher
 * - Type-safe parameter handling with DatabaseCommand
 * - Clean dependency injection for testing
 * - No manual PersistenceService calls needed
 * - Lazy initialization - no upfront database connections
 * - All migration features preserved
 */
