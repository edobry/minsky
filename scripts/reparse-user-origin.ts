#!/usr/bin/env bun
/**
 * mt#4877: re-derive `agent_transcript_turns.user_origin` for the conversations
 * mt#4875's classifier fix changes.
 *
 * **Why this exists when a sweep already does.** `user_origin` is written at
 * ingest, so mt#4875's fix corrects newly-ingested lines and leaves every stored
 * row at its old value. ADR-025 §Promoted-column register requires such a column
 * to be *"backfilled by re-parse, not by a bespoke script"*, and
 * `writeTurnsForTranscript` is that re-parse — but nothing drives it over a
 * CHOSEN population. The two candidates were both eliminated by running them:
 *
 * - `scripts/backfill-agent-transcript-turns.ts` drives the same writer, but its
 *   dry-run gate is bound to mt#2457's operation (zero-turn sessions against a
 *   ~651 baseline) and correctly STOPS on this one. Overriding it would borrow
 *   another task's authorization.
 * - `transcripts_ingest --conversationId=<id>` is incremental by timestamp and
 *   no-ops when the JSONL is unchanged. Verified against a session with 6
 *   shadowed lines: `totalIngested: 0`, turn rows byte-identical before/after.
 *
 * So this is a DRIVER, not a backfill: it selects sessions and calls the
 * sanctioned writer. The thing ADR-025 rules out is a hand-written UPDATE
 * against `user_origin`, and there is none here.
 *
 * **What "affected" means.** A session carrying at least one `user` line with
 * BOTH `isMeta: true` and an `origin.kind` — the shape mt#4875 unshadowed.
 * Measured full-corpus 2026-09-01: 372 such lines across 230 of 3,193 sessions.
 * The list is re-derived at run time, never read from that measurement.
 *
 * Usage:
 *   bun scripts/reparse-user-origin.ts                      # dry-run
 *   bun scripts/reparse-user-origin.ts --execute            # re-parse affected sessions
 *   bun scripts/reparse-user-origin.ts --execute --after-id=<id>   # resume
 *   bun scripts/reparse-user-origin.ts --page-size=200
 *
 * Idempotent: the writer upserts and preserves an existing embedding whenever a
 * turn's text is unchanged (mt#3883), and no text changes here — only the
 * derived `user_origin` column.
 *
 * Exits 0 on a clean dry-run or a clean execute, 1 on a scope-match STOP or a
 * run that errored a session.
 *
 * @see mt#4877 — this task; mt#4875 — the classifier fix it follows
 * @see packages/domain/src/transcripts/turn-writer.ts — writeTurnsForTranscript
 * @see docs/architecture/adr-025-transcript-storage-object-store-system-of-record.md
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

/** Affected-session count measured full-corpus 2026-09-01 (mt#4877 §Context). */
const EXPECTED_SESSIONS = 230;
/** Shadowed-line count measured full-corpus 2026-09-01. */
const EXPECTED_LINES = 372;
/** Scope-match divergence factor (operational-safety-dry-run-first.mdc). */
const DIVERGENCE_FACTOR = 2;
/** Sessions scanned per keyset page. Bounded so a page's JSONB expansion stays well under the statement timeout. */
const DEFAULT_PAGE_SIZE = 150;

export interface Args {
  execute: boolean;
  afterId?: string;
  pageSize: number;
}

/**
 * Exported for test only. `--execute` is the flag standing between a dry-run and
 * a production mutation, so its parse is worth pinning rather than trusting to
 * inspection — a substring match (`argv.some(a => a.includes("--execute"))`)
 * would read `--execute-later` as consent, and nothing downstream would notice.
 */
export function parseArgs(argv: string[]): Args {
  const execute = argv.includes("--execute");
  const afterArg = argv.find((a) => a.startsWith("--after-id="));
  const afterId = afterArg ? afterArg.slice("--after-id=".length) : undefined;
  const pageArg = argv.find((a) => a.startsWith("--page-size="));
  const pageSize = pageArg ? Number(pageArg.slice("--page-size=".length)) : DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    throw new Error(`--page-size must be a positive number, got: ${pageArg}`);
  }
  return { execute, afterId, pageSize };
}

