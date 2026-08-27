/**
 * Second writer of the prod-state cache, running at MCP server boot (mt#3922).
 *
 * mt#3896 decided that the cockpit daemon keeps its 10-minute prod-state sweep but must not
 * be its SOLE writer. The evidence behind that decision: across four recorded occurrences
 * (mt#3039, mt#3051, mt#3060, mt#3682) the sweep stalled INSIDE a running daemon every time,
 * with a different mechanism each time — a silent domain-level no-op, a wedged interval, a
 * recurrence after DONE, a process-local DNS resolver wedge. In-process recovery cannot clear
 * process-local state; only a process restart does. So the hazard is the writer's LONGEVITY,
 * not its optionality, and the fix is a writer with a different lifetime rather than a fifth
 * in-process recovery mechanism.
 *
 * The MCP server is that writer: it restarts frequently (staleness exits) and is alive exactly
 * when an agent is working, which is the only time the cache is read. Each restart brings a
 * fresh resolver, so the wedge class cannot persist across one.
 *
 * ### Covers
 *
 * - A cockpit daemon that is wedged, crashed, absent, or mid-restart while an agent is
 *   working — the cache is refreshed on the next MCP server boot instead of aging until the
 *   daemon recovers.
 * - A cache that was never written at all (fresh machine, cleared state dir).
 *
 * ### Does NOT cover
 *
 * - **Staleness accrued between MCP boots.** This runs at boot only. If both writers are down
 *   and no boot occurs, the cache ages and the consumer hook correctly reports STALE — which
 *   is the pre-existing behavior, not a regression. A periodic sweep in the MCP process is
 *   deliberately not added: it would reintroduce the long-lived-writer property this exists
 *   to escape.
 * - **A wedge inside the MCP process itself.** Same class, different process. The mitigation
 *   is the same one that makes this writer useful — the MCP server's own restart cadence.
 * - **A DB that is unreachable from both processes.** Neither writer can refresh; the last-good
 *   snapshot is left in place (never truncated) and the consumer reports its true age.
 * - **Surfacing the outcome on a health endpoint.** `ProdStateSweepTracker` is recorded (via
 *   {@link runProdStateRefreshTick} and `refreshProdStateCache`), but the surfaces that read it
 *   — the cockpit's `/api/health` and `/api/sweeps` — live in the cockpit process, not this one.
 *   In the MCP process the operator-visible signal is the log line, which is the convention its
 *   three sibling boot sweeps already use (`start-command.ts`). Owned by nothing today; file a
 *   task if an MCP-side health surface for boot sweeps is ever wanted.
 *
 * @see mt#3896 — the decision this implements (its `## Outcome` carries the full alternatives set)
 * @see src/cockpit/prod-state-cache.ts — `refreshProdStateCache`, the shared refresh
 * @see .minsky/hooks/inject-prod-state.ts — the consumer; unchanged and unaware of who wrote
 *      it. That is the SOURCE; `.claude/hooks/` holds the generated copy.
 */
import * as fs from "fs";
import { log } from "@minsky/shared/logger";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";
import {
  runProdStateRefreshTick,
  PROD_STATE_REFRESH_INTERVAL_MS,
  META_WATCHDOG_STALL_MULTIPLIER,
} from "../cockpit/sweepers";
import { getProdStateCachePath, refreshProdStateCache } from "../cockpit/prod-state-cache";
import type { UnsafeSql } from "../cockpit/prod-state-cache";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/**
 * How stale the cache must be before a boot refreshes it.
 *
 * Derived, not chosen (`decision-defaults.mdc §Thresholds`): it is the daemon's own sweep
 * cadence times the multiplier this repo already uses to define "one missed tick" for THIS
 * sweep — `META_WATCHDOG_STALL_MULTIPLIER`, which the meta-watchdog applies as
 * `entry.intervalMs * MULTIPLIER` when deciding a sweep has stalled. Both operands are
 * existing observed cadences, so the threshold moves if either does.
 *
 * The two bounds it has to sit between:
 *
 * - **Above the healthy-daemon maximum age (10m).** The MCP server restarts on the order of
 *   ~100 times a day; refreshing on every boot would turn that into ~100 ledger reads a day
 *   for a datum that changes on a 10-minute cadence. At 20m a boot under a healthy daemon
 *   almost never refreshes.
 * - **Below the consumer's STALE bar (`PROD_STATE_STALENESS_MS`, 30m).** The backstop has to
 *   fire BEFORE the injection hook starts telling every turn the snapshot is stale, otherwise
 *   it only acts after the harm it exists to prevent.
 */
