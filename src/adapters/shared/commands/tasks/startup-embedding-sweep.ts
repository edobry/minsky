import { log } from "@minsky/shared/logger";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";

const STARTUP_SWEEP_LIMIT = 50;
const STARTUP_SWEEP_CONCURRENCY = 2;

/**
 * Why this sweep is loud (mt#3370).
 *
 * Task embeddings are written by `autoIndexTaskEmbedding`, a fire-and-forget
 * call on task mutation that never blocks and never throws. When it fails, the
 * task is left permanently unindexed and nothing is retried — so THIS sweep is
 * the only recovery layer the index has.
 *
 * Before mt#3370 every failure path in that layer was silent: two early returns
 * with no message, a per-task `catch` that only incremented a counter, a
 * summary at `log.debug`, and a bare `.catch(() => {})` at the registration
 * site. A sweep that never ran was indistinguishable from one that found
 * nothing, which is why `mt#2861` sat unindexed for 16 days with no diagnosis
 * available. Each `log.warn` below exists to make one of those states
 * distinguishable.
 *
 * ### Covers
 *
 * - A task whose on-write indexing failed or never completed, for any reason —
 *   the sweep re-indexes it on the next server start.
 * - Reporting when the sweep itself could not run (no SQL capability, no raw
 *   connection) rather than returning as if there were nothing to do.
 * - Reporting per-task indexing failures, and any tasks still missing when the
 *   sweep finishes.
 *
 * ### Does NOT cover
 *
 * - **Latency between the failure and the next server start.** This runs at
 *   boot only; a task that fails to index stays missing until then. A periodic
 *   sweep is not added here — the observed rate is ~1 miss per 100 tasks, and
 *   the signal this task adds is the prerequisite for deciding whether a
 *   periodic sweep is warranted.
 * - **More than `STARTUP_SWEEP_LIMIT` missing tasks in one boot.** The residual
 *   count logged at the end is what surfaces a backlog larger than the limit.
 * - **A stalled embedding request that never settles.** The `fetch` in
 *   `OpenAIEmbeddingService` has no timeout, so such a call hangs rather than
 *   rejecting and this sweep's `catch` never fires. Owned by mt#3444; until it
 *   lands, a stall here presents as a sweep that neither completes nor reports.
 * - **The 1379 rows with no content hash.** Separate concern, tracked by this
 *   task's own SC4.
 *
 * @param persistenceProvider - The persistence provider from the DI container.
 *   Required — callers must pass it from the container.
 * @param deps - Optional overrides, mirroring `AutoIndexDeps` on the on-write
 *   sibling. Added by mt#3370 so this function is testable at all: it resolved
 *   configuration via a dynamic import of the global provider, which throws
 *   outside an initialized process, so the recovery layer had no test file. A
 *   recovery layer nobody can test is how a silent one survives.
 */
export interface StartupSweepDeps {
  getConfiguration?: () => { embeddings?: { autoIndex?: boolean } };
}

export async function triggerStartupEmbeddingSweep(
  persistenceProvider: BasePersistenceProvider,
  taskService: TaskServiceInterface,
  deps?: StartupSweepDeps
): Promise<void> {
  // Check config gate. Deliberate opt-out — the only silent return that stays
  // silent, because an operator who set this expects nothing to happen.
  const getConfiguration =
    deps?.getConfiguration ?? (await import("@minsky/domain/configuration")).getConfiguration;
  const cfg = getConfiguration();
  if (cfg.embeddings?.autoIndex === false) return;

  if (!persistenceProvider.capabilities.sql) {
    log.warn(
      "Startup embedding sweep skipped: persistence provider has no SQL capability — " +
        "tasks missing embeddings will NOT be recovered this boot"
    );
    return;
  }

  // Find tasks missing embeddings
  // Check for SQL capability at runtime via interface checking
  const getRawSql =
    "getRawSqlConnection" in persistenceProvider &&
    typeof persistenceProvider.getRawSqlConnection === "function"
      ? persistenceProvider.getRawSqlConnection
      : undefined;
  const sql = getRawSql ? await getRawSql.call(persistenceProvider) : undefined;
  if (!sql) {
    log.warn(
      "Startup embedding sweep skipped: no raw SQL connection available — " +
        "tasks missing embeddings will NOT be recovered this boot"
    );
    return;
  }
  const missing = await (sql as import("postgres").Sql).unsafe(
    `SELECT t.id FROM tasks t LEFT JOIN tasks_embeddings te` +
      ` ON t.id = te.task_id WHERE te.task_id IS NULL LIMIT $1`,
    [STARTUP_SWEEP_LIMIT]
  );

  if (missing.length === 0) return;
  log.debug(`Startup sweep: ${missing.length} tasks need embedding indexing`);

  // Index them with low concurrency
  const { createTaskSimilarityService } = await import("./similarity-commands");
  const service = await createTaskSimilarityService(persistenceProvider, taskService);

  let indexed = 0;
  let failed = 0;
  let i = 0;
  let quotaExhausted = false;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= missing.length) break;
      const row = missing[idx];
      if (!row) continue;
      try {
        const changed = await service.indexTask(row.id);
        if (changed) indexed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/insufficient_quota/i.test(msg)) {
          quotaExhausted = true;
          log.warn("Startup sweep: OpenAI quota exhausted (insufficient_quota) — stopping");
          break;
        }
        failed++;
        // Per-task, and at warn: this is the failure that leaves a specific
        // task unindexed. Counting it without naming it is what made mt#2861
        // undiagnosable.
        log.warn(`Startup sweep: failed to index ${row.id}`, { error: msg });
      }
    }
  }

  const workers = Array.from({ length: STARTUP_SWEEP_CONCURRENCY }, () => worker());
  await Promise.all(workers);

  // A sweep that ends with tasks still missing is the state this whole layer
  // exists to prevent, so it reports at warn — including the hit-the-limit case,
  // where `missing.length` equalling the limit means there may be more beyond it.
  const stillMissing = missing.length - indexed;
  if (failed > 0 || quotaExhausted || stillMissing > 0) {
    log.warn(
      `Startup embedding sweep finished with gaps: indexed ${indexed}, failed ${failed}, ` +
        `still missing ${stillMissing}${missing.length >= STARTUP_SWEEP_LIMIT ? ` (hit the ${STARTUP_SWEEP_LIMIT}-task scan limit; more may remain)` : ""}` +
        `${quotaExhausted ? " — stopped early on OpenAI quota exhaustion" : ""}`
    );
    return;
  }
  log.debug(`Startup sweep complete: indexed ${indexed}, failed ${failed}`);
}
