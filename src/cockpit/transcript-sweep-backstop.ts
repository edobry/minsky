/**
 * Transcript sweep backstop (mt#2321) — the cockpit-daemon half of ADR-017.
 *
 * Extracted from `sweepers.ts` (mt#4480). That file hosts the whole sweeper
 * family and had reached the 1500-line `max-lines` ceiling exactly, so it could
 * not absorb another line; this unit was the natural one to lift out because it
 * is the largest self-contained member and already had its own test file
 * (`transcript-sweep-backstop.test.ts`) naming it. Behaviour is unchanged by the
 * move — only `startTranscriptSweepBackstop`'s abort handling is new, and that
 * is the mt#4480 fix rather than a consequence of relocating.
 *
 * Imports from `./sweepers` rather than re-exporting through it, so there is no
 * import cycle: the three call sites were updated to point here directly.
 *
 * @see src/cockpit/transcript-sweep-tracker.ts — the counters this writes
 * @see docs/architecture/cockpit.md — cadence + /api/health payload
 */

import { log } from "@minsky/shared/logger";
import { isSqlCapable } from "@minsky/domain/persistence/types";

// mt#4489 — STATIC, deliberately, and this is the fix rather than a tidy-up.
//
// These five were `await import(...)` inside `buildRealSweepDeps`, which defers
// module resolution to the first sweep tick — potentially hours after boot.
//
// The daemon is spawned as `bun run src/cli.ts cockpit start` with cwd set to a
// repo root (`cockpit-tray/src-tauri/src/supervisor.rs`), so the process's
// module-resolution root is THAT TREE: `@minsky/*` specifiers resolve through
// its `package.json` workspaces to `<tree>/packages/...`. Note the anchor is the
// tree the entry script came from, not a `process.cwd()` re-read on each import.
// Either way the consequence is the same, and it is why deferring matters: if
// that tree is deleted while the process lives — a session clone that gets
// cleaned up — already-loaded modules keep working and every not-yet-loaded
// import fails with ENOENT.
//
// That is exactly what happened on 2026-08-24: an orphan daemon whose session
// workspace had been deleted logged `embedding backfill failed (non-fatal)
// BuildMessage: ENOENT` reading
// `<deleted-workspace>/packages/domain/src/transcripts/per-turn-embedding-pipeline.ts`
// on the ticks it served, having booted and run fine beforehand.
//
// Resolving at LOAD time closes the window: the workspace is necessarily present
// when the daemon starts, so there is no later moment at which resolution can
// fail. Verified safe to hoist — none of these modules opens a connection or
// performs IO at import (`shared-persistence`'s top level is state declarations
// plus one env read), and `packages/domain` imports nothing from `src/cockpit`,
// so there is no cycle.
import { getSharedPersistenceService } from "./shared-persistence";
import { ClaudeCodeTranscriptSource } from "@minsky/domain/transcripts/claude-code-transcript-source";
import { AgentTranscriptIngestService } from "@minsky/domain/transcripts/agent-transcript-ingest-service";
import { createEmbeddingServiceFromConfig } from "@minsky/domain/ai/embedding-service-factory";
import { PerTurnEmbeddingPipeline } from "@minsky/domain/transcripts/per-turn-embedding-pipeline";

import { deriveEmbedOverdueBoundMs, TranscriptSweepTracker } from "./transcript-sweep-tracker";
import type { TranscriptSweepJournalRecorder } from "./transcript-sweep-journal";
import { isProcessAlive } from "./port-recovery";
import {
  getSchemaReadiness,
  isSchemaBehind,
  refreshSchemaReadinessFromDb,
} from "./schema-readiness";
import { createIntervalSweeper } from "./sweepers";
import type { SweepTickResult } from "./sweepers";

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
/**
 * The abort marker `ingestAll` sets when it abandons a pass (mt#4480).
 *
 * Derived from the domain result type rather than restated, so the cockpit's
 * three references to this shape cannot drift from the producer's.
 */
type TranscriptSweepAbort = NonNullable<
  import("@minsky/domain/transcripts/agent-transcript-ingest-service").IngestAllResult["aborted"]
>;