/**
 * Duck-typed persistence guard, matching `backfill-agent-transcript-turns.ts`:
 * an `instanceof` against a dynamically-imported class false-negatives under the
 * dual-package hazard, so check for the capability this script needs instead.
 */
interface SqlCapablePersistence {
  getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
}

async function bootstrapDb(): Promise<PostgresJsDatabase> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  const isSqlCapable = (p: unknown): p is SqlCapablePersistence =>
    !!p &&
    !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
    typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";

  if (!isSqlCapable(persistence)) {
    throw new Error("reparse-user-origin requires a SQL-capable persistence provider (Postgres).");
  }
  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("reparse-user-origin requires an initialized Postgres database connection.");
  }
  return connection;
}

interface PageRow {
  agent_session_id: string;
  shadowed: number;
}

/**
 * One keyset page: every session id in id order, each with its count of shadowed
 * lines (0 for unaffected).
 *
 * Counts rather than a bare EXISTS so the dry-run can report a LINE magnitude,
 * not only a session count — the scope-match check compares both, and the line
 * count is the one that maps to rows changed.
 */
async function fetchPage(
  db: PostgresJsDatabase,
  afterId: string | null,
  pageSize: number
): Promise<PageRow[]> {
  const rows = (await db.execute(sql`
    SELECT s.agent_session_id,
           (SELECT count(*)::int
              FROM jsonb_array_elements(s.transcript) e
             WHERE e->>'type' = 'user'
               AND (e->>'isMeta') = 'true'
               AND e->'origin'->>'kind' IS NOT NULL) AS shadowed
      FROM (SELECT agent_session_id, transcript
              FROM agent_transcripts
             WHERE transcript IS NOT NULL
               AND (${afterId}::text IS NULL OR agent_session_id > ${afterId})
             ORDER BY agent_session_id
             LIMIT ${pageSize}) s
     ORDER BY s.agent_session_id
  `)) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    agent_session_id: String(r.agent_session_id),
    shadowed: Number(r.shadowed ?? 0),
  }));
}

/** Load one session's raw line array for re-parse. */
async function loadTranscript(db: PostgresJsDatabase, sessionId: string): Promise<unknown> {
  const rows = (await db.execute(sql`
    SELECT transcript FROM agent_transcripts WHERE agent_session_id = ${sessionId}
  `)) as Array<Record<string, unknown>>;
  return rows?.[0]?.transcript ?? null;
}

/** `user_origin` distribution over rows carrying text — the before/after evidence. */
async function originDistribution(db: PostgresJsDatabase): Promise<Record<string, number>> {
  const rows = (await db.execute(sql`
    SELECT user_origin, count(*)::int AS n
      FROM agent_transcript_turns
     WHERE user_text IS NOT NULL
     GROUP BY user_origin
     ORDER BY n DESC
  `)) as Array<Record<string, unknown>>;
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.user_origin)] = Number(r.n ?? 0);
  return out;
}

