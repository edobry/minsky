/**
 * Task Edit Commands
 *
 * Commands for editing existing tasks (title and specification content).
 * Supports multi-backend editing with proper delegation to backend implementations.
 */
import { type CommandExecutionContext } from "../../command-registry";
import { ValidationError, ResourceNotFoundError } from "../../../../errors/index";
import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import { tasksEditParams } from "./task-parameters";
import { getTaskFromParams } from "../../../../domain/tasks";
import { log } from "../../../../utils/logger";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import { promisify } from "util";

/**
 * Parameters for tasks edit command
 */
interface TasksEditParams extends BaseTaskParams {
  taskId: string;
  title?: string;
  spec?: boolean;
  specFile?: string;
  specContent?: string;
}

/**
 * Task edit command implementation
 *
 * Supports editing both task title and specification content with multiple input methods:
 * - Title: Direct string input via --title
 * - Spec: Interactive editor via --spec, file input via --spec-file, or direct content via --spec-content
 */
export class TasksEditCommand extends BaseTaskCommand {
  readonly id = "tasks.edit";
  readonly name = "edit";
  readonly description = "Edit task title and/or specification content";
  readonly parameters = tasksEditParams;

  async execute(params: TasksEditParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.edit execution");

    // Validate required parameters
    const taskId = this.validateRequired(params.taskId, "taskId");
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    // Validate that at least one edit operation is specified
    if (!params.title && !params.spec && !params.specFile && !params.specContent) {
      throw new ValidationError(
        "At least one edit operation must be specified:\n" +
          "  --title <text>       Update task title\n" +
          "  --spec               Edit specification content interactively\n" +
          "  --spec-file <path>   Update specification from file\n" +
          "  --spec-content <text> Update specification content directly\n\n" +
          "Examples:\n" +
          '  minsky tasks edit mt#123 --title "New Title"\n' +
          "  minsky tasks edit mt#123 --spec-file /path/to/spec.md\n" +
          '  minsky tasks edit mt#123 --title "New Title" --spec'
      );
    }

    // Validate mutually exclusive spec options
    const specOptions = [params.spec, params.specFile, params.specContent].filter(Boolean);
    if (specOptions.length > 1) {
      throw new ValidationError(
        "Only one specification edit method can be used at a time:\n" +
          "  --spec               Interactive editor\n" +
          "  --spec-file <path>   Read from file\n" +
          "  --spec-content <text> Direct content"
      );
    }

    // Verify the task exists and get current data
    this.debug("Verifying task exists");
    const currentTask = await getTaskFromParams({
      ...this.createTaskParams(params),
      taskId: validatedTaskId,
    });

    if (!currentTask) {
      throw new ResourceNotFoundError(
        `Task "${validatedTaskId}" not found`,
        "task",
        validatedTaskId
      );
    }

    this.debug("Task found, preparing updates");

    // Prepare the updates object
    const updates: { title?: string; spec?: string } = {};

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
          newSpecContent = await fs.readFile(params.specFile, "utf-8");
          this.debug(`Read spec content from file: ${params.specFile}`);
        } catch (error) {
          throw new ValidationError(
            `Failed to read spec file "${params.specFile}": ${error.message}`
          );
        }
      } else if (params.spec) {
        // Interactive editor
        newSpecContent = await this.openEditorForSpec(currentTask);
        this.debug("Got spec content from interactive editor");
      }

      updates.spec = newSpecContent!;
    }

    // Apply the updates using the backend's setTaskMetadata method
    this.debug("Applying updates to task");

    try {
      // Get the appropriate backend for this task
      const { createConfiguredTaskService } = await import(
        "../../../../domain/tasks/multi-backend-service"
      );
      const { resolveRepoPath } = await import("../../../../domain/workspace");
      const { resolveMainWorkspacePath } = await import(
        "../../../../domain/workspace/workspace-resolver"
      );

      const service = await createConfiguredTaskService({
        repoPath: params.repo
          ? await resolveRepoPath(params.repo)
          : await resolveMainWorkspacePath(),
        sessionName: params.session,
        backend: params.backend,
      });

      // Get the backend that manages this task
      const backend = service.getBackendByPrefix(service.parsePrefixFromId(validatedTaskId));
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
        await service.updateTask(validatedTaskId, { title: updates.title });
        this.debug("Updated task title only");
      }

      const message = this.buildUpdateMessage(updates, validatedTaskId);
      this.debug("Task edit completed successfully");

      return this.formatResult(
        this.createSuccessResult(validatedTaskId, message, {
          updates,
          task: {
            id: validatedTaskId,
            title: updates.title || currentTask.title,
            status: currentTask.status,
            backend: currentTask.backend,
          },
        }),
        params.json
      );
    } catch (error) {
      this.debug(`Task edit failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Open an interactive editor for spec content
   */
  private async openEditorForSpec(currentTask: any): Promise<string> {
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { randomBytes } = await import("crypto");

    // Create a temporary file with current spec content
    const tempDir = tmpdir();
    const tempFile = join(tempDir, `task-${randomBytes(8).toString("hex")}.md`);

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
      const execFile = promisify(spawn);
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
      const editedContent = await fs.readFile(tempFile, "utf-8");

      // Clean up temp file
      try {
        await fs.unlink(tempFile);
      } catch (unlinkError) {
        // Ignore cleanup errors
        this.debug(`Failed to cleanup temp file: ${unlinkError.message}`);
      }

      return editedContent;
    } catch (error) {
      // Ensure cleanup on error
      try {
        await fs.unlink(tempFile);
      } catch (unlinkError) {
        // Ignore cleanup errors
      }
      throw new ValidationError(`Failed to open editor: ${error.message}`);
    }
  }

  /**
   * Build a descriptive update message
   */
  private buildUpdateMessage(updates: { title?: string; spec?: string }, taskId: string): string {
    const parts: string[] = [];

    if (updates.title && updates.spec) {
      parts.push("title and specification");
    } else if (updates.title) {
      parts.push("title");
    } else if (updates.spec) {
      parts.push("specification");
    }

    return `Task ${taskId} ${parts.join(" and ")} updated successfully`;
  }
}

/**
 * Factory function for creating the edit command
 */
export function createTasksEditCommand(): TasksEditCommand {
  return new TasksEditCommand();
}
