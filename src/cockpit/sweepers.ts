/**
 * Cockpit periodic sweepers (mt#2615 — extracted from server.ts).
 *
 * Houses the shared `createIntervalSweeper` factory (with mt#2625's per-tick
 * timeout + watchdog fix baked in) and the four concrete periodic sweepers
 * that use it:
 *
 *   - startAskAdvancementSweeper   (mt#2265)
 *   - startProdStateRefreshSweeper (mt#2506)
 *   - startTopologySweeper         (mt#2602)
 *   - startTranscriptSweepBackstop (mt#2321)
 *   - startDispatchWatchdogSweeper (mt#2646)
 *
 * All four previously duplicated an ~8-line skeleton (running-guard, boot
 * tick, setInterval, clearInterval) with NO protection against a single tick
 * hanging forever — see mt#2625: `startProdStateRefreshSweeper` stalled for
 * 28+ hours on 2026-07-05 because a hung `getRawSqlConnection()` call left
 * the `running` guard permanently `true`, silently starving every later tick.
 */
import { log } from "@minsky/shared/logger";
import { DEFAULT_SWEEP_INTERVAL_MS } from "@minsky/domain/ask/advancement";
import { getServerAskRepository } from "./db-providers";
import { TranscriptSweepTracker } from "./transcript-sweep-tracker";

// ---------------------------------------------------------------------------
// Shared sweeper timer helper (mt#2602 R1 review) — centralizes the
// `.unref()` guard that was previously duplicated inline across every
// periodic sweeper, so a runtime whose `setInterval` return value doesn't
// expose `.unref()` (or exposes it under a different shape) is handled in
// one place instead of four near-identical inline checks.
// ---------------------------------------------------------------------------

/**
 * Best-effort `.unref()` on a `setInterval` handle so a sweeper alone never
 * holds the process open. Safe no-op when the handle has no callable
 * `unref` (e.g. a non-Node/Bun runtime) rather than throwing.
 */
export function unrefSweeperTimer(id: ReturnType<typeof setInterval>): void {
  if (
    typeof id === "object" &&
    id !== null &&
    "unref" in id &&
    typeof (id as { unref?: unknown }).unref === "function"
  ) {
    (id as { unref: () => void }).unref();
  }
}

// ---------------------------------------------------------------------------
// createIntervalSweeper — shared factory with mt#2625's starvation fix
// ---------------------------------------------------------------------------

/** Default per-tick abandonment timeout when a caller doesn't supply one. */
export const DEFAULT_TICK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Options accepted by {@link createIntervalSweeper}. */
export interface IntervalSweeperOptions {
  /** Human-readable name used in log messages (e.g. "ask advancement"). */
  name: string;
  /** Cadence in milliseconds between ticks. */
  intervalMs: number;
  /**
   * The tick callback — the actual sweep work. Should apply its OWN
   * fail-open try/catch with a domain-specific log message; the factory's
   * own catch (below) is only a last-resort safety net for an unexpected
   * throw escaping it.
   */
  tick: () => Promise<void>;
  /**
   * Per-tick abandonment timeout in milliseconds (mt#2625). A tick that
   * hasn't settled within this window is abandoned: the `running` guard is
   * force-released (via `Promise.race` against an internal timer) so the
   * NEXT scheduled tick can proceed, and a warning is logged. The abandoned
   * tick's underlying promise is NOT cancelled (no AbortSignal threading
   * here) — it may still complete and log its own outcome later; releasing
   * the guard early is what prevents PERMANENT starvation of every future
   * tick, which is the mt#2625 failure mode. Defaults to
   * {@link DEFAULT_TICK_TIMEOUT_MS}.
   *
   * The SAME value also serves as the watchdog invariant threshold: if a
   * scheduled tick attempt finds the guard already held for longer than
   * this value, it force-releases and logs loudly even if (for whatever
   * reason) the primary `Promise.race` path above did not already do so.
   * This is deliberately NOT derived from `intervalMs` — sweepers may be
   * scheduled at intervals far shorter than any sane hang-detection window
   * (e.g. tests), and tying the timeout to the interval would make the
   * overlap-skip guard indistinguishable from a hang.
   */
  tickTimeoutMs?: number;
}

/**
 * Build a periodic sweeper: boot tick + `setInterval` cadence, an
 * overlap-skip guard, a bounded per-tick timeout, and a watchdog invariant
 * (mt#2625) so a single hung tick can never starve every later tick forever.
 *
 * @returns stop function (clears the interval).
 */