export const PROD_STATE_BOOT_STALENESS_MS =
  PROD_STATE_REFRESH_INTERVAL_MS * META_WATCHDOG_STALL_MULTIPLIER;

/** Why a boot did or did not refresh — the observable this module's decision half returns. */
export type ProdStateBootRefreshReason = "absent" | "unreadable" | "stale" | "fresh";

export interface ProdStateBootRefreshDecision {
  refresh: boolean;
  reason: ProdStateBootRefreshReason;
  /** Age of the existing record in ms, or null when there is no readable `checkedAt`. */
  ageMs: number | null;
}

/**
 * Decide whether this boot should refresh the cache, from the file's raw contents.
 *
 * Takes the raw string rather than a path so the decision is a pure function of its inputs —
 * a test states the cache contents and the clock directly instead of patching `fs`, which
 * ADR-036 bans and `testing-standards.mdc §Testable Design` calls out as design feedback.
 *
 * A malformed or unparseable cache is treated as `unreadable` → refresh. That is deliberate:
 * the consumer hook cannot use a record it cannot parse either, so rewriting it is strictly
 * better than leaving it, and a parse error is exactly the state a fresh write repairs.
 */
export function decideProdStateBootRefresh(
  raw: string | null,
  nowMs: number,
  stalenessMs: number = PROD_STATE_BOOT_STALENESS_MS
): ProdStateBootRefreshDecision {
  if (raw === null) return { refresh: true, reason: "absent", ageMs: null };

  let checkedAtMs: number;
  try {
    const parsed: unknown = JSON.parse(raw);
    const checkedAt =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { checkedAt?: unknown }).checkedAt
        : undefined;
    if (typeof checkedAt !== "string") {
      return { refresh: true, reason: "unreadable", ageMs: null };
    }
    checkedAtMs = Date.parse(checkedAt);
    if (!Number.isFinite(checkedAtMs)) {
      return { refresh: true, reason: "unreadable", ageMs: null };
    }
  } catch {
    // intentional-swallow: an unparseable cache is a known state with a defined
    // response (refresh it), and the caller logs the returned reason — there is
    // nothing a rethrow here would tell an operator that the reason does not.
    return { refresh: true, reason: "unreadable", ageMs: null };
  }

  const ageMs = nowMs - checkedAtMs;
  // A future-dated `checkedAt` (clock skew between the two writers) reads as a negative age.
  // Treat it as fresh rather than stale: refreshing on skew would fire on every boot for as
  // long as the skew lasts, which is the ~100-reads-a-day cost this gate exists to avoid.
  return ageMs > stalenessMs
    ? { refresh: true, reason: "stale", ageMs }
    : { refresh: false, reason: "fresh", ageMs };
}

