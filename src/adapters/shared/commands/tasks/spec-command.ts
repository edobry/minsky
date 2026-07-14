/**
 * Task Specification Command
 *
 * Command for retrieving task specifications.
 * Extracted from tasks.ts as part of modularization effort.
 */
import { type CommandExecutionContext, type InferParams } from "../../command-registry";
import { getTaskSpecContentFromParams } from "@minsky/domain/tasks";
import { BaseTaskCommand } from "./base-task-command";
import { tasksSpecParams } from "./task-parameters";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";

/**
 * Task specification command implementation
 */
export class TasksSpecCommand extends BaseTaskCommand<typeof tasksSpecParams, unknown> {
  readonly id = "tasks.spec.get";
  readonly name = "get";
  readonly description = "Get task specification content";
  readonly parameters = tasksSpecParams;

  constructor(
    private readonly getPersistenceProvider?: () => PersistenceProvider,
    private readonly getTaskService?: () => TaskServiceInterface
  ) {
    super();
  }

  async execute(params: InferParams<typeof tasksSpecParams>, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.spec execution");

    // Validate and normalize task ID
    const taskId = this.validateRequired(params.taskId, "taskId");
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    // Get task specification
    const specResult = await getTaskSpecContentFromParams(
      {
        ...this.createTaskParams(params),
        taskId: validatedTaskId,
        section: params.section,
      },
      { persistenceProvider: this.getPersistenceProvider?.(), taskService: this.getTaskService?.() }
    );

    this.debug("Task specification retrieved successfully");

    // For spec command, we typically want to return the content directly
    // unless JSON format is explicitly requested
    if (params.json) {
      return this.createSuccessResult(validatedTaskId, "Task specification retrieved", {
        task: specResult.task,

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
export const createTasksSpecCommand = (
  getPersistenceProvider?: () => PersistenceProvider,
  getTaskService?: () => TaskServiceInterface
): TasksSpecCommand => new TasksSpecCommand(getPersistenceProvider, getTaskService);
