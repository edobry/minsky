import { log } from "../../../../utils/logger";

const STARTUP_SWEEP_LIMIT = 50;
const STARTUP_SWEEP_CONCURRENCY = 2;

export async function triggerStartupEmbeddingSweep(): Promise<void> {
  // Check config gate
  const { getConfiguration } = await import("../../../../domain/configuration");
  const cfg = getConfiguration();
  if (cfg.embeddings?.autoIndex === false) return;

  // Check if persistence supports SQL — use PersistenceService since this
  // runs at startup outside a command execution context (no container available)
  const { PersistenceService } = await import("../../../../domain/persistence/service");
  if (!PersistenceService.isInitialized()) return;
  const provider = PersistenceService.getProvider();
  if (!provider.capabilities.sql) return;

  // Find tasks missing embeddings
  const sql = await provider.getRawSqlConnection?.();
  if (!sql) return;
  const missing = await (sql as import("postgres").Sql).unsafe(
    `SELECT t.id FROM tasks t LEFT JOIN tasks_embeddings te` +
      ` ON t.id = te.task_id WHERE te.task_id IS NULL LIMIT $1`,
    [STARTUP_SWEEP_LIMIT]
  );

  if (missing.length === 0) return;
  log.debug(`Startup sweep: ${missing.length} tasks need embedding indexing`);

  // Index them with low concurrency
  const { createTaskSimilarityService } = await import("./similarity-commands");
  const service = await createTaskSimilarityService();

  let indexed = 0;
  let failed = 0;
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= missing.length) break;
      try {
        const row = missing[idx];
        if (!row) continue;
        const changed = await service.indexTask(row.id);
        if (changed) indexed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/insufficient_quota/i.test(msg)) break; // Stop on billing issues
        failed++;
      }
    }
  }

  const workers = Array.from({ length: STARTUP_SWEEP_CONCURRENCY }, () => worker());
  await Promise.all(workers);
  log.debug(`Startup sweep complete: indexed ${indexed}, failed ${failed}`);
}
