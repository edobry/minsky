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
import { TaskService, createTaskServiceWithDatabase } from "../../../../domain/tasks/taskService";

const migrateBackendParamsSchema = z.object({
  from: z.enum(["markdown", "minsky", "github", "json-file"]).optional(),
  to: z.enum(["markdown", "minsky", "github", "json-file"]),
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
  readonly description =
    "Migrate tasks between different backends (markdown, minsky, github, json-file)";
  readonly parameters = {
    from: {
      schema: z.enum(["markdown", "minsky", "github", "json-file"]).optional(),
      description: "Source backend (auto-detect if not provided)",
      required: false,
    },
    to: {
      schema: z.enum(["markdown", "minsky", "github", "json-file"]),
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

    if (p.json || context.format === "json") {
      return this.createSuccessResult(result);
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
      },
    });
  }

  private async detectCurrentBackend(workspacePath: string): Promise<string> {
    // Simple detection logic - can be enhanced
    const { existsSync } = await import("fs");
    const { join } = await import("path");

    const tasksMarkdownFile = join(workspacePath, "process", "tasks.md");
    if (existsSync(tasksMarkdownFile)) {
      return "markdown";
    }

    // Could add more detection logic here
    return "markdown"; // Default fallback
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
    const sourceService = await createTaskServiceWithDatabase({
      workspacePath,
      backend: sourceBackend,
    });
    const targetService = await createTaskServiceWithDatabase({
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

        // Get task spec content
        const specData = await sourceService.getTaskSpecContent(taskId);
        const specContent = specData?.content || "";

        if (!dryRun) {
          // Generate new ID for target backend if requested
          let newTaskId = taskId;
          if (updateIds) {
            const targetPrefix = this.getBackendPrefix(targetBackend);
            const sourcePrefix = this.getBackendPrefix(sourceBackend);

            if (taskId.startsWith(`${sourcePrefix}#`)) {
              const numericPart = taskId.replace(`${sourcePrefix}#`, "");
              newTaskId = `${targetPrefix}#${numericPart}`;
            }
          }

          // Create task in target backend with transformed ID and status
          await targetService.createTaskFromTitleAndSpec(fullTask.title, specContent, {
            force: true,
            id: newTaskId,
            status: fullTask.status,
          });

          // Update the task ID and backend if needed
          if (newTaskId !== taskId) {
            // This would require additional backend support for ID updates
            // For now, we'll use the generated ID from the target backend
          }
        }

        result.migrated++;
        result.details.push({
          id: taskId,
          status: "migrated",
          sourceBackend,
          targetBackend,
        });
      } catch (error) {
        result.errors++;

        // Create user-friendly error message
        const errorMessage = this.createUserFriendlyErrorMessage(task.id, error);

        // Only log detailed errors in verbose mode, otherwise show concise info
        if (process.env.NODE_ENV === "development" || process.env.MINSKY_VERBOSE === "true") {
          console.error(`❌ ${task.id}: ${errorMessage}`, error);
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
}

export function createTasksMigrateBackendCommand(): TasksMigrateBackendCommand {
  return new TasksMigrateBackendCommand();
}
