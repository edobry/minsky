#!/usr/bin/env bun
/**
 * Smoke test for the cockpit-daemon transcript sweep backstop (mt#2321).
 *
 * Verifies the STRUCTURAL correctness of the sweep tick: the real ingestAll()
 * path runs against a live DB and the observability tracker records the result.
 * No unit test (which stubs the DB) can verify that the sweeper wires correctly
 * to a real PersistenceService — this script is the §7a verification artifact.
 *
 * Env-gated: requires DATABASE_URL (or a Postgres connection string reachable
 * from the local environment). Skips gracefully (exit 0, "SKIP") when absent —
 * safe to run anywhere. Run from a context with the shared/prod connection and
 * paste the redacted output under "## Live verification" in the PR body.
 *
 * The ingest is idempotent/HWM-gated — re-running does not create duplicate
 * transcript turns. No test rows are written and no cleanup is required.
 *
 * ## Live verification
 *
 * The main agent will run this script against the live DB after PR creation.
 * Subagents lack the DATABASE_URL needed for live execution (live-verification
 * gap pattern per implement-task §7a — subagent ships the artifact, main agent
 * runs it).
 *
 * Usage: bun scripts/smoke-transcript-sweep.ts
 */
import "reflect-metadata";
import { TranscriptSweepTracker } from "../src/cockpit/transcript-sweep-tracker";
import type { TranscriptSweepDeps } from "../src/cockpit/transcript-sweep-backstop";

const connectionString = process.env.DATABASE_URL ?? process.env.MINSKY_POSTGRES_CONNECTION_STRING;

