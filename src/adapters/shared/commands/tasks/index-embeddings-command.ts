import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import type { CommandExecutionContext } from "../../command-registry";
import { createTaskSimilarityService } from "./similarity-commands";
import { tasksIndexEmbeddingsParams } from "./task-parameters";
import { listTasksFromParams, getTaskFromParams } from "../../../../domain/tasks/taskCommands";

interface TasksIndexEmbeddingsParams extends BaseTaskParams {
  limit?: number;
  taskId?: string;
}

export class TasksIndexEmbeddingsCommand extends BaseTaskCommand {
  readonly id = "tasks.index-embeddings";
  readonly name = "index-embeddings";
  readonly description = "Generate and store embeddings for tasks";
  readonly parameters = tasksIndexEmbeddingsParams;

  async execute(params: TasksIndexEmbeddingsParams, ctx: CommandExecutionContext) {
    const service = await createTaskSimilarityService();

    // If a specific task is provided, index just that one
    if ((params as any).taskId) {
      const task = await getTaskFromParams({
        taskId: (params as any).taskId,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
        json: true,
      } as any);
      await service.indexTask(task.id);
      return this.formatResult({ success: true, indexed: 1 }, params.json || ctx.format === "json");
    }

    // Otherwise list and index up to limit
    const tasks = await listTasksFromParams({
      all: true,
      backend: params.backend,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
      json: true,
      filter: undefined,
      status: undefined,
      limit: params.limit,
    });

    let indexed = 0;
    for (const t of tasks) {
      await service.indexTask(t.id);
      indexed++;
    }

    return this.formatResult({ success: true, indexed }, params.json || ctx.format === "json");
  }
}
