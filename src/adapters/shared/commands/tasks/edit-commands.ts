/**
 * Task Edit Commands
 *
 * Commands for editing existing tasks (title and specification content).
 * Supports multi-backend editing with proper delegation to backend implementations.
 */
import { type CommandExecutionContext } from "../../command-registry";
import { ValidationError, ResourceNotFoundError } from "../../../../errors/index";
import { getErrorMessage } from "../../../../errors/index";
import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import { tasksEditParams } from "./task-parameters";
import { getTaskFromParams } from "../../../../domain/tasks";
import type { Task } from "../../../../domain/tasks/types";
import type { PersistenceProvider } from "../../../../domain/persistence/types";
import type { TaskServiceInterface } from "../../../../domain/tasks/taskService";
import { promises as fs } from "fs";
import { readTextFile } from "../../../../utils/fs";
import { spawn } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import { autoIndexTaskEmbedding } from "./auto-index-embedding";

/**
 * Parameters for tasks edit command
 */
interface TasksEditParams extends BaseTaskParams {
  taskId: string;
  title?: string;
  spec?: boolean;
  specFile?: string;
  specContent?: string;
  tag?: string | string[];
  execute?: boolean;
}

/**
 * Task edit command implementation
 *
 * Supports editing both task title and specification content with multiple input methods:
 * - Title: Direct string input via --title
 * - Spec: Interactive editor via --spec, file input via --spec-file, or direct content via --spec-content
 *
 * By default shows a preview of changes. Use --execute to apply the changes.
 */
export class TasksEditCommand extends BaseTaskCommand<TasksEditParams> {
  readonly id = "tasks.edit";
  readonly name = "edit";
  readonly description =
    "Edit task title and/or specification content (dry-run by default, use --execute to apply)";
  readonly parameters = tasksEditParams;

  constructor(
    private readonly getPersistenceProvider?: () => PersistenceProvider,
    private readonly getTaskService?: () => TaskServiceInterface
  ) {
    super();
  }