export interface TranscriptSweepDeps {
  /** Run a full ingest sweep (wraps ingestAll). Must be idempotent/HWM-gated. */
  runIngest: () => Promise<{
    sessionsProcessed: number;
    sessionsErrored: number;
    /** mt#3278 — sessions skipped because they are quarantined. */
    sessionsQuarantined?: number;
    /**
     * mt#4480 — lines actually written this pass. Optional so injected test
     * deps need not supply it; the tracker treats an omitted value as "not
     * reported" rather than as zero.
     */
    totalIngested?: number;
    /**
     * mt#4480 — set when the pass was ABANDONED because the database
     * connection died mid-flight. The tick must branch on this: no other field
     * distinguishes an abandoned pass from a completed one.
     */
    aborted?: TranscriptSweepAbort;
  }>;
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
  /**
   * Set false to skip the schema-readiness gate (mt#3297). Tests that inject
   * `deps` have no real database for the check to interrogate, so leaving it on
   * would make every such test depend on live persistence.
   */
  schemaReadiness?: boolean;
}

/**
 * Build the real sweep deps from the shared persistence service.
 * Returns null when the provider is not SQL-capable.
 */
async function buildRealSweepDeps(): Promise<TranscriptSweepDeps | null> {
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  // Capability + method, via the one guard (mt#4543); the cast goes with the narrowing.
  if (!isSqlCapable(provider)) return null;

  const sqlProvider = provider;
  const db = await sqlProvider.getDatabaseConnection();
  if (!db) return null;

  const tracker = TranscriptSweepTracker.getInstance();

  const runIngest = async (): Promise<{
    sessionsProcessed: number;
    sessionsErrored: number;
    sessionsQuarantined: number;
    totalIngested: number;
    aborted?: TranscriptSweepAbort;
  }> => {
    const source = new ClaudeCodeTranscriptSource();
    const svcIngest = new AgentTranscriptIngestService(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
      source
    );
    const result = await svcIngest.ingestAll();
    return {
      sessionsProcessed: result.sessionsProcessed,
      sessionsErrored: result.sessionsErrored,
      sessionsQuarantined: result.sessionsQuarantined,
      totalIngested: result.totalIngested,
      aborted: result.aborted,
    };
  };

  const runEmbeddings = async (): Promise<void> => {
    // createEmbeddingServiceFromConfig throws when no embedding provider is
    // configured or reachable. The tick's outer try/catch (fail-open) handles
    // that case: the sweep ingest counters are already recorded, and only the
    // embedding backfill is skipped — per SC2's requirement that a missing
    // embedding provider must not crash the sweep. Note this is a CALL-time
    // throw and is unrelated to the mt#4489 import hoist above: the factory is
    // resolved at load, then invoked here.
    const embeddingService = await createEmbeddingServiceFromConfig();
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
 * `journal` is REQUIRED, not optional-with-a-default (mt#4532). ADR-026 rule 3
 * bans the `opts?.journal ?? createRealOne()` shape regardless of tier, and the
 * reason applies exactly here: the fallback would silently write to the
 * operator's real state dir the moment a test forgot to inject one. The
 * composition root — `src/commands/cockpit/start-command.ts` — constructs the
 * file-backed recorder; tests construct a memory-backed one.
 *
 * @see docs/architecture/cockpit.md — Transcript sweep backstop (cadence + /api/health payload)
 * @returns stop function (clears the interval).
 */
export function startTranscriptSweepBackstop(
  journal: TranscriptSweepJournalRecorder,
  opts?: TranscriptSweepBackstopOptions
): () => void {
  const resolvedInterval = opts?.intervalMs ?? resolveSweepIntervalMs();

  // mt#4524: the overdue bound is derived from THIS sweeper's actual budgets,
  // not hardcoded, so an `MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS` override moves it
  // too. Set on the singleton because that is the instance `/api/health` reads
  // (`routes/health.ts` calls `TranscriptSweepTracker.getInstance()`); a test
  // injecting its own tracker configures that tracker's bound directly.
  TranscriptSweepTracker.getInstance().setEmbedOverdueBoundMs(
    deriveEmbedOverdueBoundMs(resolvedInterval, TRANSCRIPT_SWEEP_TICK_TIMEOUT_MS)
  );

  // mt#4532 — fold any tick the previous process was still running when it was
  // replaced. Runs BEFORE the boot tick, so it reconciles the PREVIOUS process's
  // record rather than one this process just wrote.
  // This is the ONLY place an `interrupted` outcome can be recorded: a process
  // that is killed cannot write its own terminal record (`supervisor.rs`'s
  // `do_stop` sends SIGTERM and SIGKILL with no wait between them, so a
  // shutdown handler races a SIGKILL arriving microseconds later — verified in
  // `cockpit-tray/src-tauri/src/supervisor.rs` and recorded on mt#4040).
  journal.reconcileAtBoot(isProcessAlive);

  return createIntervalSweeper({
    name: "transcript sweep backstop",
    intervalMs: resolvedInterval,
    tickTimeoutMs: TRANSCRIPT_SWEEP_TICK_TIMEOUT_MS,
    tick: async (): Promise<SweepTickResult> => {
      // mt#4532 — mark the tick STARTED before any work, so a process replaced
      // at any point below leaves a record that a tick was in flight. This is
      // the whole mechanism: nothing written at shutdown can be relied on.
      journal.tickStarted();
      try {
        // Resolve deps: injected (for tests) or real (for production).
        let sweepDeps: TranscriptSweepDeps | null;
        if (opts?.deps) {
          sweepDeps = opts.deps;
        } else {
          sweepDeps = await buildRealSweepDeps();
        }

        if (!sweepDeps) {
          // mt#4412 — cannot sweep, so not a healthy no-op.
          log.debug("cockpit: transcript sweep: no SQL-capable DB, skipping tick");
          journal.tickEnded("skipped");
          return { ok: false };
        }

        const { runIngest, runEmbeddings, tracker } = sweepDeps;

        // ── Phase 0: schema readiness (mt#3297) ───────────────────────────────
        // Every write below targets columns this build expects the DB to have.
        // After a merge that carries a migration, the tray restarts the daemon
        // onto the new code within seconds while the migration is (correctly)
        // NOT applied automatically to a shared database — so there is a window
        // where all of this fails on a missing column. Skipping the sweep once,
        // with a reason, replaces one failure per session per tick.
        //
        // Re-checked every tick rather than only at boot, so applying the
        // migration lifts the pause on the next tick with no restart.
        if (opts?.schemaReadiness !== false) {
          await refreshSchemaReadinessFromDb();
          if (isSchemaBehind()) {
            // At debug, not warn: `refreshSchemaReadinessFromDb` already logged
            // the transition into behind at warn, and repeating the reason on
            // every tick would make a check whose purpose is bounding log volume
            // into a recurring writer (PR #2379 R1). The standing condition is
            // on /api/health.
            log.debug("cockpit: transcript sweep skipped — schema behind", {
              pending: getSchemaReadiness().pending,
            });
            journal.tickEnded("skipped");
            // mt#4412: a domain failure, even though the pause is DELIBERATE
            // and correct. The sweep is not doing its work, and a daemon left
            // schema-behind indefinitely is exactly the standing inertness
            // this field exists to expose. Self-clearing — the next tick after
            // the migration lands reports ok again — and harmless, because
            // domain failures are reported, never acted on (no re-init, no
            // restart; see the domain-outcome block in createIntervalSweeper).
            return { ok: false };
          }
        }

        // ── Phase 1: ingest sweep (idempotent/HWM-gated) ──────────────────────
        let ingestResult: {
          sessionsProcessed: number;
          sessionsErrored: number;
          sessionsQuarantined?: number;
          totalIngested?: number;
          aborted?: TranscriptSweepAbort;
        };
        try {
          ingestResult = await runIngest();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("cockpit: transcript sweep: ingest failed", { message });
          sweepDeps.tracker.recordSweepError();
          journal.tickEnded("failed");
          // Can't meaningfully record a completed sweep if ingest threw.
          return { ok: false };
        }

        // mt#4480: the pass was ABANDONED — the database connection died under
        // it, so every session after the abort point was never attempted. Bail
        // before Phase 2, which needs the same dead connection, and before
        // `recordSweepCompleted`, which would file this as a sweep that
        // happened. The next tick rebuilds deps and gets a fresh handle; the
        // ingest is idempotent and high-water-mark gated, so abandoning costs
        // one cadence interval and nothing else.
        if (ingestResult.aborted) {
          log.error("cockpit: transcript sweep: ABANDONED — database connection lost mid-pass", {
            ...ingestResult.aborted,
            sessionsProcessed: ingestResult.sessionsProcessed,
            totalIngested: ingestResult.totalIngested,
          });
          tracker.recordSweepAborted();
          journal.tickEnded("aborted");
          return { ok: false };
        }

        // Record ingest counters (includes error count — surfaced, not dropped).
        if (ingestResult.sessionsErrored > 0) {
          log.warn("cockpit: transcript sweep: ingest completed with per-session errors", {
            sessionsProcessed: ingestResult.sessionsProcessed,
            sessionsErrored: ingestResult.sessionsErrored,
          });
        }
        // mt#3278: a quarantined session is not an error this pass — nothing was
        // attempted — but it IS a standing condition an operator needs to see,
        // so it is logged every sweep rather than only when it first happens.
        if ((ingestResult.sessionsQuarantined ?? 0) > 0) {
          log.warn("cockpit: transcript sweep: sessions quarantined and not attempted", {
            sessionsQuarantined: ingestResult.sessionsQuarantined,
          });
        }
        tracker.recordSweepCompleted(
          ingestResult.sessionsProcessed,
          ingestResult.sessionsErrored,
          ingestResult.sessionsQuarantined ?? 0,
          ingestResult.totalIngested
        );

        // ── Phase 2: embedding backfill (heavy, fail-open) ─────────────────────
        // SC2: default semantic-embedding backfill, run off the critical path.
        // A missing embedding provider, API error, or DB timeout must NOT crash
        // the sweep or prevent the ingest counters from being recorded.
        let embeddingsOk = true;
        // mt#4524: mark the attempt STARTED before the await, not only after it
        // returns. Phase 1's `recordSweepCompleted` has already fired, so
        // without this the tracker cannot distinguish "backfill running" from
        // "backfill never succeeded" for the entire duration of Phase 2 — which
        // over ~1500 sessions is minutes, not milliseconds.
        tracker.recordEmbedRunStarted();
        // mt#4532 — the same reasoning, one level up: the journal marks Phase 2
        // ENTERED here, so `reachedPhase2` counts a tick killed mid-backfill.
        journal.phase2Started();
        try {
          await runEmbeddings();
          tracker.recordEmbedRunCompleted();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("cockpit: transcript sweep: embedding backfill failed (non-fatal)", {
            message,
          });
          // Both, deliberately: `recordSweepError` timestamps a sweep-level
          // error shared with the ingest phase, and cannot say WHICH phase
          // failed; `recordEmbedRunFailed` concludes the attempt so `embedPhase`
          // leaves `in-flight` and `embedNeverSucceeded` can become true.
          tracker.recordEmbedRunFailed();
          tracker.recordSweepError();
          embeddingsOk = false;
          // No return: the ingest phase already completed successfully.
        }

        // mt#4412: this sweep has TWO phases, so one boolean has to say
        // something honest about both. Non-fatal to the tick is not the same
        // as fine — a permanently failing embedding backfill already called
        // `recordSweepError()` on every pass, and reporting `ok: true` beside
        // that would be the contradiction this task exists to remove.
        // `sessionsErrored` is included for the same reason: a sweep that
        // processes every session and errors on all of them did not succeed.
        journal.tickEnded(embeddingsOk ? "completed" : "embed-failed");
        return { ok: embeddingsOk && ingestResult.sessionsErrored === 0 };
      } catch (err) {
        // Outermost safety net — unexpected throw escaping either phase.
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: transcript sweep: unexpected error in tick", { message });
        journal.tickEnded("failed");
        // If we have injected deps, at least record an error.
        if (opts?.deps) {
          opts.deps.tracker.recordSweepError();
        } else {
          TranscriptSweepTracker.getInstance().recordSweepError();
        }
        return { ok: false };
      }
    },
  });
}
