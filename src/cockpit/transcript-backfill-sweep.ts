/**
 * Embedding-backfill sweep for the cockpit daemon (mt#4601).
 *
 * Split out of `transcript-sweep-backstop.ts`, where it ran as "Phase 2" of the
 * transcript sweep's tick. The split is structural, and three measured numbers
 * are the whole argument:
 *
 * - A backfill run is **bounded at ~45 s** — `DEFAULT_MAX_CANDIDATES_PER_RUN` is
 *   2,000 at `batchSize` 20, i.e. 100 provider calls, against a measured
 *   worst-case batch latency of 449 ms (`packages/domain/src/ai/request-resilience.ts:23`).
 * - The ingest pass it sat behind takes **~12 minutes** over ~1,500 sessions.
 * - The daemon's median lifetime on a working day is **13.4 minutes** (mt#4532
 *   measured 23 boots in one day).
 *
 * So a 45-second job was queued behind a 12-minute one inside a 13-minute
 * process, and then skipped outright whenever ingest aborted or failed — every
 * early return in that tick bails before reaching it. On the shipped mt#4532
 * journal, immediately before this change: **0 of 4 ticks reached Phase 2**, two
 * of them interrupted by a restart.
 *
 * **What this does NOT fix, stated up front because the filing overstated it.**
 * mt#4601's planning pass measured the real backlog at **919 turns**, with nine
 * consecutive prior days fully drained — the backfill was starved of
 * OPPORTUNITIES and still getting its work done, because one successful run
 * (2,000 candidates) covers a median day's intake (~2,200 embeddable turns).
 * What the starvation costs is FRESHNESS: semantic search over the last few
 * hours going stale on days the sweep is interrupted. This change shortens that
 * tail; it does not recover lost embeddings, because none were being lost.
 *
 * @see src/cockpit/transcript-sweep-backstop.ts — the ingest sweep this left
 * @see docs/architecture/cockpit.md — cadence + the `/api/health` payload
 */

import { log } from "@minsky/shared/logger";
import { TranscriptSweepTracker } from "./transcript-sweep-tracker";
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
 * Default cadence for the embedding backfill.
 *
 * **10 minutes, not the ingest sweep's 30**, and the difference is the point.
 * The cadence a periodic job wants is set by its own duration and by how long
 * its host process lives, not by the job it used to share a tick with. At ~45 s
 * per run against a 13.4-minute median daemon lifetime, a 10-minute cadence gives
 * roughly one attempt per process — where the old arrangement gave a bounded job
 * a window that opened at minute 12 of a 30-minute cycle.
 *
 * Grounded per `decision-defaults.mdc §Thresholds` rather than picked round:
 * 10 min is the same cadence `prod-state refresh` already uses for a comparably
 * short DB-backed job, so this adds no new number to the system.
 */
const TRANSCRIPT_BACKFILL_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Per-tick timeout.
 *
 * 5 minutes against a ~45 s expected run: generous enough that a slow provider
 * or a large batch does not trip it, tight enough that a WEDGED run is abandoned
 * inside one cadence rather than holding the guard for an hour the way the
 * combined tick's 1-hour bound did (that bound was sized for ingest's full-corpus
 * pass, and the backfill inherited it for no reason of its own).
 */
const TRANSCRIPT_BACKFILL_TICK_TIMEOUT_MS = 5 * 60 * 1000;

/** Env override for the backfill cadence, mirroring the ingest sweep's. */
export function resolveBackfillIntervalMs(): number {
  const raw = process.env.MINSKY_TRANSCRIPT_BACKFILL_INTERVAL_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    log.warn("cockpit: ignoring invalid MINSKY_TRANSCRIPT_BACKFILL_INTERVAL_MS", { raw });
  }
  return TRANSCRIPT_BACKFILL_INTERVAL_MS;
}

/** Injectable deps for the backfill tick. */
export interface TranscriptBackfillDeps {
  /** Run the embedding backfill (wraps PerTurnEmbeddingPipeline.run). May throw. */
  runEmbeddings: () => Promise<void>;
  /** Tracker singleton to record observability counters. */
  tracker: TranscriptSweepTracker;
}

