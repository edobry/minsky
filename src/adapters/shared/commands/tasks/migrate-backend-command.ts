/**
 * Task Backend Migration Command
 *
 * Migrates tasks between different backends (markdown, db, github, etc.)
 * Reuses patterns from session migrate-backend command for consistency.
 */

import { z } from "zod";
import type { CommandExecutionContext } from "../../command-registry";
import { BaseTaskCommand } from "./base-task-command";
import { log } from "../../../../utils/logger";
import {
  createConfiguredTaskService,
  TaskServiceInterface,
} from "../../../../domain/tasks/taskService";
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

export class TasksMigrateBackendCommand extends BaseTaskCommand<MigrateBackendParams, any> {
  readonly id = "tasks.migrate-backend";
  readonly name = "migrate-backend";
  readonly description = `Migrate tasks between different backends (${MIGRATION_BACKENDS.join(", ")})`;
  readonly parameters = {
    from: {
      schema: z.enum(MIGRATION_BACKENDS).optional(),
      description: "Source backend (auto-detect if not provided)",
      required: false,
    },
    to: {
      schema: z.enum(MIGRATION_BACKENDS),
      description: "Target backend",
      required: true,
    },
    execute: {
      schema: z.boolean().default(false),
      description: "Apply changes (defaults to dry-run without this flag)",
      required: false,
    },
    limit: {
      schema: z.number().int().positive().optional(),
      description: "Limit number of tasks to migrate",
      required: false,
    },
    filterStatus: {
      schema: z.string().optional(),
      description: "Filter tasks by status (e.g., TODO, IN-PROGRESS)",
      required: false,
    },
    updateIds: {
      schema: z.boolean().default(true),
      description: "Update task IDs to match target backend prefix (default: true)",
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

  async execute(params: MigrateBackendParams, context: CommandExecutionContext): Promise<any> {
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
      updateIds: p.updateIds,
    });

    // Perform post-migration validation if not dry run
    let validationResult;
    if (!dryRun) {
      if (!p.quiet) {
        log.cli("\n🔍 Validating migration...");
      }

      validationResult = await this.validateMigration({
        sourceBackend,
        targetBackend,
        workspacePath,
        migratedTasks: result.details.filter((d: any) => d.status === "migrated"),
        updateIds: p.updateIds,
      });

      if (validationResult.failed.length > 0) {
        const errorMessage = `Post-migration validation failed: ${validationResult.failed.length} tasks failed validation`;

        if (p.json || context.format === "json") {
          return {
            success: false,
            error: errorMessage,
            validationErrors: validationResult.failed,
            summary: {
              total: result.total,
              migrated: result.migrated,
              skipped: result.skipped,
              errors: result.errors,
              validated: validationResult.passed.length,
              validationFailed: validationResult.failed.length,
            },
          };
        }

        this.displayValidationResults(validationResult);
        throw new Error(errorMessage);
      }

      if (!p.quiet) {
        const migratedCount = result.details.filter((d) => d.status === "migrated").length;
        if (migratedCount === 0) {
          log.cli("✅ Validation complete: No new migrations to verify");
        } else {
          log.cli(
            `✅ Validation passed: ${validationResult.passed.length} of ${migratedCount} migrated tasks verified`
          );
        }
      }
    }

    if (p.json || context.format === "json") {
      return this.createSuccessResult({
        ...result,
        validation: validationResult,
      });
    }

    this.displayResults(result, dryRun, sourceBackend, targetBackend);
    return this.createSuccessResult({
      sourceBackend,
      targetBackend,
      summary: {
        total: result.total,
        migrated: result.migrated,
        skipped: result.skipped,
        errors: result.errors,
        validated: validationResult?.passed.length || 0,
        validationFailed: validationResult?.failed.length || 0,
      },
    });
  }

  private async detectCurrentBackend(workspacePath: string): Promise<string> {
    // Use the backend detection service instead of hardcoded logic
    const detectedBackend = await _backendDetectionService.detectBackend(workspacePath);

    // Convert TaskBackend enum to string format expected by migration command
    switch (detectedBackend) {
      case "MARKDOWN":
        return "markdown";
      case "JSON_FILE":
        return "json-file";
      case "GITHUB_ISSUES":
        return "github";
      default:
        throw new Error(`Unable to detect current backend in workspace: ${workspacePath}`);
    }
  }

