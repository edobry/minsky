import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import type { CommandExecutionContext } from "../../command-registry";
import { createTaskSimilarityService } from "./similarity-commands";
import { tasksIndexEmbeddingsParams } from "./task-parameters";
import { listTasksFromParams, getTaskFromParams } from "../../../../domain/tasks/taskCommands";

interface TasksIndexEmbeddingsParams extends BaseTaskParams {
  limit?: number;
  task?: string;
}

export class TasksIndexEmbeddingsCommand extends BaseTaskCommand {
  readonly id = "tasks.index-embeddings";
  readonly name = "index-embeddings";
  readonly description = "Generate and store embeddings for tasks";
  readonly parameters = tasksIndexEmbeddingsParams;

  async execute(params: TasksIndexEmbeddingsParams, ctx: CommandExecutionContext) {
    const service = await createTaskSimilarityService();

    // If a specific task is provided, index just that one
    if ((params as any).task) {
      const task = await getTaskFromParams({
        taskId: (params as any).task,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
        json: true,
      } as any);
      const { log } = await import("../../../../utils/logger");
      const changed = await service.indexTask(task.id);
      if (!(params.json || ctx.format === "json")) {
        log.cli(`${task.id}: ${changed ? "indexed" : "up-to-date (skipped)"}`);
      }
      return this.formatResult(
        { success: true, indexed: changed ? 1 : 0, skipped: changed ? 0 : 1 },
        params.json || ctx.format === "json"
      );
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
    let skipped = 0;
    const { log } = await import("../../../../utils/logger");
    if (!(params.json || ctx.format === "json")) {
      log.cli(`Indexing embeddings for ${tasks.length} task(s)...`);
    }

    // Concurrency control
    const concurrency = Math.max(1, Math.min(32, Number((params as any).concurrency) || 4));
    let i = 0;
    async function worker() {
      while (true) {
        const idx = i++;
        if (idx >= tasks.length) break;
        const t = tasks[idx];
        const changed = await service.indexTask(t.id);
        if (!(params.json || ctx.format === "json")) {
          log.cli(`- ${t.id}: ${changed ? "indexed" : "up-to-date (skipped)"}`);
        }
        if (changed) indexed++;
        else skipped++;
      }
    }
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);
    if (!(params.json || ctx.format === "json")) {
      log.cli("");
      log.cli(`Done. Indexed ${indexed} task(s); skipped ${skipped}.`);
    }

    return this.formatResult(
      { success: true, indexed, skipped },
      params.json || ctx.format === "json"
    );
  }
}
