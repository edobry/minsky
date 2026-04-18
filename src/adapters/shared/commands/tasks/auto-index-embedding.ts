import { log } from "../../../../utils/logger";

/**
 * Dependencies that can be injected for testing.
 */
export interface AutoIndexDeps {
  getConfiguration: () => { embeddings?: { autoIndex?: boolean } };
  createTaskSimilarityService: () => Promise<{ indexTask: (id: string) => Promise<boolean> }>;
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
      const service = await createTaskSimilarityService();
      await service.indexTask(taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug(`Auto-index skipped for ${taskId}: ${msg}`);
    }
  })();
}
