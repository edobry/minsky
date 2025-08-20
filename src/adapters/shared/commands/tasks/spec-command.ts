/**
 * Task Specification Command
 *
 * Command for retrieving task specifications.
 * Extracted from tasks.ts as part of modularization effort.
 */
import { type CommandExecutionContext } from "../../command-registry";
import { getTaskSpecContentFromParams } from "../../../../domain/tasks";
import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import { tasksSpecParams } from "./task-parameters";

/**
 * Parameters for tasks spec command
 */
interface TasksSpecParams extends BaseTaskParams {
  taskId: string;
  section?: string;
}

/**
 * Task specification command implementation
 */
export class TasksSpecCommand extends BaseTaskCommand {
  readonly id = "tasks.spec";
  readonly name = "spec";
  readonly description = "Get task specification content";
  readonly parameters = tasksSpecParams;

  async execute(params: TasksSpecParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.spec execution");

    // Validate and normalize task ID
    const taskId = this.validateRequired(params.taskId, "taskId");
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    // Get task specification
    const specResult = await getTaskSpecContentFromParams({
      ...this.createTaskParams(params),
      taskId: validatedTaskId,
      section: params.section,
    });

    this.debug("Task specification retrieved successfully");

    // For spec command, we typically want to return the content directly
    // unless JSON format is explicitly requested
    if (params.json) {
      return this.createSuccessResult(validatedTaskId, "Task specification retrieved", {
        task: specResult.task,
        specPath: specResult.specPath,
        content: specResult.content,
        section: params.section,
      });
    } else {
      // Return the specification content directly for easy viewing
      return specResult.content;
    }
  }
}

/**
 * Factory function for creating command instance
 */
export const createTasksSpecCommand = (): TasksSpecCommand => new TasksSpecCommand();
