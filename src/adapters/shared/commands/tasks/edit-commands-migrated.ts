/**
 * Task Edit Commands - DatabaseCommand Migration
 *
 * This command migrates from the old pattern (using PersistenceService.getProvider() via domain layer)
 * to the new DatabaseCommand pattern with automatic provider injection.
 *
 * MIGRATION NOTES:
 * - OLD: Extended BaseTaskCommand, used createConfiguredTaskService() that internally calls PersistenceService.getProvider()
 * - NEW: Extends DatabaseCommand, passes injected provider to createConfiguredTaskService via dependency injection
 * - BENEFIT: No singleton access, proper dependency injection, lazy initialization
 */

import {
  DatabaseCommand,
  DatabaseCommandContext,
} from "../../../../domain/commands/database-command";
import { CommandCategory } from "../../command-registry";
import { ValidationError, ResourceNotFoundError } from "../../../../errors/index";
import { tasksEditParams } from "./task-parameters";
import { getTaskFromParams } from "../../../../domain/tasks";
import { log } from "../../../../utils/logger";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import { promisify } from "util";
import chalk from "chalk";

/**
 * Task edit command - migrated to DatabaseCommand
 *
 * Supports editing both task title and specification content with multiple input methods:
 * - Title: Direct string input via --title
 * - Spec: Interactive editor via --spec, file input via --spec-file, or direct content via --spec-content
 *
 * By default shows a preview of changes. Use --execute to apply the changes.
 */
export class TasksEditCommand extends DatabaseCommand {
  readonly id = "tasks.edit";
  readonly category = CommandCategory.TASKS;
  readonly name = "edit";
  readonly description =
    "Edit task title and/or specification content (dry-run by default, use --execute to apply)";
  readonly parameters = tasksEditParams;

  async execute(
    params: {
      taskId: string;
      title?: string;
      spec?: boolean;
      specFile?: string;
      specContent?: string;
      execute?: boolean;
      backend?: string;
      repo?: string;
      workspace?: string;
      session?: string;
      json?: boolean;
    },
    context: DatabaseCommandContext
  ) {
    const { provider } = context;

    log.debug("Starting tasks.edit execution");

    // Validate required parameters
    if (!params.taskId) {
      throw new ValidationError("taskId is required");
    }

    // Validate that at least one edit operation is specified
    const hasSpecOperation = !!(params.spec || params.specFile || params.specContent);

    if (!params.title && !hasSpecOperation) {
      throw new ValidationError(
        `${`${
          chalk.red("❌ At least one edit operation must be specified:\n") +
          chalk.gray("  --title <text>       ")
        }Update task title\n${chalk.gray(
          "  --spec               "
        )}Edit spec in editor\n${chalk.gray("  --spec-file <path>   ")}Read from file\n${chalk.gray(
          "  --spec-content <text> "
        )}Direct content`}`
      );
    }

    // Verify the task exists and get current data - pass provider for dependency injection
    log.debug("Verifying task exists");

    const currentTask = await getTaskFromParams(
      {
        taskId: params.taskId,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
        json: true,
      },
      {
        createConfiguredTaskService: async (options) => {
          const { createConfiguredTaskService } = await import(
            "../../../../domain/tasks/taskService"
          );
          return await createConfiguredTaskService({
            ...options,
            persistenceProvider: provider,
          });
        },
      }
    );

    if (!currentTask) {
      throw new ResourceNotFoundError(
        `${
          chalk.red(`❌ Task "${params.taskId}" not found.\n`) + chalk.yellow("💡 Tip: ")
        }Use ${chalk.cyan("minsky tasks list")} to see available tasks`,
        "task",
        params.taskId
      );
    }

    log.debug("Task found, preparing updates");

    // Prepare the updates object
    const updates: { title?: string; spec?: string } = {};

    // Handle title update
    if (params.title) {
      updates.title = params.title;
      log.debug(`Title update: "${params.title}"`);
    }

    // Handle spec content update
    if (params.spec || params.specFile || params.specContent) {
      let newSpecContent: string;

      if (params.specContent) {
        // Direct content
        newSpecContent = params.specContent;
        log.debug("Using direct spec content");
      } else if (params.specFile) {
        // Read from file
        try {
          newSpecContent = await fs.readFile(params.specFile, "utf-8");
          log.debug(`Read spec content from file: ${params.specFile}`);
        } catch (error) {
          throw new ValidationError(
            `Failed to read spec file "${params.specFile}": ${(error as Error).message}`
          );
        }
      } else if (params.spec) {
        // Interactive editor
        newSpecContent = await this.openInteractiveEditor(
          currentTask.spec ||
            `# ${currentTask.title}\n\n## Description\n\n[Add task description here]\n\n## Requirements\n\n- [ ] Requirement 1\n\n## Notes\n\n[Add any additional notes here]`
        );
        log.debug("Got spec content from interactive editor");
      } else {
        newSpecContent = "";
      }

      updates.spec = newSpecContent;
    }

    // Show preview unless --execute is specified
    if (!params.execute) {
      return this.showPreview(currentTask, updates, params.json);
    }

    // Apply the updates using the backend's setTaskMetadata method - pass provider for dependency injection
    log.debug("Applying updates to task");

    try {
      // Get the appropriate backend for this task
      const { createConfiguredTaskService } = await import("../../../../domain/tasks/taskService");
      const { resolveRepoPath } = await import("../../../../domain/workspace");
      const { resolveMainWorkspacePath } = await import("../../../../domain/workspace");

      const service = await createConfiguredTaskService({
        workspacePath: params.repo
          ? await resolveRepoPath(params.repo)
          : await resolveMainWorkspacePath(),
        backend: params.backend,
        persistenceProvider: provider, // Pass injected provider
      });

      // Get the backend that manages this task
      const backend = service.getBackendByPrefix(service.parsePrefixFromId(params.taskId));
      if (!backend) {
        throw new ValidationError(`No backend found for task ID: ${params.taskId}`);
      }

      // Check if backend supports setTaskMetadata for spec updates
      if (updates.spec && !backend.setTaskMetadata) {
        throw new ValidationError(
          `Backend "${backend.name}" does not support specification editing`
        );
      }

      // Apply updates
      if (updates.spec && backend.setTaskMetadata) {
        // Update both title and spec via setTaskMetadata
        await backend.setTaskMetadata(params.taskId, {
          id: params.taskId,
          title: updates.title || currentTask.title,
          spec: updates.spec,
          status: currentTask.status,
          backend: currentTask.backend || backend.name,
          updatedAt: new Date(),
        });
        log.debug("Updated task metadata with title and/or spec");
      } else if (updates.title) {
        // Title-only update via updateTask
        await service.updateTask(params.taskId, { title: updates.title });
        log.debug("Updated task title only");
      }

      const message = this.buildUpdateMessage(updates, params.taskId);
      log.debug("Task edit completed successfully");

      // Build detailed success message
      let detailedMessage = message;
      if (!params.json) {
        if (updates.spec) {
          detailedMessage = chalk.green("✅ Task specification updated successfully");
        } else if (updates.title) {
          detailedMessage = chalk.green("✅ Task title updated successfully");
        }
      }

      return {
        success: true,
        taskId: params.taskId,
        message: detailedMessage,
        updates,
        task: {
          ...currentTask,
          ...updates,
          updatedAt: new Date(),
        },
      };
    } catch (error) {
      log.error("Failed to update task", { error: (error as Error).message });
      throw error;
    }
  }

