import { log } from "../../../../utils/logger";
import type { BasePersistenceProvider } from "../../../../domain/persistence/types";
import type { TaskServiceInterface } from "../../../../domain/tasks/taskService";

/**
 * Dependencies that can be injected for testing or DI threading.
 * All fields are optional; missing ones fall back to dynamic imports.
 */
export interface AutoIndexDeps {
  getConfiguration?: () => { embeddings?: { autoIndex?: boolean } };
  createTaskSimilarityService?: (
    provider: BasePersistenceProvider,
    taskService: TaskServiceInterface
  ) => Promise<{ indexTask: (id: string) => Promise<boolean> }>;
  getPersistenceProvider?: () => BasePersistenceProvider;
  getTaskService?: () => TaskServiceInterface;
}

/**
 * Fire-and-forget embedding indexing after task mutations.
 * Never blocks, never throws -- logs at debug level on failure.
 *
 * Accepts optional dependency overrides for testing; in production
 * the deps are resolved via dynamic imports.
 */
export function autoIndexTaskEmbedding(taskId: string, deps?: AutoIndexDeps): void {
  (async () => {
    try {
      const getConfiguration =
        deps?.getConfiguration ??
        (await import("../../../../domain/configuration")).getConfiguration;
      const cfg = getConfiguration();
      if (cfg.embeddings?.autoIndex === false) return;

      const createTaskSimilarityService =
        deps?.createTaskSimilarityService ??
        (await import("./similarity-commands")).createTaskSimilarityService;

      let persistenceProvider: BasePersistenceProvider;
      if (deps?.getPersistenceProvider) {
        persistenceProvider = deps.getPersistenceProvider();
      } else {
        log.debug(`Auto-index skipped for ${taskId}: no persistence provider available`);
        return;
      }

      if (!deps?.getTaskService) {
        log.debug(`Auto-index skipped for ${taskId}: no task service available`);
        return;
      }
      const taskService = deps.getTaskService();

      const service = await createTaskSimilarityService(persistenceProvider, taskService);
      await service.indexTask(taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug(`Auto-index skipped for ${taskId}: ${msg}`);
    }
  })();
}
