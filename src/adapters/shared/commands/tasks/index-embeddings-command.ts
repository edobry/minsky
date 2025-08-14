import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import type { CommandExecutionContext } from "../../command-registry";
import { createTaskSimilarityService } from "./similarity-commands";
import { tasksIndexEmbeddingsParams } from "./task-parameters";
import { listTasksFromParams } from "../../../../domain/tasks/taskCommands";

interface TasksIndexEmbeddingsParams extends BaseTaskParams {
  limit?: number;
}

export class TasksIndexEmbeddingsCommand extends BaseTaskCommand {
  readonly id = "tasks.index-embeddings";
  readonly name = "index-embeddings";
  readonly description = "Generate and store embeddings for tasks";
  readonly parameters = tasksIndexEmbeddingsParams;

  async execute(params: TasksIndexEmbeddingsParams, ctx: CommandExecutionContext) {
    const service = await createTaskSimilarityService();

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
