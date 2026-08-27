/**
 * Embedding-backfill sweep for the cockpit daemon (mt#4601).
 *
 * Split out of `transcript-sweep-backstop.ts`, where it ran as "Phase 2" of the
 * transcript sweep's tick.
 *
 * **Batch latency, measured 2026-08-26 rather than inherited.** One batch of 20
 * candidates through the real pipeline against the live database took
 * **8,054 ms** (one provider call, 20 turns embedded). That is **~18x** the
 * 449 ms this task originally sized against — `request-resilience.ts:23` records
 * `p50 368ms p90 449ms max 449ms`, but explicitly for a *"batch of 20 (~2KB
 * each)"*, and real transcript turns are far larger than 2 KB. The figure is
 * accurate about its own payload size and silent about this one, which is why it
 * had to be re-measured here instead of cited.
 *
 * What that implies, and the constants below are derived from it:
 *
 * | quantity | value |
 * | --- | --- |
 * | one batch of 20 | **~8 s** (measured) |
 * | a FULL run at the 2,000-candidate cap | 100 batches ≈ **~13 min** |
 * | a steady-state run (554 candidates when measured) | 28 batches ≈ **~4 min** |
 * | the ingest pass it used to queue behind | ~12 min over ~1,500 sessions |
 * | the daemon's median lifetime on a working day | 13.4 min (mt#4532) |
 *
 * **The split still holds, on a smaller margin than first claimed.** A run that
 * usually takes ~4 minutes was queued behind a 12-minute ingest inside a
 * 13.4-minute process, and skipped outright whenever ingest aborted or failed —
 * every early return in that tick bails before reaching it. On the shipped
 * mt#4532 journal, immediately before this change: **0 of 4 ticks reached Phase
 * 2**, two of them interrupted by a restart.
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
 * **10 minutes, not the ingest sweep's 30**, and the difference is the point:
 * the cadence a periodic job wants is set by its own duration and by how long its
 * host process lives, not by the job it used to share a tick with.
 *
 * A cadence SHORTER than a worst-case run is deliberate, not an oversight.
 * `createIntervalSweeper`'s `running` guard skips an overlapping tick, so during
 * a large drain this simply means the sweep runs continuously — which is what you
 * want while there is a backlog. In steady state a run is ~4 min against a 10-min
 * cadence, so the sweep is idle most of the time and lag stays bounded by roughly
 * one cadence. Freshness is the goal (see the module docblock), and a longer
 * cadence would trade it away for nothing.
 */
const TRANSCRIPT_BACKFILL_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Per-tick timeout: **20 minutes**, derived from the measured batch latency.
 *
 * A full run at the 2,000-candidate cap is 100 batches at ~8 s ≈ **13 minutes**,
 * so this is ~1.5x the worst legitimate run.
 *
 * **This was 5 minutes until the measurement, and 5 minutes was a bug.** It was
 * derived from mt#4212's "~45 s per full run", which assumed a 449 ms batch —
 * a figure measured on ~2KB payloads, not on real transcript turns. At the real
 * ~8 s a 5-minute timeout abandons every full backfill run, which is precisely
 * the starvation this task exists to remove: the fix would have re-created the
 * defect through a different mechanism. Caught by running the sweep against the
 * live database before shipping (it did not conclude in 242 s), not by review.
 *
 * Still far tighter than the 1-hour bound the combined tick used — that was
 * sized for ingest's full-corpus pass, and the backfill inherited it for no
 * reason of its own.
 */
const TRANSCRIPT_BACKFILL_TICK_TIMEOUT_MS = 20 * 60 * 1000;

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