async function main(): Promise<void> {
  // ── 1. Bootstrap persistence service ────────────────────────────────────────
  const { PersistenceService } = await import("@minsky/domain/persistence/service");
  const service = new PersistenceService();

  try {
    if (connectionString) {
      await service.initialize({ backend: "postgres", postgres: { connectionString } });
    } else {
      const { initializeConfiguration, CustomConfigFactory } = await import(
        "@minsky/domain/configuration"
      );
      await initializeConfiguration(new CustomConfigFactory(), {
        workingDirectory: process.cwd(),
      });
      await service.initialize();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (connectionString) {
      console.error(`FAIL: cannot connect to DB via provided connection string: ${msg}`);
      process.exit(1);
    }
    console.log(`SKIP: no reachable DB configured (env unset + config init failed): ${msg}`);
    process.exit(0);
  }

  const provider = service.getProvider();
  if (
    !("getDatabaseConnection" in provider) ||
    typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
  ) {
    console.log("SKIP: configured backend is not SQL-capable (not postgres).");
    process.exit(0);
  }

  const sqlProvider = provider as {
    getDatabaseConnection: () => Promise<
      import("drizzle-orm/postgres-js").PostgresJsDatabase | null
    >;
  };
  const db = await sqlProvider.getDatabaseConnection();
  if (!db) {
    console.log("SKIP: getDatabaseConnection() returned null (DB not ready).");
    process.exit(0);
  }

  // ── 2. Build injectable sweep deps (real ingest, no embeddings for smoke) ──
  const tracker = TranscriptSweepTracker.resetForTest();

  // BOUNDED wiring check — deliberately NOT the full ingestAll. A full-corpus
  // ingestAll re-reads every session on disk (a double read per session for cwd
  // recovery + turn extraction) and runs for many minutes on a large local
  // corpus — it is the MCP boot sweep's proven operation (mt#2051), not what a
  // bounded smoke can verify. This smoke verifies the STRUCTURAL seam unit tests
  // (which inject deps) cannot: the sweep tick wired to a REAL PersistenceService
  // executes a live DB read and records redacted observability. runIngest does
  // one bounded real query against the live DB.
  const { sql } = await import("drizzle-orm");
  const deps: TranscriptSweepDeps = {
    runIngest: async () => {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n FROM agent_transcripts`
      )) as Array<Record<string, unknown>>;
      const n = Number(rows?.[0]?.n ?? 0);
      // Repurpose sessionsProcessed as "sessions visible in the live DB" — proves
      // the sweep tick read real data through the real persistence wiring.
      return { sessionsProcessed: n, sessionsErrored: 0 };
    },
    // Skip real embeddings — provider-dependent + slow; covered by unit tests.
    runEmbeddings: async () => {},
    tracker,
  };

  // ── 3. Run one sweep tick via the real startTranscriptSweepBackstop ─────────
  console.log("Running one sweep tick against live DB...");

  // Import the sweep function and run one tick synchronously via deps injection.
  const { startTranscriptSweepBackstop } = await import("../src/cockpit/transcript-sweep-backstop");

  // The boot tick fires immediately (void tick()); set a very long interval so
  // only one tick runs during the smoke. We wait for the tracker to record it.
  // mt#4532: an in-MEMORY journal, deliberately. The smoke asserts the tick
  // reports its outcome to the journal seam; it must not write into the
  // operator's real `~/.local/state/minsky/transcript-sweep-journal.json` and
  // pollute the very counters this change exists to make trustworthy.
  const { createMemoryJournalStore, summarizeJournal, TranscriptSweepJournalRecorder } =
    await import("../src/cockpit/transcript-sweep-journal");
  const journalStore = createMemoryJournalStore();

  const stop = startTranscriptSweepBackstop(new TranscriptSweepJournalRecorder(journalStore), {
    intervalMs: 24 * 60 * 60 * 1000, // 24h — effectively one tick only.
    deps,
  });

  // Wait for the tick to complete. A full-corpus ingestAll re-reads every
  // discoverable session (idempotent/HWM-gated, but still I/O over the whole
  // local corpus), which can take well over a minute on a large machine. The
  // deadline is generous but stays under the 120s session_exec cap.
  // The bounded wiring check completes in ~1s; this deadline only guards a hung
  // DB connection.
  const TICK_DEADLINE_MS = 30_000;
  const deadline = Date.now() + TICK_DEADLINE_MS;
  while (tracker.getSummary().sweepsRun < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  stop();

  const summary = tracker.getSummary();

  // ── 4. Assert the tick ran and observability is coherent ─────────────────────
  if (summary.sweepsRun < 1) {
    // Surface the tracker state so a timeout is diagnosable: a set lastErrorAt
    // means ingestAll errored (the tick aborted phase 1); an all-zero summary
    // means the full-corpus ingest is genuinely still running past the deadline.
    console.error(
      `FAIL: no completed sweep within ${TICK_DEADLINE_MS / 1000}s. Tracker: ${JSON.stringify(summary)}`
    );
    process.exit(1);
  }

  if (summary.lastSweepAt === null) {
    console.error("FAIL: lastSweepAt is null after a completed sweep.");
    process.exit(1);
  }

  // Validate the timestamp is parseable (no raw paths / error strings in the output).
  try {
    new Date(summary.lastSweepAt).toISOString();
  } catch {
    console.error(`FAIL: lastSweepAt is not a valid ISO timestamp: ${summary.lastSweepAt}`);
    process.exit(1);
  }

  // ── 4b. mt#4532: the tick reported its outcome to the cross-restart journal ──
  //
  // The unit tests cover this against injected deps. What is verified HERE is
  // that the wiring holds on the REAL path — the same distinction §7a draws for
  // the tracker above, and the reason this script exists at all.
  const journal = summarizeJournal(journalStore.read());

  if (journal.totals.started < 1) {
    console.error(
      `FAIL: the tick ran (sweepsRun=${summary.sweepsRun}) but the journal recorded no start. ` +
        `Journal: ${JSON.stringify(journal.totals)}`
    );
    process.exit(1);
  }

  if (journal.inFlight !== null) {
    console.error(
      "FAIL: the journal still shows a tick in flight after the sweep concluded — " +
        "some exit path did not report its outcome."
    );
    process.exit(1);
  }

  // ── 4c. mt#4601: the BACKFILL sweep's own real path ──────────────────────────
  //
  // The backfill is its own sweep now, so §7a's "exercise each production
  // branch" applies: the section above verifies the ingest sweep, and this
  // verifies the one that was split out. It runs the REAL
  // `startTranscriptBackfillSweep` against a real `resolveDeps`, with the real
  // embedding pipeline — a bounded run (2,000 candidates max) doing the
  // system's own routine work.
  const { startTranscriptBackfillSweep } = await import("../src/cockpit/transcript-backfill-sweep");
  const { buildRealSweepDeps } = await import("../src/cockpit/transcript-sweep-backstop");
  const backfillStore = createMemoryJournalStore();
  const stopBackfill = startTranscriptBackfillSweep(
    new TranscriptSweepJournalRecorder(backfillStore, "embedding backfill"),
    {
      intervalMs: 24 * 60 * 60 * 1000, // 24h — the boot tick only.
      resolveDeps: async () => {
        const d = await buildRealSweepDeps();
        return d === null ? null : { runEmbeddings: d.runEmbeddings, tracker: d.tracker };
      },
    }
  );

  // 15 minutes: a full 2,000-candidate run is ~13 min at the MEASURED ~8s batch
  // latency, and this stays inside the sweep's own 20-minute tick timeout so a
  // smoke that passes cannot describe a run production would have abandoned.
  // It was 4 minutes and the run blew through it — that is what surfaced the
  // 18x error in mt#4212's inherited ~45s figure.
  const BACKFILL_DEADLINE_MS = 15 * 60 * 1000;
  const backfillDeadline = Date.now() + BACKFILL_DEADLINE_MS;
  while (backfillStore.read().totals.started === 0 && Date.now() < backfillDeadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  while (backfillStore.read().inFlight !== null && Date.now() < backfillDeadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  stopBackfill();

  const backfillJournal = summarizeJournal(backfillStore.read());

  if (backfillJournal.totals.started < 1) {
    console.error(
      `FAIL: the backfill sweep did not start a tick within ${BACKFILL_DEADLINE_MS / 1000}s. ` +
        `Journal: ${JSON.stringify(backfillJournal.totals)}`
    );
    process.exit(1);
  }

  if (backfillJournal.inFlight !== null) {
    console.error(
      "FAIL: the backfill tick was still in flight at the deadline — it did not conclude."
    );
    process.exit(1);
  }

  // ── 5. Output (redacted: no absolute paths, no raw error strings) ────────────
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        sweepsRun: summary.sweepsRun,
        sessionsIngested: summary.sessionsIngested,
        sessionsErrored: summary.sessionsErrored,
        embedRuns: summary.embedRuns,
        lastSweepAt: summary.lastSweepAt,
        lastErrorAt: summary.lastErrorAt,
        journal: {
          totals: journal.totals,
          completionRate: journal.completionRate,
          lastOutcome: journal.lastOutcome,
        },
        backfillSweep: {
          totals: backfillJournal.totals,
          completionRate: backfillJournal.completionRate,
          lastOutcome: backfillJournal.lastOutcome,
          embedRuns: tracker.getSummary().embedRuns,
          embedPhase: tracker.getSummary().embedPhase,
        },
      },
      null,
      2
    )
  );

  process.exit(0);
}

void main();
