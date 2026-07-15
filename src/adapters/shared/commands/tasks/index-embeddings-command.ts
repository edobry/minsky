import { BaseTaskCommand } from "./base-task-command";
import type { CommandExecutionContext, InferParams } from "../../command-registry";
import { createTaskSimilarityService } from "./similarity-commands";
import { tasksIndexEmbeddingsParams } from "./task-parameters";
import { listTasksFromParams, getTaskFromParams } from "@minsky/domain/tasks/taskCommands";
import { elementAt } from "@minsky/shared/array-safety";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";

export class TasksIndexEmbeddingsCommand extends BaseTaskCommand<
  typeof tasksIndexEmbeddingsParams
> {
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

  async execute(
    params: InferParams<typeof tasksIndexEmbeddingsParams>,
    ctx: CommandExecutionContext
  ) {
    const service = await createTaskSimilarityService(
      this.getPersistenceProvider(),
      this.getTaskService()
    );

    // If a specific task is provided (canonical `taskId`, or the `task` alias),
    // index just that one (mt#2741). Absent => index all (below).
    const singleTaskId = params.taskId ?? params.task;
    if (singleTaskId) {
      const task = await getTaskFromParams(
        {
          taskId: singleTaskId,
          backend: params.backend,
          repo: params.repo,
          workspace: params.workspace,
          session: params.session,
        },
        { taskService: this.getTaskService?.() }
      );
      const { log } = await import("@minsky/shared/logger");
      const changed = await service.indexTask(task.id, { force: params.reindex });
      if (!(params.json || ctx.format === "json")) {
        const verb = changed
          ? params.reindex
            ? "re-indexed (forced)"
            : "indexed"
          : "up-to-date (skipped)";
        log.cli(`${task.id}: ${verb}`);
      }
      return this.formatResult(
        { success: true, indexed: changed ? 1 : 0, skipped: changed ? 0 : 1 },
        params.json || ctx.format === "json"
      );
    }

    // Otherwise list and index up to limit
    const tasks = await listTasksFromParams(
      {
        all: true,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
        json: true,
        filter: undefined,
        status: undefined,
        limit: params.limit,
      },
      { taskService: this.getTaskService?.() }
    );

    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    let quotaExhausted = false;
    let quotaError: string | undefined;
    const { log } = await import("@minsky/shared/logger");
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
          const changed = await service.indexTask(t.id, { force: params.reindex });
          if (!(params.json || ctx.format === "json")) {
            const verb = changed
              ? params.reindex
                ? "re-indexed (forced)"
                : "indexed"
              : "up-to-date (skipped)";
            log.cli(`- ${t.id}: ${verb}`);
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
