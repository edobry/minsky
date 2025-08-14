import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import type { CommandExecutionContext } from "../../command-registry";
import { createTaskSimilarityService } from "./similarity-commands";

interface TasksIndexEmbeddingsParams extends BaseTaskParams {
  all?: boolean; // default true
}

export class TasksIndexEmbeddingsCommand extends BaseTaskCommand {
  readonly id = "tasks.index-embeddings";
  readonly name = "index-embeddings";
  readonly description = "Generate and store embeddings for tasks";

  async execute(params: TasksIndexEmbeddingsParams, ctx: CommandExecutionContext) {
    const service = await createTaskSimilarityService();

    // Load tasks and index
    const tasksModule = await import("../../../domain/tasks");
    const tasks = await tasksModule.listTasks({});

    let indexed = 0;
    for (const t of tasks) {
      await service.indexTask(t.id);
      indexed++;
    }

    return this.formatResult(
      { success: true, indexed },
      params.json || ctx.format === "json"
    );
  }
}