export interface ProdStateBootRefreshDeps {
  /** Raw cache contents, or null when the file is absent/unreadable. */
  readCache: () => string | null;
  /** Resolve the provider's raw-SQL accessor, or null when it exposes none. */
  resolveRawSql: () => Promise<(() => Promise<unknown>) | null>;
  /** Refresh the cache; returns whether it actually wrote. */
  refresh: (sql: unknown, nowIso: string) => Promise<boolean>;
  now?: () => number;
  stalenessMs?: number;
  /**
   * Sink for the SKIPPED case. Defaults to `log.debug` deliberately: this is the common path
   * — the server boots ~100 times a day and a healthy daemon makes almost all of those skips
   * — so logging it at info would bury the line that matters under ~100 that do not.
   */
  logSkip?: (message: string, meta?: Record<string, unknown>) => void;
  /**
   * Sink for an actual REFRESH. Defaults to `log.info`, not `log.debug` (PR #2805 R1): this is
   * the rare, operator-relevant event — it means the daemon's sweep was not keeping the cache
   * fresh — and criterion 6 asks for it to be visible without raising the log level.
   */
  logInfo?: (message: string, meta?: Record<string, unknown>) => void;
  logWarn?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ProdStateBootRefreshResult {
  decision: ProdStateBootRefreshDecision;
  /** Whether a write actually landed; null when the staleness gate skipped the refresh. */
  wrote: boolean | null;
}

/**
 * Run the gated boot refresh. Returns the decision and the outcome so a caller — or a test —
 * can assert on both halves without reading a log.
 *
 * The refresh itself delegates to {@link runProdStateRefreshTick}, the same wrapper the
 * cockpit sweeper uses, so the SQL-resolution half is a call site too and the
 * `ProdStateSweepTracker` bookkeeping mt#3684 added is inherited rather than re-derived.
 */
export async function runProdStateBootRefresh(
  deps: ProdStateBootRefreshDeps
): Promise<ProdStateBootRefreshResult> {
  const nowMs = (deps.now ?? (() => Date.now()))();
  const info = deps.logInfo ?? ((message, meta) => log.info(message, meta));
  const skip = deps.logSkip ?? ((message, meta) => log.debug(message, meta));
  const warn = deps.logWarn ?? ((message, meta) => log.warn(message, meta));

  const decision = decideProdStateBootRefresh(deps.readCache(), nowMs, deps.stalenessMs);
  if (!decision.refresh) {
    skip("mcp: prod-state cache is fresh; skipping boot refresh", { ageMs: decision.ageMs });
    return { decision, wrote: null };
  }

  const result = await runProdStateRefreshTick({
    resolveRawSql: deps.resolveRawSql,
    refresh: deps.refresh,
    logWarn: warn,
  });

  if (result.ok) {
    info("mcp: refreshed prod-state cache at boot", {
      reason: decision.reason,
      ageMs: decision.ageMs,
    });
  } else {
    // `runProdStateRefreshTick` already logged the specific cause; this line adds the half it
    // cannot know — that this was the boot writer, and what made it decide to run.
    warn("mcp: prod-state boot refresh did not write; leaving the existing cache in place", {
      reason: decision.reason,
      ageMs: decision.ageMs,
    });
  }
  return { decision, wrote: result.ok };
}

/**
 * Read the cache file, returning null for both "absent" and "unreadable".
 *
 * Collapsing the two is safe here because {@link decideProdStateBootRefresh} treats them
 * identically — both mean "no usable record, write one."
 */
function readProdStateCacheFile(cachePath: string): string | null {
  try {
    // `.toString()` rather than an encoding argument: under the root tsconfig's typings
    // `readFileSync` widens to `string | Buffer` even when given `{ encoding: "utf8" }`.
    return fs.readFileSync(cachePath).toString();
  } catch {
    // intentional-swallow: ENOENT is the ordinary first-boot case and any other read error
    // has the same response (refresh). The decision function's `absent` reason is what
    // reaches the log.
    return null;
  }
}

/**
 * Real-wired entry point: the boot refresh bound to the process's actual persistence provider
 * and cache path. This is what `start-command.ts` calls; everything above it is injectable.
 *
 * Never throws — a failure here must not delay or fail MCP boot (mt#3922 criterion 5). The
 * cache is an optimization for a hook that already fails open when it is missing or stale.
 */
export async function triggerProdStateBootRefresh(
  provider: BasePersistenceProvider,
  cachePath: string = getProdStateCachePath()
): Promise<ProdStateBootRefreshResult | null> {
  try {
    return await runProdStateBootRefresh({
      readCache: () => readProdStateCacheFile(cachePath),
      resolveRawSql: async () => {
        const getRawSql = (provider as { getRawSqlConnection?: () => Promise<unknown> })
          .getRawSqlConnection;
        return typeof getRawSql === "function" ? getRawSql.bind(provider) : null;
      },
      refresh: (sql, nowIso) =>
        refreshProdStateCache(sql as UnsafeSql | null | undefined, nowIso, cachePath),
    });
  } catch (err) {
    log.warn("mcp: prod-state boot refresh failed (best-effort)", {
      error: getLoggableErrorSummary(err),
    });
    return null;
  }
}
