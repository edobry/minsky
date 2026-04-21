import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import type { CommandExecutionContext } from "../../command-registry";
import { createTaskSimilarityService } from "./similarity-commands";
import { tasksIndexEmbeddingsParams } from "./task-parameters";
import { listTasksFromParams, getTaskFromParams } from "../../../../domain/tasks/taskCommands";
import { elementAt } from "../../../../utils/array-safety";
import type { PersistenceProvider } from "../../../../domain/persistence/types";
import type { TaskServiceInterface } from "../../../../domain/tasks/taskService";

interface TasksIndexEmbeddingsParams extends BaseTaskParams {
  limit?: number;
  task?: string;
  concurrency?: number;
}

export class TasksIndexEmbeddingsCommand extends BaseTaskCommand<TasksIndexEmbeddingsParams> {
  readonly id = "tasks.index-embeddings";
  readonly name = "index-embeddings";
  readonly description = "Generate and store embeddings for tasks";
  readonly parameters = tasksIndexEmbeddingsParams;

  constructor(
    private readonly getPersistenceProvider: () => PersistenceProvider,
    private readonly getTaskService: () => TaskServiceInterface
  ) {
    super();
  }

  async execute(params: TasksIndexEmbeddingsParams, ctx: CommandExecutionContext) {
    const service = await createTaskSimilarityService(
      this.getPersistenceProvider(),
      this.getTaskService()
    );

    // If a specific task is provided, index just that one
    if (params.task) {
      const task = await getTaskFromParams({
        taskId: params.task,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
      });
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
    let failed = 0;
    let quotaExhausted = false;
    let quotaError: string | undefined;
    const { log } = await import("../../../../utils/logger");
    if (!(params.json || ctx.format === "json")) {
      log.cli(`Indexing embeddings for ${tasks.length} task(s)...`);
    }

    // Concurrency control
    const concurrency = Math.max(1, Math.min(32, Number(params.concurrency) || 4));
    let i = 0;
    async function worker() {
      while (true) {
        if (quotaExhausted) break;
        const idx = i++;
        if (idx >= tasks.length) break;
        const t = elementAt(tasks, idx, "index-embeddings worker tasks");
        try {
          const changed = await service.indexTask(t.id);
          if (!(params.json || ctx.format === "json")) {
            log.cli(`- ${t.id}: ${changed ? "indexed" : "up-to-date (skipped)"}`);
          }
          if (changed) indexed++;
          else skipped++;
        } catch (err: unknown) {
          const msg = String((err as Error)?.message || err);
          if (/insufficient_quota/i.test(msg)) {
            quotaExhausted = true;
            quotaError = msg;
            log.warn(`Quota exhausted — stopping all workers: ${msg}`);
            break;
          }
          failed++;
          log.warn(`- ${t.id}: failed — ${msg}`);
        }
      }
    }
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);
    if (!(params.json || ctx.format === "json")) {
      log.cli("");
      const parts = [`Indexed ${indexed} task(s); skipped ${skipped}`];
      if (failed > 0) parts.push(`failed ${failed}`);
      if (quotaExhausted) parts.push("STOPPED: quota exhausted");
      log.cli(`Done. ${parts.join("; ")}.`);
    }

    return this.formatResult(
      {
        success: !quotaExhausted,
        indexed,
        skipped,
        failed,
        ...(quotaExhausted ? { error: quotaError } : {}),
      },
      params.json || ctx.format === "json"
    );
  }
}