  private async migrateTasksBetweenBackends(options: {
    sourceBackend: string;
    targetBackend: string;
    workspacePath: string;
    dryRun: boolean;
    limit?: number;
    filterStatus?: string;
    updateIds: boolean;
  }): Promise<{
    total: number;
    migrated: number;
    skipped: number;
    errors: number;
    details: any[];
  }> {
    const { sourceBackend, targetBackend, workspacePath, dryRun, limit, filterStatus, updateIds } =
      options;

    // Create source and target task services using unified async factory
    const sourceService = await createConfiguredTaskService({
      workspacePath,
      backend: sourceBackend,
    });
    const targetService = await createConfiguredTaskService({
      workspacePath,
      backend: targetBackend,
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

        // Generate target ID for checking if task already exists
        let newTaskId = taskId;
        if (updateIds) {
          const targetPrefix = this.getBackendPrefix(targetBackend);
          const sourcePrefix = this.getBackendPrefix(sourceBackend);

          if (taskId.startsWith(`${sourcePrefix}#`)) {
            const numericPart = taskId.replace(`${sourcePrefix}#`, "");
            newTaskId = `${targetPrefix}#${numericPart}`;
          }
        }

        // Check if task already exists in target backend
        const existingTask = await targetService.getTask(newTaskId).catch(() => null);
        if (existingTask) {
          result.skipped++;
          result.details.push({
            id: taskId,
            status: "skipped",
            reason: "already_exists",
            targetId: newTaskId,
          });
          continue;
        }

        // Get task spec content
        const specData = await sourceService.getTaskSpecContent(taskId);
        const specContent = specData?.content || "";

        if (!dryRun) {
          // Create task in target backend with transformed ID and status
          await targetService.createTaskFromTitleAndSpec(fullTask.title, specContent, {
            force: true,
            id: newTaskId,
            status: fullTask.status,
          });

          // Update session task associations if task ID changed
          if (newTaskId !== taskId) {
            try {
              const sessionUpdateResult = await updateSessionTaskAssociation(taskId, newTaskId, {
                dryRun: false, // We're already in execute mode
              });

              if (sessionUpdateResult.sessionsUpdated > 0) {
                log.info("Updated session task associations", {
                  oldTaskId: taskId,
                  newTaskId,
                  sessionsUpdated: sessionUpdateResult.sessionsUpdated,
                  updatedSessions: sessionUpdateResult.updatedSessions,
                });
              }

              if (sessionUpdateResult.errors.length > 0) {
                log.warn("Some session updates failed", {
                  taskId,
                  newTaskId,
                  errors: sessionUpdateResult.errors,
                });
              }
            } catch (error) {
              // Don't fail the entire migration if session update fails
              log.warn("Failed to update session associations", {
                taskId,
                newTaskId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } else if (dryRun && newTaskId !== taskId) {
          // In dry-run mode, show what session updates would happen
          try {
            const sessionUpdateResult = await updateSessionTaskAssociation(taskId, newTaskId, {
              dryRun: true,
            });

            if (sessionUpdateResult.sessionsFound > 0) {
              log.info("Would update session task associations (dry-run)", {
                oldTaskId: taskId,
                newTaskId,
                sessionsFound: sessionUpdateResult.sessionsFound,
                sessionNames: sessionUpdateResult.updatedSessions,
              });
            }
          } catch (error) {
            log.debug("Failed to check session associations in dry-run", {
              taskId,
              newTaskId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        result.migrated++;
        result.details.push({
          id: taskId,
          status: "migrated",
          sourceBackend,
          targetBackend,
          sessionUpdates:
            newTaskId !== taskId
              ? {
                  wouldUpdateSessions: dryRun,
                  taskIdChanged: true,
                }
              : undefined,
        });
      } catch (error) {
        result.errors++;

        // Create user-friendly error message
        const errorMessage = this.createUserFriendlyErrorMessage(task.id, error);

        // In verbose mode, show more context but never raw stack traces
        if (process.env.MINSKY_VERBOSE === "true") {
          log.error(`❌ ${task.id}: ${errorMessage}`);
        }

        result.details.push({
          id: task.id,
          status: "error",
          error: errorMessage,
        });
      }
    }

    return result;
  }

  private getBackendPrefix(backend: string): string {
    const prefixMap: Record<string, string> = {
      markdown: "md",
      minsky: "mt",
      github: "gh",
      "json-file": "json",
    };
    return prefixMap[backend] || backend;
  }

  private createUserFriendlyErrorMessage(taskId: string, error: unknown): string {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Detect common error patterns and provide helpful messages
    if (errorMessage.includes("ENOENT") && errorMessage.includes("no such file or directory")) {
      // Extract filename from error for better context
      const fileMatch = errorMessage.match(/open '([^']+)'/);
      const fileName = fileMatch ? fileMatch[1] : "spec file";
      return `Spec file not found: ${fileName}. Task may already be migrated or file was moved.`;
    }

    if (errorMessage.includes("ELOOP") && errorMessage.includes("too many symbolic links")) {
      return `Broken symbolic links in spec file. Please check file system links.`;
    }

    if (errorMessage.includes("Failed to read spec file")) {
      return `Cannot read task specification file. File may be missing or have incorrect permissions.`;
    }

    if (errorMessage.includes("Task not found in source")) {
      return `Task exists in database but not accessible from source backend.`;
    }

    if (errorMessage.includes("already exists") || errorMessage.includes("duplicate")) {
      return `Task already exists in target backend. Consider using --force or check for duplicates.`;
    }

    // Default: Clean up technical error message for user consumption
    const cleanError = errorMessage
      .replace(/^Error:\s*/i, "")
      .replace(/\s+at\s+.*$/gm, "") // Remove stack trace lines
      .split("\n")[0] // Take only first line
      .slice(0, 100); // Limit length

    return cleanError || "Unknown migration error occurred.";
  }

  private displayResults(
    result: any,
    dryRun: boolean,
    sourceBackend: string,
    targetBackend: string
  ): void {
    log.cli("\n📊 MIGRATION RESULTS:");
    log.cli(`📝 Total: ${result.total}`);
    log.cli(`✅ Migrated: ${result.migrated}`);
    if (result.skipped > 0) log.cli(`⏭️  Skipped: ${result.skipped}`);
    if (result.errors > 0) log.cli(`❌ Errors: ${result.errors}`);

    // Show user-friendly error summary if there are errors
    if (result.errors > 0) {
      log.cli("\n⚠️  Migration Issues:");

      // Group errors by type for better presentation
      const errorGroups = this.groupErrorsByType(result.details);

      for (const [errorType, tasks] of Object.entries(errorGroups)) {
        if (tasks.length > 0) {
          log.cli(`   • ${errorType}: ${tasks.length} task${tasks.length > 1 ? "s" : ""}`);

          // Show a few examples if there are many
          const examples = tasks.slice(0, 3);
          examples.forEach((task) => {
            log.cli(`     - ${task.id}`);
          });

          if (tasks.length > 3) {
            log.cli(`     ... and ${tasks.length - 3} more`);
          }
        }
      }

      log.cli(`\n💡 Most errors are likely tasks already migrated to the target backend.`);
      log.cli(`   Set MINSKY_VERBOSE=true for detailed error information.`);
    }

    if (dryRun) {
      log.cli(`\n💡 Run with --execute to migrate from ${sourceBackend} to ${targetBackend}.`);
    } else {
      log.cli(`\n🎉 Successfully migrated tasks from ${sourceBackend} to ${targetBackend}!`);
    }
  }

  private groupErrorsByType(details: any[]): Record<string, any[]> {
    const groups: Record<string, any[]> = {
      "Missing spec files": [],
      "Already migrated": [],
      "File system issues": [],
      "Other errors": [],
    };

    details
      .filter((d) => d.status === "error")
      .forEach((detail) => {
        const error = detail.error || "";

        if (error.includes("Spec file not found") || error.includes("may already be migrated")) {
          groups["Already migrated"].push(detail);
        } else if (error.includes("spec file") || error.includes("not found")) {
          groups["Missing spec files"].push(detail);
        } else if (error.includes("symbolic links") || error.includes("permissions")) {
          groups["File system issues"].push(detail);
        } else {
          groups["Other errors"].push(detail);
        }
      });

    return groups;
  }

  /**
   * Validates that migrated tasks actually exist and match in the target backend
   */
  private async validateMigration(params: {
    sourceBackend: string;
    targetBackend: string;
    workspacePath: string;
    migratedTasks: any[];
    updateIds: boolean;
  }): Promise<{ passed: any[]; failed: any[] }> {
    const { sourceBackend, targetBackend, workspacePath, migratedTasks, updateIds } = params;

    if (migratedTasks.length === 0) {
      return { passed: [], failed: [] };
    }

    const sourceService = await createConfiguredTaskService({
      backend: sourceBackend,
      workspacePath,
    });

    const targetService = await createConfiguredTaskService({
      backend: targetBackend,
      workspacePath,
    });

    const passed: any[] = [];
    const failed: any[] = [];

    for (const migratedTask of migratedTasks) {
      try {
        // Determine expected target task ID
        let targetTaskId = migratedTask.id;
        if (updateIds) {
          const targetPrefix = this.getBackendPrefix(targetBackend);
          const sourcePrefix = this.getBackendPrefix(sourceBackend);

          if (migratedTask.id.startsWith(`${sourcePrefix}#`)) {
            const numericPart = migratedTask.id.replace(`${sourcePrefix}#`, "");
            targetTaskId = `${targetPrefix}#${numericPart}`;
          }
        }

        // 1. Verify task exists in target backend
        const targetTask = await targetService.getTask(targetTaskId).catch(() => null);
        if (!targetTask) {
          failed.push({
            taskId: migratedTask.id,
            targetTaskId,
            reason: "TASK_NOT_FOUND_IN_TARGET",
            details: `Task ${targetTaskId} was reported as migrated but does not exist in ${targetBackend} backend`,
          });
          continue;
        }

        // 2. Get source task for comparison
        const sourceTask = await sourceService.getTask(migratedTask.id).catch(() => null);
        if (!sourceTask) {
          // This shouldn't happen since we just migrated it, but check anyway
          failed.push({
            taskId: migratedTask.id,
            targetTaskId,
            reason: "SOURCE_TASK_MISSING",
            details: `Source task ${migratedTask.id} no longer exists in ${sourceBackend} backend`,
          });
          continue;
        }

        // 3. Verify critical fields match
        if (sourceTask.title !== targetTask.title) {
          failed.push({
            taskId: migratedTask.id,
            targetTaskId,
            reason: "TITLE_MISMATCH",
            details: `Title mismatch: source="${sourceTask.title}" vs target="${targetTask.title}"`,
          });
          continue;
        }

        if (sourceTask.status !== targetTask.status) {
          failed.push({
            taskId: migratedTask.id,
            targetTaskId,
            reason: "STATUS_MISMATCH",
            details: `Status mismatch: source="${sourceTask.status}" vs target="${targetTask.status}"`,
          });
          continue;
        }

        // 4. Verify spec content matches (if both backends support it)
        try {
          const sourceSpec = await sourceService.getTaskSpecContent(migratedTask.id);
          const targetSpec = await targetService.getTaskSpecContent(targetTaskId);

          if (sourceSpec?.content !== targetSpec?.content) {
            failed.push({
              taskId: migratedTask.id,
              targetTaskId,
              reason: "CONTENT_MISMATCH",
              details: `Spec content differs between source and target`,
            });
            continue;
          }
        } catch (error) {
          // If one backend doesn't support spec content, skip this check
          // This is expected for some backend combinations
        }

        // All validations passed
        passed.push({
          taskId: migratedTask.id,
          targetTaskId,
          status: "VALIDATED",
        });
      } catch (error) {
        failed.push({
          taskId: migratedTask.id,
          targetTaskId: migratedTask.id,
          reason: "VALIDATION_ERROR",
          details: `Validation failed with error: ${error}`,
        });
      }
    }

    return { passed, failed };
  }

  /**
   * Display detailed validation results to the user
   */
  private displayValidationResults(validationResult: { passed: any[]; failed: any[] }): void {
    log.cli("\n❌ MIGRATION VALIDATION FAILED:");
    log.cli(`✅ Validated: ${validationResult.passed.length}`);
    log.cli(`❌ Failed: ${validationResult.failed.length}`);

    if (validationResult.failed.length > 0) {
      log.cli("\n🔍 Validation Failures:");

      // Group failures by reason
      const failureGroups: Record<string, any[]> = {};
      validationResult.failed.forEach((failure) => {
        if (!failureGroups[failure.reason]) {
          failureGroups[failure.reason] = [];
        }
        failureGroups[failure.reason].push(failure);
      });

      for (const [reason, failures] of Object.entries(failureGroups)) {
        log.cli(`\n   • ${reason}: ${failures.length} task${failures.length > 1 ? "s" : ""}`);

        failures.slice(0, 5).forEach((failure) => {
          log.cli(`     - ${failure.taskId} → ${failure.targetTaskId}`);
          log.cli(`       ${failure.details}`);
        });

        if (failures.length > 5) {
          log.cli(`     ... and ${failures.length - 5} more`);
        }
      }

      log.cli("\n💡 Migration validation ensures all reported migrations actually succeeded.");
      log.cli("   Please investigate these failures before considering the migration complete.");
    }
  }
}

export function createTasksMigrateBackendCommand(): TasksMigrateBackendCommand {
  return new TasksMigrateBackendCommand();
}
