#!/usr/bin/env bun
/**
 * Smoke test for the cockpit-daemon transcript watcher (mt#2320).
 *
 * The watcher is a STRUCTURAL change (implement-task §7a): its correctness
 * depends on live filesystem-watch + DB-ingest behavior that no unit test can
 * fully verify (the unit tests inject the ingest and skip fs.watch). This
 * script exercises the REAL path end-to-end:
 *
 *   start watcher over a temp projects dir → create a transcript JSONL with a
 *   distinctive phrase → wait for the fs.watch event to drive ingest → assert
 *   the session's turns were materialized (FTS-ready: `user_text` populated and
 *   `fts_text` non-NULL) ON CAPTURE, with no manual ingest / exit / reboot
 *   (SC1, SC3).
 *
 * Env-gated: requires `DATABASE_URL` (or `MINSKY_POSTGRES_CONNECTION_STRING`),
 * or a config-resolvable postgres backend. SKIPs gracefully (exit 0) when no
 * reachable DB is configured, so it is safe to run anywhere. Always cleans up
 * its temp dir AND the test rows it wrote (test-prefixed session id).
 *
 * Usage: bun scripts/smoke-transcript-watcher.ts
 *
 * @see mt#2320 — the watcher this verifies
 * @see scripts/smoke-prod-state-cache.ts — sibling smoke (DB-acquisition pattern)
 */
import "reflect-metadata";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { startTranscriptWatcher } from "../src/cockpit/transcript-watcher";
import { TranscriptWatcherTracker } from "../src/cockpit/transcript-watcher-tracker";

/** postgres-js tagged-template connection (raw SQL for assert + cleanup). */
type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Array<Record<string, unknown>>>;

const connectionString = process.env.DATABASE_URL ?? process.env.MINSKY_POSTGRES_CONNECTION_STRING;

const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 300;

function skip(reason: string): never {
  process.stdout.write(`SKIP: ${reason}\n`);
  process.exit(0);
}
function fail(reason: string): never {
  process.stdout.write(`FAIL: ${reason}\n`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { PersistenceService } = await import("@minsky/domain/persistence/service");
  const service = new PersistenceService();
  try {
    if (connectionString) {
      await service.initialize({ backend: "postgres", postgres: { connectionString } });
    } else {
      const { initializeConfiguration, CustomConfigFactory } = await import(
        "@minsky/domain/configuration"
      );
      await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
      await service.initialize();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (connectionString) fail(`cannot connect to DB via provided connection string: ${msg}`);
    skip(`no reachable DB configured (env unset + config init failed): ${msg}`);
  }

  const provider = service.getProvider();
  if (
    !("getDatabaseConnection" in provider) ||
    typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function" ||
    !("getRawSqlConnection" in provider) ||
    typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection !== "function"
  ) {
    skip("configured backend is not postgres (no DB/raw-SQL connection).");
  }
  const db = (await (
    provider as { getDatabaseConnection: () => Promise<PostgresJsDatabase> }
  ).getDatabaseConnection()) as PostgresJsDatabase;
  const sql = (await (
    provider as { getRawSqlConnection: () => Promise<unknown> }
  ).getRawSqlConnection()) as Sql;

  // Unique, clearly test-prefixed session id (basename of the JSONL file).
  const sessionId = `smoke-watcher-${process.pid}-${Date.now()}`;
  const phrase = `smoke-distinctive-${process.pid}-${Date.now()}`;
  const projectsDir = mkdtempSync(join(tmpdir(), "smoke-watcher-projects-"));
  const projDir = join(projectsDir, "project-x");
  mkdirSync(projDir, { recursive: true });
  const jsonlPath = join(projDir, `${sessionId}.jsonl`);

  const tracker = TranscriptWatcherTracker.resetForTest();
  const stop = startTranscriptWatcher({
    claudeProjectsDir: projectsDir,
    debounceMs: 150,
    tracker,
    getDb: async () => db,
  });

  let result: "PASS" | "FAIL" = "FAIL";
  let detail = "";
  try {
    // Let the watch attach + initial (empty) seed run.
    await sleep(300);

    // Create the transcript with a user turn carrying the distinctive phrase.
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: phrase },
      cwd: projDir,
      uuid: "smoke-u1",
      timestamp: new Date().toISOString(),
    });
    writeFileSync(jsonlPath, `${line}\n`);

    // Poll the DB until the watcher has materialized the turn (FTS-ready).
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let turns = 0;
    let ftsReady = 0;
    while (Date.now() < deadline) {
      const rows = await sql`
        SELECT
          count(*)::int AS turns,
          count(*) FILTER (
            WHERE user_text ILIKE ${`%${phrase}%`} AND fts_text IS NOT NULL
          )::int AS fts_ready
        FROM agent_transcript_turns
        WHERE agent_session_id = ${sessionId}
      `;
      turns = Number(rows[0]?.turns ?? 0);
      ftsReady = Number(rows[0]?.fts_ready ?? 0);
      if (ftsReady > 0) break;
      await sleep(POLL_INTERVAL_MS);
    }

    if (ftsReady > 0) {
      result = "PASS";
      detail = `turns=${turns} ftsReady=${ftsReady} trackerIngests=${tracker.getSummary().ingestsSucceeded}`;
    } else {
      detail = `no FTS-ready turn for session after ${POLL_TIMEOUT_MS}ms (turns=${turns}, tracker=${JSON.stringify(
        tracker.getSummary()
      )})`;
    }
  } finally {
    stop();
    // Clean up temp dir + the rows we wrote (don't pollute the DB).
    rmSync(projectsDir, { recursive: true, force: true });
    try {
      await sql`DELETE FROM agent_transcript_turns WHERE agent_session_id = ${sessionId}`;
      await sql`DELETE FROM agent_transcript_attachments WHERE agent_session_id = ${sessionId}`;
      await sql`DELETE FROM agent_transcripts WHERE agent_session_id = ${sessionId}`;
    } catch {
      // best-effort cleanup
    }
  }

  if (result === "PASS") {
    process.stdout.write(`${JSON.stringify({ result: "PASS", sessionId, detail }, null, 2)}\n`);
    process.exit(0);
  }
  fail(detail);
}

void main();
