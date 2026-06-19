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
import type { TranscriptSweepDeps } from "../src/cockpit/server";

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

  const deps: TranscriptSweepDeps = {
    runIngest: async () => {
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
    },
    // Skip real embeddings in the smoke test — they're provider-dependent and
    // potentially slow. The embedding path is unit-tested in the sweep tests.
    runEmbeddings: async () => {
      console.log(
        "  [smoke] embedding backfill: skipped (provider-dependent; covered by unit tests)"
      );
    },
    tracker,
  };

  // ── 3. Run one sweep tick via the real startTranscriptSweepBackstop ─────────
  console.log("Running one sweep tick against live DB...");

  // Import the sweep function and run one tick synchronously via deps injection.
  const { startTranscriptSweepBackstop } = await import("../src/cockpit/server");

  // The boot tick fires immediately (void tick()); set a very long interval so
  // only one tick runs during the smoke. We wait for the tracker to record it.
  const stop = startTranscriptSweepBackstop({
    intervalMs: 24 * 60 * 60 * 1000, // 24h — effectively one tick only.
    deps,
  });

  // Wait up to 30s for the tick to complete (ingestAll over many sessions can take a few seconds).
  const deadline = Date.now() + 30_000;
  while (tracker.getSummary().sweepsRun < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();

  const summary = tracker.getSummary();

  // ── 4. Assert the tick ran and observability is coherent ─────────────────────
  if (summary.sweepsRun < 1) {
    console.error("FAIL: sweep tick did not complete within 30s.");
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
      },
      null,
      2
    )
  );

  process.exit(0);
}

void main();
