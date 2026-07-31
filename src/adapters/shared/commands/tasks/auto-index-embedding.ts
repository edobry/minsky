import { log } from "@minsky/shared/logger";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";

/**
 * Dependencies that can be injected for testing or DI threading.
 * getPersistenceProvider is required; other fields fall back to dynamic imports.
 */
export interface AutoIndexDeps {
  getConfiguration?: () => { embeddings?: { autoIndex?: boolean } };
  createTaskSimilarityService?: (
    provider: BasePersistenceProvider,
    taskService: TaskServiceInterface
  ) => Promise<{ indexTask: (id: string) => Promise<boolean> }>;
  getPersistenceProvider: () => BasePersistenceProvider;
  getTaskService: () => TaskServiceInterface;
}

/**
 * Fire-and-forget embedding indexing after task mutations.
 * Never blocks, never throws.
 *
 * A failure here leaves the task PERMANENTLY unindexed: there is no retry, and
 * the only recovery is `triggerStartupEmbeddingSweep` on the next server start.
 * So the failure is reported at `warn` and names the task (mt#3370) — it used
 * to log at `debug`, which meant a task could silently drop out of the search
 * index with no operator-visible trace. `mt#3459` was lost exactly this way and
 * was still missing 30 minutes later; `mt#2861` for 16 days.
 *
 * "Never throws" is about not disrupting the caller's mutation — it is not a
 * reason to be silent.
 *
 * Accepts optional dependency overrides for testing; in production
 * the deps are resolved via dynamic imports.
 */
export function autoIndexTaskEmbedding(taskId: string, deps: AutoIndexDeps): void {
  (async () => {
    try {
      const getConfiguration =
        deps.getConfiguration ?? (await import("@minsky/domain/configuration")).getConfiguration;
      const cfg = getConfiguration();
      if (cfg.embeddings?.autoIndex === false) return;

      const createTaskSimilarityService =
        deps.createTaskSimilarityService ??
        (await import("./similarity-commands")).createTaskSimilarityService;

      const persistenceProvider = deps.getPersistenceProvider();
      const taskService = deps.getTaskService();
      const service = await createTaskSimilarityService(persistenceProvider, taskService);
      await service.indexTask(taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `Auto-index FAILED for ${taskId} — the task is not in the embeddings index ` +
          `and will stay out until the next startup sweep re-indexes it`,
        { taskId, error: msg }
      );
    }
  })();
}