async function main(): Promise<void> {
  const { execute, afterId, pageSize } = parseArgs(process.argv.slice(2));
  const db = await bootstrapDb();

  console.log(`reparse-user-origin ${execute ? "(EXECUTE)" : "(dry-run)"}`);
  if (afterId) console.log(`  resuming after session id: ${afterId}`);

  // Pass 1 — resolve the affected population. Always runs, in both modes: the
  // dry-run's whole job is to report it, and an execute must never act on the
  // planning-time measurement (mt#4877 SC1).
  const affected: PageRow[] = [];
  let scanned = 0;
  let cursor: string | null = afterId ?? null;
  for (;;) {
    const page = await fetchPage(db, cursor, pageSize);
    if (page.length === 0) break;
    scanned += page.length;
    for (const row of page) if (row.shadowed > 0) affected.push(row);
    const lastOfPage = page[page.length - 1];
    if (!lastOfPage) break;
    cursor = lastOfPage.agent_session_id;
    console.log(
      `  scanned ${scanned} session(s); affected so far: ${affected.length} ` +
        `(${affected.reduce((n, r) => n + r.shadowed, 0)} shadowed line(s))`
    );
  }

  const lines = affected.reduce((n, r) => n + r.shadowed, 0);
  console.log(`  affected sessions: ${affected.length} (expected ~${EXPECTED_SESSIONS})`);
  console.log(`  shadowed lines:    ${lines} (expected ~${EXPECTED_LINES})`);

  // Scope-match check (operational-safety-dry-run-first.mdc §Dry-run scope-match
  // check). Compares BOTH magnitudes: a population that drifted in sessions but
  // not lines, or the reverse, is a different operation than the one approved.
  // Skipped when resuming, where a partial population is expected by construction.
  if (!afterId) {
    const checks: Array<[string, number, number]> = [
      ["sessions", affected.length, EXPECTED_SESSIONS],
      ["lines", lines, EXPECTED_LINES],
    ];
    for (const [label, actual, expected] of checks) {
      const ratio = actual / expected;
      if (ratio > DIVERGENCE_FACTOR || ratio < 1 / DIVERGENCE_FACTOR) {
        console.error(
          `STOP: ${label} count (${actual}) diverges beyond ~${DIVERGENCE_FACTOR}x from the ` +
            `approved scope (~${expected}); re-confirm with the operator before --execute ` +
            `(operational-safety-dry-run-first.mdc scope-match gate).`
        );
        process.exit(1);
      }
    }
  }

  if (!execute) {
    console.log("  (dry-run only — re-run with --execute to apply the re-parse)");
    console.log(
      JSON.stringify({
        mode: "dry-run",
        sessionsScanned: scanned,
        affectedSessions: affected.length,
        shadowedLines: lines,
      })
    );
    process.exit(0);
  }

  const before = await originDistribution(db);
  console.log(`  user_origin BEFORE: ${JSON.stringify(before)}`);

  const { writeTurnsForTranscript } = await import("@minsky/domain/transcripts/turn-writer");

  let processed = 0;
  let errored = 0;
  let turnsWritten = 0;
  let lastId = "";
  for (const row of affected) {
    const transcript = await loadTranscript(db, row.agent_session_id);
    try {
      const result = await writeTurnsForTranscript(db, row.agent_session_id, transcript);
      processed++;
      turnsWritten += result.written;
      lastId = row.agent_session_id;
      if (result.nonEmptyYieldedZero) {
        console.warn(
          `    WARN ${row.agent_session_id}: non-empty transcript yielded zero turns — ` +
            `an extraction failure, not an empty skip.`
        );
      }
    } catch (error) {
      errored++;
      // Logged, never swallowed: a session that failed to re-parse keeps its
      // WRONG user_origin, and the run must not report success over it.
      console.error(`    ERROR ${row.agent_session_id}: ${String(error)}`);
    }
    if (processed % 25 === 0) {
      console.log(
        `    ${processed}/${affected.length} re-parsed (turnsWritten=${turnsWritten}, ` +
          `errored=${errored}, lastId=${lastId})`
      );
    }
  }

  const after = await originDistribution(db);
  console.log(`  user_origin AFTER:  ${JSON.stringify(after)}`);
  console.log(
    JSON.stringify({
      mode: "execute",
      affectedSessions: affected.length,
      processed,
      errored,
      turnsWritten,
      lastId,
      before,
      after,
    })
  );

  if (errored > 0) {
    console.error(
      `  ${errored} session(s) errored and still carry the old user_origin. ` +
        `Re-run with --after-id=<lastId> after investigating.`
    );
    process.exit(1);
  }
}

// Entry-point guard, load-bearing rather than idiomatic: `main()` opens a
// production database connection and, under `--execute`, mutates it. A bare
// top-level `await main()` would fire on IMPORT, so the unit test beside this
// file could not exist without connecting to prod.
if (import.meta.main) {
  await main();
}
