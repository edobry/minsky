import { log } from "@minsky/shared/logger";
import { hasRawSqlConnection } from "@minsky/domain/persistence/types";
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
  /**
   * Mirrors the same field on `AutoIndexDeps`. Needed to test the sweep's own
   * bookkeeping — quota short-circuiting and the residual count — without a
   * live embedding provider.
   */
  createTaskSimilarityService?: (
    provider: BasePersistenceProvider,
    taskService: TaskServiceInterface
  ) => Promise<{ indexTask: (id: string) => Promise<boolean> }>;
  /**
   * Injectable warn sink, defaulting to the shared logger (mt#3629). Tests
   * inject a collector here instead of spying on `log.warn` to verify the
   * wiring: that this shell forwards what the classify* functions below
   * decided.
   */
  warn?: (message: string, context?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Degraded-path signal classification (mt#3629 / mt#3565 §Reframe) — pure
// cores. Each function below builds a warn message from its inputs alone,
// asserted directly by return value; the sweep body forwards the result to
// the injectable `warn` sink instead of calling `log.warn` inline.
// ---------------------------------------------------------------------------

/** Pure core: the "no SQL capability" skip message. */
export function classifyNoSqlCapability(): { message: string } {
  return {
    message:
      "Startup embedding sweep skipped: persistence provider has no SQL capability — " +
      "tasks missing embeddings will NOT be recovered this boot",
  };
}

/** Pure core: the "no raw SQL connection" skip message. */
export function classifyNoRawConnection(): { message: string } {
  return {
    message:
      "Startup embedding sweep skipped: no raw SQL connection available — " +
      "tasks missing embeddings will NOT be recovered this boot",
  };
}

/** Pure core: the quota-exhaustion stop message. */
export function classifyQuotaExhausted(): { message: string } {
  return {
    message: "Startup sweep: OpenAI quota exhausted (insufficient_quota) — stopping all workers",
  };
}

/** Pure core: the per-task index-failure message. */
export function classifyTaskIndexFailed(
  taskId: string,
  err: unknown
): { message: string; context: { error: string } } {
  const error = err instanceof Error ? err.message : String(err);
  return { message: `Startup sweep: failed to index ${taskId}`, context: { error } };
}

/** Pure core: the residual re-measurement failure message. */
export function classifyResidualMeasurementFailed(err: unknown): {
  message: string;
  context: { error: string };
} {
  const error = err instanceof Error ? err.message : String(err);
  return {
    message: "Startup sweep: could not re-measure residual missing count; reporting an estimate",
    context: { error },
  };
}

/** Inputs to {@link classifySweepFinish}. */
export interface SweepFinishSummary {
  indexed: number;
  failed: number;
  stillMissing: number;
  hitScanLimit: boolean;
  quotaExhausted: boolean;
}

/**
 * Pure core: decide whether the sweep's finish should warn, and build the
 * message when it does. Returns `null` for the clean run — the "stay quiet"
 * branch — asserted directly by return value instead of by spying on
 * whether `log.warn` fired.
 */
export function classifySweepFinish(summary: SweepFinishSummary): { message: string } | null {
  const { indexed, failed, stillMissing, hitScanLimit, quotaExhausted } = summary;
  if (failed === 0 && !quotaExhausted && stillMissing === 0) {
    return null;
  }
  return {
    message:
      `Startup embedding sweep finished with gaps: indexed ${indexed}, failed ${failed}, ` +
      `still missing ${stillMissing}${hitScanLimit ? ` (hit the ${STARTUP_SWEEP_LIMIT}-task scan limit; more may remain)` : ""}` +
      `${quotaExhausted ? " — stopped early on OpenAI quota exhaustion" : ""}`,
  };
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

  const warn = deps?.warn ?? log.warn;

  if (!persistenceProvider.capabilities.sql) {
    warn(classifyNoSqlCapability().message);
    return;
  }

  // Find tasks missing embeddings. `hasRawSqlConnection` asks BOTH halves (mt#4543):
  // the sql capability — which the check above already established, so this is belt to
  // that brace — and the presence of the OPTIONAL raw accessor, which a SQL-capable
  // provider may genuinely not implement.
  const sql = hasRawSqlConnection(persistenceProvider)
    ? await persistenceProvider.getRawSqlConnection()
    : undefined;
  if (!sql) {
    warn(classifyNoRawConnection().message);
    return;
  }
  // No `as postgres.Sql` (mt#4543) — `.unsafe` here is mt#2773's capped one, which is
  // what this should have been calling all along. The cast that used to sit here claimed
  // the guarded wrapper was a raw postgres-js client; the row shape is asserted instead,
  // narrowly and against the SELECT two lines below it. (The COUNT query further down
  // keeps its runtime guard rather than an assertion — its own comment says why: a
  // decision turns on that value, where this one only drives a loop.)
  const missing = (await sql.unsafe(
    `SELECT t.id FROM tasks t LEFT JOIN tasks_embeddings te` +
      ` ON t.id = te.task_id WHERE te.task_id IS NULL LIMIT $1`,
    [STARTUP_SWEEP_LIMIT]
  )) as Array<{ id: string }>;

  if (missing.length === 0) return;
  log.debug(`Startup sweep: ${missing.length} tasks need embedding indexing`);

  // Index them with low concurrency
  const createTaskSimilarityService =
    deps?.createTaskSimilarityService ??
    (await import("./similarity-commands")).createTaskSimilarityService;
  const service = await createTaskSimilarityService(persistenceProvider, taskService);

  let indexed = 0;
  let failed = 0;
  let i = 0;
  let quotaExhausted = false;

  async function worker() {
    while (true) {
      // PR #2473 R1: `break` only exits THIS worker's loop, so a quota
      // exhaustion detected by one worker left the others pulling more tasks
      // and issuing calls already known to fail — while the log said
      // "stopping". The flag is shared, so read it here: every worker stops.
      if (quotaExhausted) break;
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
          warn(classifyQuotaExhausted().message);
          break;
        }
        failed++;
        // Per-task, and at warn: this is the failure that leaves a specific
        // task unindexed. Counting it without naming it is what made mt#2861
        // undiagnosable.
        const taskFailedSignal = classifyTaskIndexFailed(row.id, err);
        warn(taskFailedSignal.message, taskFailedSignal.context);
      }
    }
  }

  const workers = Array.from({ length: STARTUP_SWEEP_CONCURRENCY }, () => worker());
  await Promise.all(workers);

  // PR #2473 R1: MEASURE the residual, don't infer it. This was
  // `missing.length - indexed`, which is wrong whenever `indexTask` returns
  // false without failing — it returns false for an up-to-date skip, so a task
  // indexed concurrently between the query above and the call would be counted
  // as still missing. Re-running the same query answers the question directly
  // and also covers the never-attempted tasks left behind by a quota stop.
  // One extra query, once, at boot.
  let stillMissing: number;
  try {
    const remaining = await sql.unsafe(
      `SELECT count(*)::int AS n FROM tasks t LEFT JOIN tasks_embeddings te` +
        ` ON t.id = te.task_id WHERE te.task_id IS NULL`
    );
    // Guard the driver's row shape rather than asserting it — the count is what
    // the whole warn/quiet decision below turns on, so a surprising shape must
    // fall through to the estimate rather than silently become 0.
    const row: unknown = Array.isArray(remaining) ? remaining[0] : undefined;
    const n =
      typeof row === "object" && row !== null ? (row as Record<string, unknown>)["n"] : undefined;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new Error(`residual count query returned an unexpected shape: ${JSON.stringify(row)}`);
    }
    stillMissing = n;
  } catch (err) {
    // The residual check failing must not swallow the sweep's own result, so
    // fall back to the arithmetic and say which number this is.
    stillMissing = Math.max(0, missing.length - indexed);
    const residualSignal = classifyResidualMeasurementFailed(err);
    warn(residualSignal.message, residualSignal.context);
  }
  const finishSignal = classifySweepFinish({
    indexed,
    failed,
    stillMissing,
    hitScanLimit: missing.length >= STARTUP_SWEEP_LIMIT,
    quotaExhausted,
  });
  if (finishSignal) {
    warn(finishSignal.message);
    return;
  }
  log.debug(`Startup sweep complete: indexed ${indexed}, failed ${failed}`);
}