  async execute(params: TasksEditParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.edit execution");

    // Validate required parameters
    const taskId = this.validateRequired(params.taskId, "taskId");
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    // Validate that at least one edit operation is specified
    const hasSpecOperation = !!(params.spec || params.specFile || params.specContent);
    const hasTagOperation = params.tag !== undefined;

    if (!params.title && !hasSpecOperation && !hasTagOperation) {
      throw new ValidationError(
        `${
          chalk.red("❌ At least one edit operation must be specified:\n") +
          chalk.gray("  --title <text>       ")
        }Update task title\n${chalk.gray(
          "  --spec               "
        )}Edit specification content interactively\n${chalk.gray(
          "  --spec-file <path>   "
        )}Update specification from file\n${chalk.gray(
          "  --spec-content <text>"
        )} Replace specification content\n\n${chalk.yellow(
          "💡 Tip: "
        )}For advanced editing with patterns, use: ${chalk.cyan(
          "minsky tasks spec edit"
        )}\n\n${chalk.bold("Examples:\n")}${chalk.gray(
          "  # Preview changes (default)\n"
        )}${chalk.gray('  minsky tasks edit mt#123 --title "New Title"\n')}${chalk.gray(
          "  # Apply changes\n"
        )}${chalk.gray('  minsky tasks edit mt#123 --title "New Title" --execute\n')}${chalk.gray(
          "  # Edit from file\n"
        )}${chalk.gray(
          "  minsky tasks edit mt#123 --spec-file /path/to/spec.md --execute\n"
        )}${chalk.gray('  minsky tasks edit mt#123 --spec-content "New spec content" --execute')}`
      );
    }

    // Validate that only one spec operation is specified at a time
    const specOperations = [params.spec, params.specFile, params.specContent].filter(Boolean);

    if (specOperations.length > 1) {
      throw new ValidationError(
        "Only one specification editing operation can be specified at a time:\n" +
          "  --spec               Interactive editor\n" +
          "  --spec-file <path>   Read from file\n" +
          "  --spec-content <text> Direct content"
      );
    }

    // Verify the task exists and get current data
    this.debug("Verifying task exists");

    const currentTask = await getTaskFromParams(
      {
        ...this.createTaskParams(params),
        taskId: validatedTaskId,
      },
      { persistenceProvider: this.getPersistenceProvider?.(), taskService: this.getTaskService?.() }
    );

    if (!currentTask) {
      throw new ResourceNotFoundError(
        `${
          chalk.red(`❌ Task "${validatedTaskId}" not found.\n`) + chalk.yellow("💡 Tip: ")
        }Use ${chalk.cyan("minsky tasks list")} to see available tasks`,
        "task",
        validatedTaskId
      );
    }

    this.debug("Task found, preparing updates");

    // Prepare the updates object
    const updates: { title?: string; spec?: string; tags?: string[] } = {};

    // Handle title update
    if (params.title) {
      updates.title = params.title;
      this.debug(`Title update: "${params.title}"`);
    }

    // Handle spec content update
    if (params.spec || params.specFile || params.specContent) {
      let newSpecContent: string;

      if (params.specContent) {
        // Direct content
        newSpecContent = params.specContent;
        this.debug("Using direct spec content");
      } else if (params.specFile) {
        // Read from file
        try {
          newSpecContent = await readTextFile(params.specFile);
          this.debug(`Read spec content from file: ${params.specFile}`);
        } catch (error) {
          throw new ValidationError(
            `Failed to read spec file "${params.specFile}": ${getErrorMessage(error)}`
          );
        }
      } else if (params.spec) {
        // Interactive editor
        newSpecContent = await this.openEditorForSpec(currentTask);
        this.debug("Got spec content from interactive editor");
      }

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      updates.spec = newSpecContent!;
    }

    // Handle tags update
    if (hasTagOperation) {
      const newTags = params.tag ? (Array.isArray(params.tag) ? params.tag : [params.tag]) : [];
      if (newTags.length > 0) {
        const invalidTags = newTags.filter((t) => t.startsWith("minsky:"));
        if (invalidTags.length > 0) {
          throw new ValidationError(
            `Tags cannot use the reserved "minsky:" prefix: ${invalidTags.join(", ")}`
          );
        }
      }
      updates.tags = newTags;
      this.debug(`Tags update: ${JSON.stringify(newTags)}`);
    }

    // Show preview if not executing
    if (!params.execute && (updates.title || updates.spec || updates.tags)) {
      return this.formatResult(
        this.createSuccessResult(
          validatedTaskId,
          this.buildPreviewMessage(currentTask, updates, validatedTaskId)
        ),
        params.json
      );
    }

    // Apply the updates using the backend's setTaskMetadata method
    this.debug("Applying updates to task");

    try {
      // Get the appropriate backend for this task using the DI-injected task service
      if (!this.getTaskService) {
        throw new Error(
          "TaskService not available. " +
            "Ensure the DI container is initialized with a taskService factory."
        );
      }
      const service = this.getTaskService();

      // Access internal multi-backend methods via a typed extension interface
      type ServiceWithBackendAccess = typeof service & {
        parsePrefixFromId(taskId: string): string | null;
        getBackendByPrefix(
          prefix: string | null
        ): { name: string; setTaskMetadata?: (...args: unknown[]) => Promise<void> } | null;
      };
      const serviceWithAccess = service as ServiceWithBackendAccess;

      // Get the backend that manages this task
      const backend = serviceWithAccess.getBackendByPrefix(
        serviceWithAccess.parsePrefixFromId(validatedTaskId)
      );
      if (!backend) {
        throw new ValidationError(`No backend found for task ID: ${validatedTaskId}`);
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
        await backend.setTaskMetadata(validatedTaskId, {
          id: validatedTaskId,
          title: updates.title || currentTask.title,
          spec: updates.spec,
          status: currentTask.status,
          backend: currentTask.backend || backend.name,
          updatedAt: new Date(),
        });
        this.debug("Updated task metadata with title and/or spec");
      } else if (updates.title) {
        // Title-only update via updateTask
        await service.updateTask?.(validatedTaskId, { title: updates.title });
        this.debug("Updated task title only");
      }

      // Apply tags update separately (tags are stored as JSON in the tasks table)
      if (updates.tags !== undefined) {
        await service.updateTask?.(validatedTaskId, { tags: updates.tags });
        this.debug("Updated task tags");
      }

      // Fire-and-forget embedding re-index if content that affects embeddings changed
      if ((updates.title || updates.spec) && this.getPersistenceProvider && this.getTaskService) {
        autoIndexTaskEmbedding(validatedTaskId, {
          getPersistenceProvider: this.getPersistenceProvider,
          getTaskService: this.getTaskService,
        });
      }

      const message = this.buildUpdateMessage(updates, validatedTaskId);
      this.debug("Task edit completed successfully");

      // Build detailed success message
      let detailedMessage = message;
      if (!params.json) {
        if (updates.spec) {
          detailedMessage = chalk.green("✅ Task specification updated successfully");
        } else if (updates.title) {
          detailedMessage = chalk.green("✅ Task title updated successfully");
        }

        // Show what was changed
        if (updates.title) {
          detailedMessage += `\n${chalk.gray("  Previous: ")}${currentTask.title}`;
          detailedMessage += `\n${chalk.gray("  Updated:  ")}${updates.title}`;
        }
        if (updates.spec) {
          const specLines = updates.spec.split("\n").length;
          detailedMessage += `\n${chalk.gray(`  Specification: ${specLines} lines`)}`;
        }
      }

      return this.formatResult(
        this.createSuccessResult(validatedTaskId, params.json ? message : detailedMessage, {
          updates,
          task: {
            id: validatedTaskId,
            title: updates.title || currentTask.title,
            status: currentTask.status,
            backend: currentTask.backend,
          },
          previousValues: {
            title: currentTask.title,
            spec: currentTask.spec,
          },
        }),
        params.json
      );
    } catch (error) {
      this.debug(`Task edit failed: ${getErrorMessage(error)}`);

      // Ensure non-zero exit code
      process.exitCode = 1;

      // Build actionable error message for non-JSON output
      if (!params.json) {
        const errorMsg = getErrorMessage(error);
        let errorMessage = "";
        if (errorMsg.includes("Backend") && errorMsg.includes("does not support")) {
          errorMessage = chalk.red(
            `❌ Failed to update task specification: Backend does not support specification editing`
          );
          errorMessage += `\n${chalk.yellow(
            "   Tip: Some backends may have limited editing capabilities. Check backend documentation."
          )}`;
        } else if (errorMsg.includes("Failed to read spec file")) {
          errorMessage = chalk.red(`❌ Failed to update task specification: ${errorMsg}`);
          errorMessage += `\n${chalk.yellow("   Tip: Ensure the file exists and you have read permissions.")}`;
        } else {
          errorMessage = chalk.red(`❌ Failed to update task: ${errorMsg}`);
        }

        // Create a new error with the formatted message
        const formattedError = new Error(errorMessage);
        formattedError.stack = error instanceof Error ? error.stack : undefined;
        throw formattedError;
      }

      throw error;
    }
  }