  private async openInteractiveEditor(initialContent: string): Promise<string> {
    const tempFile = `/tmp/minsky-task-edit-${Date.now()}.md`;

    try {
      // Write initial content to temp file
      await fs.writeFile(tempFile, initialContent);

      // Open editor
      const editor = process.env.EDITOR || "nano";
      const spawn = require("child_process").spawn;
      const child = spawn(editor, [tempFile], { stdio: "inherit" });

      await new Promise((resolve, reject) => {
        child.on("close", (code: number) => {
          if (code === 0) {
            resolve(code);
          } else {
            reject(new Error(`Editor exited with code ${code}`));
          }
        });
      });

      // Read the edited content
      const editedContent = await fs.readFile(tempFile, "utf-8");
      return editedContent;
    } finally {
      // Clean up temp file
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private showPreview(
    currentTask: any,
    updates: { title?: string; spec?: string },
    wantJson?: boolean
  ) {
    if (wantJson) {
      return {
        success: true,
        preview: true,
        taskId: currentTask.id,
        currentValues: {
          title: currentTask.title,
          spec: currentTask.spec || "",
        },
        proposedChanges: updates,
        message: "Preview mode - use --execute to apply changes",
      };
    }

    const changes = [];

    if (updates.title && updates.title !== currentTask.title) {
      changes.push(
        `${chalk.yellow("Title:")}\n  ${chalk.red(`- ${currentTask.title}`)}` +
          `\n  ${chalk.green(`+ ${updates.title}`)}`
      );
    }

    if (updates.spec !== undefined) {
      const currentSpec = currentTask.spec || "";
      if (updates.spec !== currentSpec) {
        changes.push(
          `${chalk.yellow(
            "Specification:"
          )}\n  ${chalk.gray(`(Content changed - ${updates.spec.length} chars)`)}`
        );
      }
    }

    const previewMessage =
      changes.length > 0
        ? chalk.cyan("🔍 Preview of changes:\n\n") + changes.join("\n\n")
        : chalk.yellow("ℹ️  No changes detected");

    return {
      success: true,
      preview: true,
      taskId: currentTask.id,
      message: `${previewMessage}\n\n${chalk.gray("Use --execute to apply these changes")}`,
    };
  }

  private buildUpdateMessage(updates: { title?: string; spec?: string }, taskId: string): string {
    const parts = [];
    if (updates.title) parts.push("title");
    if (updates.spec !== undefined) parts.push("specification");

    return `Task ${taskId} ${parts.join(" and ")} updated successfully`;
  }
}

/**
 * MIGRATION SUMMARY FOR EDIT COMMAND:
 *
 * 1. Changed from BaseTaskCommand to DatabaseCommand
 * 2. Added required category property (CommandCategory.TASKS)
 * 3. Updated execute method to receive DatabaseCommandContext with provider
 * 4. Replaced internal PersistenceService.getProvider() calls with injected provider
 * 5. Updated all createConfiguredTaskService calls to pass provider via dependency injection
 * 6. Updated getTaskFromParams call to pass provider via dependency injection
 * 7. Preserved all complex editing functionality (interactive editor, file I/O, previews)
 *
 * BENEFITS:
 * - Automatic provider initialization via CommandDispatcher
 * - Type-safe parameter handling with DatabaseCommand
 * - Clean dependency injection for testing
 * - No manual PersistenceService calls needed
 * - Lazy initialization - no upfront database connections
 * - All interactive editing features preserved
 */