export function createIntervalSweeper(options: IntervalSweeperOptions): () => void {
  const { name, intervalMs, tick } = options;
  const tickTimeoutMs = options.tickTimeoutMs ?? DEFAULT_TICK_TIMEOUT_MS;

  let running = false;
  let runningSinceMs: number | null = null;

  const runTick = async (): Promise<void> => {
    // Watchdog (mt#2625): if a PRIOR tick has been "running" longer than
    // tickTimeoutMs, the per-tick timeout below should already have released
    // it. This is the fail-safe for the (unexpected) case where it somehow
    // didn't — force-release so this and future ticks can proceed, and log
    // loudly so the stall is observable instead of silent.
    if (running && runningSinceMs !== null) {
      const heldForMs = Date.now() - runningSinceMs;
      if (heldForMs > tickTimeoutMs) {
        log.warn(
          `cockpit: ${name} sweep watchdog — guard held ${heldForMs}ms (> ${tickTimeoutMs}ms); force-releasing`,
          {
            heldForMs,
            tickTimeoutMs,
          }
        );
        running = false;
        runningSinceMs = null;
      }
    }

    if (running) return; // Overlapping tick — skip (pre-existing behavior).
    running = true;
    runningSinceMs = Date.now();

    // Per-tick timeout (mt#2625): race the real tick against a timer so a
    // hung dependency (DB call, subprocess, etc.) can never wedge the guard
    // forever.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed-out">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timed-out"), tickTimeoutMs);
    });

    try {
      const outcome = await Promise.race([tick().then(() => "completed" as const), timedOut]);
      if (outcome === "timed-out") {
        log.warn(
          `cockpit: ${name} sweep tick timed out after ${tickTimeoutMs}ms — releasing guard for next tick`,
          {
            tickTimeoutMs,
          }
        );
      }
    } catch (err) {
      // Last-resort safety net — the tick callback is expected to apply its
      // own fail-open try/catch; this only fires on an unexpected throw
      // escaping it.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`cockpit: ${name} sweep tick threw unexpectedly`, { message });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      running = false;
      runningSinceMs = null;
    }
  };

  void runTick();
  const id = setInterval(() => void runTick(), intervalMs);
  unrefSweeperTimer(id);
  return () => clearInterval(id);
}

// ---------------------------------------------------------------------------
// Ask advancement sweeper (mt#2265)
// ---------------------------------------------------------------------------

/**
 * Start the periodic ask-advancement sweep in this cockpit process.
 *
 * Advances `detected` asks the create path missed (emission-callsite rows,
 * rows from crashed processes) and expires stale ones, so the operator
 * surface reflects reality without a manual probe. Runs one pass at boot,
 * then every `intervalMs` (sweeper-not-queue per decision-defaults
 * §Reliability; the asks table is the single source of truth).
 *
 * Fail-open: a failed pass logs and waits for the next tick — the sweep
 * must never crash the cockpit. Overlapping ticks are skipped.
 *
 * @returns stop function (clears the interval).
 */