  /**
   * Open an interactive editor for spec content
   */
  private async openEditorForSpec(currentTask: Task): Promise<string> {
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    // Create a temporary file with current spec content
    const tempDir = tmpdir();
    // Use Math.random for a simple unique suffix (no crypto needed for temp filenames)
    const uniqueSuffix = Math.random().toString(36).slice(2, 10);
    const tempFile = join(tempDir, `task-${uniqueSuffix}.md`);

    try {
      // Write current spec content to temp file
      const currentSpec =
        currentTask.spec ||
        `# ${currentTask.title}\n\n## Requirements\n\n## Solution\n\n## Notes\n\n`;
      await fs.writeFile(tempFile, currentSpec, "utf-8");

      // Determine editor to use
      const editor = process.env.EDITOR || process.env.VISUAL || "nano";

      this.debug(`Opening editor: ${editor} ${tempFile}`);

      // Spawn editor in interactive mode
      const _execFile = promisify(spawn);
      const child = spawn(editor, [tempFile], {
        stdio: "inherit",
        detached: false,
      });

      await new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Editor exited with code ${code}`));
          }
        });
        child.on("error", reject);
      });

      // Read the edited content
      const editedContent = await readTextFile(tempFile);

      // Clean up temp file
      try {
        await fs.unlink(tempFile);
      } catch (unlinkError) {
        // Ignore cleanup errors
        this.debug(
          `Failed to cleanup temp file: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`
        );
      }

      return editedContent;
    } catch (error) {
      // Ensure cleanup on error
      try {
        await fs.unlink(tempFile);
      } catch (unlinkError) {
        // Ignore cleanup errors
      }
      throw new ValidationError(`Failed to open editor: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Build a descriptive update message
   */
  private buildUpdateMessage(
    updates: { title?: string; spec?: string; tags?: string[] },
    taskId: string
  ): string {
    const parts: string[] = [];

    if (updates.title) {
      parts.push("title");
    }
    if (updates.spec) {
      parts.push("specification");
    }
    if (updates.tags !== undefined) {
      parts.push("tags");
    }

    return `Task ${taskId} ${parts.join(" and ")} updated successfully`;
  }

  /**
   * Build preview message showing actual changes
   */
  private buildPreviewMessage(
    currentTask: Task,
    updates: { title?: string; spec?: string; tags?: string[] },
    taskId: string
  ): string {
    let message = `${chalk.blue("Preview of changes for task")} ${taskId}:\n\n`;

    if (updates.title) {
      message += `${chalk.bold("Title change:")}\n`;
      message += `  ${chalk.red("- ")}${currentTask.title}\n`;
      message += `  ${chalk.green("+ ")}${updates.title}\n\n`;
    }

    if (updates.spec) {
      message += `${chalk.bold("Specification change:")}\n`;

      const currentSpec = currentTask.spec || "";
      const newSpec = updates.spec;

      // Show first few lines of each for preview
      const currentPreview = currentSpec.split("\n").slice(0, 5).join("\n");
      const newPreview = newSpec.split("\n").slice(0, 5).join("\n");

      if (currentSpec.split("\n").length > 5) {
        const remainingLines = currentSpec.split("\n").length - 5;
        message += `  ${chalk.red("- ")}${currentPreview}\n  ${chalk.gray(`... (${remainingLines} more lines)`)}\n`;
      } else {
        message += `  ${chalk.red("- ")}${currentPreview}\n`;
      }

      if (newSpec.split("\n").length > 5) {
        const remainingLines = newSpec.split("\n").length - 5;
        message += `  ${chalk.green("+ ")}${newPreview}\n  ${chalk.gray(`... (${remainingLines} more lines)`)}\n\n`;
      } else {
        message += `  ${chalk.green("+ ")}${newPreview}\n\n`;
      }
    }

    if (updates.tags !== undefined) {
      message += `${chalk.bold("Tags change:")}\n`;
      const currentTags = currentTask.tags || [];
      message += `  ${chalk.red("- ")}${currentTags.length > 0 ? currentTags.join(", ") : "(none)"}\n`;
      message += `  ${chalk.green("+ ")}${updates.tags.length > 0 ? updates.tags.join(", ") : "(none)"}\n\n`;
    }

    message += `${chalk.yellow("To apply these changes, run with")} ${chalk.cyan("--execute")}`;

    return message;
  }
}

/**
 * Factory function for creating the edit command
 */
export function createTasksEditCommand(
  getPersistenceProvider?: () => PersistenceProvider,
  getTaskService?: () => TaskServiceInterface
): TasksEditCommand {
  return new TasksEditCommand(getPersistenceProvider, getTaskService);
}
