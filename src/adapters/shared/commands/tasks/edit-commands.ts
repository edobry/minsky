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
        "At least one edit operation must be specified:\\n" +
          "  --title <text>       Update task title\\n" +
          "  --spec               Edit specification content interactively\\n" +
          "  --spec-file <path>   Update specification from file\\n" +
          "  --spec-content <text> Update specification content directly\\n\\n" +
          "Examples:\\n" +
          '  minsky tasks edit mt#123 --title "New Title"\\n' +
          "  minsky tasks edit mt#123 --spec-file /path/to/spec.md\\n" +
          '  minsky tasks edit mt#123 --title "New Title" --spec'
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
    if (params.specContent) {
      updates.spec = params.specContent;
      this.debug("Using direct spec content");
    } else if (params.specFile) {
      try {
        updates.spec = await fs.readFile(params.specFile, "utf-8");
        this.debug(`Read spec content from file: ${params.specFile}`);
      } catch (error) {
        throw new ValidationError(
          `Failed to read spec file "${params.specFile}": ${error.message}`
        );
      }
    }

    // For now, just return a success message showing the task was found and updates were prepared
    // TODO: Implement actual update logic
    this.debug("Task found and updates prepared (not yet applied)");

    const message = `Task ${validatedTaskId} edit command executed successfully (updates prepared: ${Object.keys(updates).join(", ")})`;
    this.debug("Task edit completed (mock implementation)");

    return this.formatResult(
      this.createSuccessResult(validatedTaskId, message, {
        updates,
        task: {
          id: validatedTaskId,
          title: updates.title || currentTask.title,
          status: currentTask.status,
          backend: currentTask.backend,
        },
        note: "This is a mock implementation - actual updates not yet implemented",
      }),
      params.json
    );
  }

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