export function startAskAdvancementSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "ask advancement",
    intervalMs: intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    tick: async () => {
      try {
        const repo = await getServerAskRepository();
        if (!repo) return;
        const { runAskAdvancementSweep } = await import("@minsky/domain/ask/advancement");
        await runAskAdvancementSweep(repo);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: ask advancement sweep failed", { message });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Prod-state cache refresh sweeper (mt#2506)
// ---------------------------------------------------------------------------

/**
 * Default refresh interval for the prod-state cache. Kept well below the consumer hook's
 * staleness threshold (`PROD_STATE_STALENESS_MS` = 30m in inject-prod-state.ts) so a healthy
 * sweep keeps the injected snapshot labelled "fresh"; only a stalled/absent sweep trips the
 * hook's STALE path.
 */
const PROD_STATE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Start the periodic prod-state cache refresh in this cockpit process (mt#2506).
 *
 * The PRODUCER half of the hybrid cached-injection for the R10 no-tool-boundary status-claim
 * seam: reads the prod migration ledger via the provider's raw-SQL connection and writes a
 * small local cache that `.claude/hooks/inject-prod-state.ts` injects each turn. Doing the
 * network read here (once at boot, then every `intervalMs`) keeps the per-turn hook read
 * cheap (local fs only) per memory `08606f7c`'s ≤50ms bar.
 *
 * Fail-open: no DB / unreadable ledger / a failed pass logs and waits for the next tick —
 * never crashes the cockpit, and leaves the last-good cache in place. Overlapping ticks skip.
 *
 * @returns stop function (clears the interval).
 */
export function startProdStateRefreshSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "prod-state refresh",
    intervalMs: intervalMs ?? PROD_STATE_REFRESH_INTERVAL_MS,
    tick: async () => {
      try {
        const { getSharedPersistenceService } = await import("./shared-persistence");
        const { refreshProdStateCache } = await import("./prod-state-cache");
        const svc = await getSharedPersistenceService();
        const provider = svc.getProvider();
        const getRawSql =
          "getRawSqlConnection" in provider &&
          typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection === "function"
            ? (
                provider as { getRawSqlConnection: () => Promise<unknown> }
              ).getRawSqlConnection.bind(provider)
            : null;
        if (!getRawSql) return;
        const sql = (await getRawSql()) as
          | import("./prod-state-cache").UnsafeSql
          | null
          | undefined;
        await refreshProdStateCache(sql, new Date().toISOString());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: prod-state refresh sweep failed", { message });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Dispatch watchdog refresh sweeper (mt#2646)
// ---------------------------------------------------------------------------

/**
 * Default refresh interval for the dispatch-watchdog cache. Well below the
 * default stale-detection window (`DISPATCH_WATCHDOG_STALE_MS` = 30m in
 * dispatch-watchdog.ts) so a healthy sweep can flag a stalled dispatch
 * within a few minutes of crossing the threshold rather than waiting a full
 * refresh-interval extra.
 */
const DISPATCH_WATCHDOG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start the periodic dispatch-watchdog cache refresh in this cockpit process
 * (mt#2646).
 *
 * The PRODUCER half of the hybrid cached-injection mechanism: queries
 * in-flight `subagent_invocations` rows (dispatched, not yet Stop-classified)
 * whose task is IN-PROGRESS/IN-REVIEW, checks each for activity (session-
 * branch commits, related system events), and writes the flagged set to a
 * small local cache that `.claude/hooks/inject-dispatch-watchdog.ts` injects
 * each turn. Doing the DB/git reads here (once at boot, then every
 * `intervalMs`) keeps the per-turn hook read cheap (local fs only).
 *
 * Fail-open: no DB / unreadable ledger / a failed pass logs and waits for the
 * next tick — never crashes the cockpit, and leaves the last-good cache in
 * place. Overlapping ticks skip.
 *
 * @returns stop function (clears the interval).
 */
export function startDispatchWatchdogSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "dispatch watchdog",
    intervalMs: intervalMs ?? DISPATCH_WATCHDOG_REFRESH_INTERVAL_MS,
    tick: async () => {
      try {
        const { refreshDispatchWatchdogCache } = await import("./dispatch-watchdog");
        await refreshDispatchWatchdogCache();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: dispatch watchdog sweep failed", { message });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Slow-clock topology sweeper (mt#2602)
// ---------------------------------------------------------------------------

/**
 * Default refresh interval for the slow-clock topology cache: hourly-class,
 * per the mt#2375 "SLOW — plant grows valves" timescale and mt#2602's
 * "boot + hourly-class sweep, never per-request" constraint.
 */
const TOPOLOGY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Start the periodic slow-clock topology refresh in this cockpit process
 * (mt#2602). Recomputes the guard-hook registry + git-derived install dates +
 * `retrospective.fired` correlation (see `topology-cache.ts` /
 * `topology-derivation.ts`) once at boot, then every `intervalMs`. The
 * `slow-topology` widget's `fetch()` only ever reads the resulting in-process
 * cache — this sweeper is the sole place the bounded `git log` subprocess and
 * the DB query run.
 *
 * Fail-open: a failed pass logs and waits for the next tick, leaving the
 * last-good cache (if any) in place — never crashes the cockpit. Overlapping
 * ticks are skipped.
 *
 * @returns stop function (clears the interval).
 */
export function startTopologySweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "topology",
    intervalMs: intervalMs ?? TOPOLOGY_REFRESH_INTERVAL_MS,
    tick: async () => {
      try {
        const { refreshTopologyCache } = await import("./topology-cache");
        await refreshTopologyCache(new Date().toISOString());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: topology sweep failed", { message });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Transcript sweep backstop (mt#2321)
// ---------------------------------------------------------------------------

/**
 * Default cadence for the transcript sweep backstop. Longer than the prod-state
 * sweeper (10m) because a full ingestAll + embedding backfill is heavy — it
 * re-discovers every JSONL session in ~/.claude/projects and calls the DB for each.
 * 30m keeps the backstop meaningful (catches sessions missed while the daemon was
 * down, dropped FS events) without hammering the DB on a tight loop.
 */
const TRANSCRIPT_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Per-tick timeout for the transcript sweep backstop (mt#2625): larger than
 * {@link DEFAULT_TICK_TIMEOUT_MS} because a full ingestAll + embedding
 * backfill over a large historical corpus can legitimately take longer than
 * the simpler sweepers' work — an aggressive timeout here would false-positive
 * on a cold-start sweep over a big `~/.claude/projects` tree, not just on a
 * genuine hang.
 */
const TRANSCRIPT_SWEEP_TICK_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

/**
 * Resolve the sweep cadence (SC1 — externally configurable). An explicit
 * `MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS` env override (positive-integer
 * milliseconds) wins; otherwise the default. Env-var config mirrors the
 * cockpit's existing `MINSKY_COCKPIT_*` reads — no config-schema change needed.
 */
export function resolveSweepIntervalMs(): number {
  const raw = process.env.MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    log.warn("cockpit: ignoring invalid MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS", { raw });
  }
  return TRANSCRIPT_SWEEP_INTERVAL_MS;
}

/**
 * Injectable runners for the sweep tick — separate from the real DB wiring so
 * unit tests can inject spies without a real DB or filesystem.
 */
export interface TranscriptSweepDeps {
  /** Run a full ingest sweep (wraps ingestAll). Must be idempotent/HWM-gated. */
  runIngest: () => Promise<{ sessionsProcessed: number; sessionsErrored: number }>;
  /** Run the embedding backfill (wraps PerTurnEmbeddingPipeline.run). May throw. */
  runEmbeddings: () => Promise<void>;
  /** Tracker singleton to record observability counters. */
  tracker: TranscriptSweepTracker;
}

/** Options accepted by startTranscriptSweepBackstop. */
export interface TranscriptSweepBackstopOptions {
  /** Cadence override in milliseconds (default: TRANSCRIPT_SWEEP_INTERVAL_MS). */
  intervalMs?: number;
  /**
   * Injectable deps for testing. When absent, the real DB path is used
   * (ClaudeCodeTranscriptSource + AgentTranscriptIngestService + PerTurnEmbeddingPipeline).
   */
  deps?: TranscriptSweepDeps;
}

/**
 * Build the real sweep deps from the shared persistence service.
 * Returns null when the provider is not SQL-capable.
 */
async function buildRealSweepDeps(): Promise<TranscriptSweepDeps | null> {
  const { getSharedPersistenceService } = await import("./shared-persistence");
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  if (
    !("getDatabaseConnection" in provider) ||
    typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
  ) {
    return null;
  }

  const sqlProvider = provider as {
    getDatabaseConnection: () => Promise<
      import("drizzle-orm/postgres-js").PostgresJsDatabase | null
    >;
  };
  const db = await sqlProvider.getDatabaseConnection();
  if (!db) return null;

  const tracker = TranscriptSweepTracker.getInstance();

  const runIngest = async (): Promise<{ sessionsProcessed: number; sessionsErrored: number }> => {
    const { ClaudeCodeTranscriptSource } = await import(
      "@minsky/domain/transcripts/claude-code-transcript-source"
    );
    const { AgentTranscriptIngestService } = await import(
      "@minsky/domain/transcripts/agent-transcript-ingest-service"
    );
    const source = new ClaudeCodeTranscriptSource();
    const svcIngest = new AgentTranscriptIngestService(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
      source
    );
    const result = await svcIngest.ingestAll();
    return {
      sessionsProcessed: result.sessionsProcessed,
      sessionsErrored: result.sessionsErrored,
    };
  };

  const runEmbeddings = async (): Promise<void> => {
    // createEmbeddingServiceFromConfig throws when no embedding provider is
    // configured or reachable. The tick's outer try/catch (fail-open) handles
    // that case: the sweep ingest counters are already recorded, and only the
    // embedding backfill is skipped — per SC2's requirement that a missing
    // embedding provider must not crash the sweep.
    const { createEmbeddingServiceFromConfig } = await import(
      "@minsky/domain/ai/embedding-service-factory"
    );
    const embeddingService = await createEmbeddingServiceFromConfig();
    const { PerTurnEmbeddingPipeline } = await import(
      "@minsky/domain/transcripts/per-turn-embedding-pipeline"
    );
    const pipeline = new PerTurnEmbeddingPipeline(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
      embeddingService
    );
    await pipeline.run();
  };

  return { runIngest, runEmbeddings, tracker };
}

/**
 * Start the periodic transcript sweep backstop in this cockpit process (mt#2321).
 *
 * BACKSTOP half of ADR-017 (the primary capture path is the FS watcher, mt#2320).
 * Covers failure modes the watcher cannot recover:
 *   - Dropped / coalesced / lost FS-watch events
 *   - Sessions that completed while the cockpit daemon was DOWN
 *   - Sessions predating the watcher's attach that seedExisting did not cover
 *   - Stale / missing pgvector embeddings (via the embedded backfill pass)
 *
 * Sweeper convention (mirrors startAskAdvancementSweeper and startProdStateRefreshSweeper):
 *   - `running` flag skips overlapping ticks
 *   - fail-open try/catch + log.warn on every failure path
 *   - `void tick()` boot pass
 *   - `setInterval` + `.unref()` so the process never stays alive for the sweep alone
 *   - returns `() => clearInterval(id)` stop function
 *   - per-tick timeout + watchdog (mt#2625) via the shared createIntervalSweeper factory
 *
 * Deps are injectable so the sweep core can be unit-tested without a real DB or filesystem.
 *
 * @see docs/architecture/cockpit.md — Transcript sweep backstop (cadence + /api/health payload)
 * @returns stop function (clears the interval).
 */
export function startTranscriptSweepBackstop(opts?: TranscriptSweepBackstopOptions): () => void {
  const resolvedInterval = opts?.intervalMs ?? resolveSweepIntervalMs();

  return createIntervalSweeper({
    name: "transcript sweep backstop",
    intervalMs: resolvedInterval,
    tickTimeoutMs: TRANSCRIPT_SWEEP_TICK_TIMEOUT_MS,
    tick: async () => {
      try {
        // Resolve deps: injected (for tests) or real (for production).
        let sweepDeps: TranscriptSweepDeps | null;
        if (opts?.deps) {
          sweepDeps = opts.deps;
        } else {
          sweepDeps = await buildRealSweepDeps();
        }

        if (!sweepDeps) {
          // Non-SQL provider: nothing to sweep.
          log.debug("cockpit: transcript sweep: no SQL-capable DB, skipping tick");
          return;
        }

        const { runIngest, runEmbeddings, tracker } = sweepDeps;

        // ── Phase 1: ingest sweep (idempotent/HWM-gated) ──────────────────────
        let ingestResult: { sessionsProcessed: number; sessionsErrored: number };
        try {
          ingestResult = await runIngest();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("cockpit: transcript sweep: ingest failed", { message });
          sweepDeps.tracker.recordSweepError();
          return; // Can't meaningfully record a completed sweep if ingest threw.
        }

        // Record ingest counters (includes error count — surfaced, not dropped).
        if (ingestResult.sessionsErrored > 0) {
          log.warn("cockpit: transcript sweep: ingest completed with per-session errors", {
            sessionsProcessed: ingestResult.sessionsProcessed,
            sessionsErrored: ingestResult.sessionsErrored,
          });
        }
        tracker.recordSweepCompleted(ingestResult.sessionsProcessed, ingestResult.sessionsErrored);

        // ── Phase 2: embedding backfill (heavy, fail-open) ─────────────────────
        // SC2: default semantic-embedding backfill, run off the critical path.
        // A missing embedding provider, API error, or DB timeout must NOT crash
        // the sweep or prevent the ingest counters from being recorded.
        try {
          await runEmbeddings();
          tracker.recordEmbedRunCompleted();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("cockpit: transcript sweep: embedding backfill failed (non-fatal)", {
            message,
          });
          tracker.recordSweepError();
          // No return: the ingest phase already completed successfully.
        }
      } catch (err) {
        // Outermost safety net — unexpected throw escaping either phase.
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: transcript sweep: unexpected error in tick", { message });
        // If we have injected deps, at least record an error.
        if (opts?.deps) {
          opts.deps.tracker.recordSweepError();
        } else {
          TranscriptSweepTracker.getInstance().recordSweepError();
        }
      }
    },
  });
}