/** Options accepted by {@link startTranscriptBackfillSweep}. */
export interface TranscriptBackfillSweepOptions {
  intervalMs?: number;
  /**
   * Resolve this tick's deps. **Required, and called PER TICK** — the database
   * handle must be re-resolved each time rather than captured at startup, which
   * is the same reason the ingest sweep rebuilds its deps inside its own tick
   * (a pool recycle replaces the handle under a long-lived closure).
   *
   * A REQUIRED resolver rather than an optional `deps` with a real-builder
   * fallback: ADR-026 rule 3 bans `opts?.deps ?? buildReal()` regardless of
   * tier, because a test that forgets to inject reaches real infrastructure
   * silently. Returning `null` means "cannot sweep this tick".
   */
  resolveDeps: () => Promise<TranscriptBackfillDeps | null>;
  /** Set false to skip the schema-readiness gate (mt#3297), as the sibling does. */
  schemaReadiness?: boolean;
}

/**
 * Start the embedding-backfill sweep in this cockpit process (mt#4601).
 *
 * `journal` is REQUIRED, as it is on the ingest sweep and for the same reason
 * (ADR-026 rule 3): an `opts?.journal ?? createRealOne()` fallback would write to
 * the operator's real state dir the moment a test forgot to inject one. The
 * composition root constructs it against
 * {@link getTranscriptBackfillJournalPath}; tests pass a memory-backed store.
 *
 * @returns stop function (clears the interval).
 */
export function startTranscriptBackfillSweep(
  journal: TranscriptSweepJournalRecorder,
  opts: TranscriptBackfillSweepOptions
): () => void {
  // Fold any backfill tick the previous process was still running when it was
  // replaced. Same reasoning as the ingest sweep's: a killed process cannot
  // write its own terminal record, so `interrupted` can only be reconstructed
  // here, at the next boot.
  journal.reconcileAtBoot(isProcessAlive);

  return createIntervalSweeper({
    name: "transcript embedding backfill",
    intervalMs: opts.intervalMs ?? resolveBackfillIntervalMs(),
    tickTimeoutMs: TRANSCRIPT_BACKFILL_TICK_TIMEOUT_MS,
    tick: async (): Promise<SweepTickResult> => {
      journal.tickStarted();
      try {
        const deps = await opts.resolveDeps();
        if (deps === null) {
          // mt#4412 — cannot sweep, so not a healthy no-op.
          log.debug("cockpit: embedding backfill: no SQL-capable DB, skipping tick");
          journal.tickEnded("skipped");
          return { ok: false };
        }
        const { runEmbeddings, tracker } = deps;

        // Schema readiness (mt#3297), same gate the ingest sweep applies: the
        // backfill writes to `agent_transcript_turns.embedding`, so a build ahead
        // of the applied migrations fails per-row rather than once.
        if (opts.schemaReadiness !== false) {
          await refreshSchemaReadinessFromDb();
          if (isSchemaBehind()) {
            log.debug("cockpit: embedding backfill skipped — schema behind", {
              pending: getSchemaReadiness().pending,
            });
            journal.tickEnded("skipped");
            // mt#4412: a deliberate pause is still not work done.
            return { ok: false };
          }
        }

        tracker.recordEmbedRunStarted();
        try {
          await runEmbeddings();
          tracker.recordEmbedRunCompleted();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("cockpit: embedding backfill failed (non-fatal)", { message });
          tracker.recordEmbedRunFailed();
          journal.tickEnded("failed");
          return { ok: false };
        }

        journal.tickEnded("completed");
        return { ok: true };
      } catch (err) {
        // Outermost safety net — a throw escaping dep resolution or the schema
        // gate, neither of which is inside the inner try above.
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: embedding backfill: unexpected error in tick", { message });
        journal.tickEnded("failed");
        return { ok: false };
      }
    },
  });
}
