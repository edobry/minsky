#!/usr/bin/env bun
/**
 * Verification artifact (mt#2374): runs the conversation-element parser against
 * a REAL local session's assembled snapshot and asserts the renderer's
 * acceptance criteria are satisfiable end-to-end — chronological turns, role
 * distinction, tool-call surfacing, and the spawn-boundary affordance.
 *
 * The parser (`snapshotBlocksToConversation`) is pure and fully unit-tested
 * (`packages/domain/src/transcripts/conversation-elements.test.ts`); this script
 * is the LIVE complement — it proves the parser produces the expected element
 * mix against the actual `agent_transcripts` substrate, which a unit test with
 * synthetic fixtures cannot.
 *
 * Env-gated: skips gracefully (exit 0, "SKIP") when no SQL persistence provider
 * is reachable. Pass a session id as argv[2] to target a specific session;
 * otherwise it picks the session with the most spawn-boundary turns.
 *
 * Usage:
 *   bun scripts/verify-conversation-renderer.ts [agentSessionId]
 *
 * @see mt#2374 — conversation renderer
 */
import "reflect-metadata";
import { setupConfiguration } from "@minsky/domain/config-setup";
import { getSharedPersistenceService } from "../src/cockpit/shared-persistence";
import { assembleSessionContextSnapshot } from "@minsky/domain/transcripts/session-context-snapshot";
import { snapshotBlocksToConversation } from "@minsky/domain/transcripts/conversation-elements";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

await setupConfiguration();

let db: PostgresJsDatabase | null = null;
try {
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider() as {
    getDatabaseConnection?: () => Promise<PostgresJsDatabase>;
  };
  if (typeof provider.getDatabaseConnection !== "function") {
    console.log("SKIP: persistence provider is not SQL-backed; nothing to verify.");
    process.exit(0);
  }
  db = await provider.getDatabaseConnection();
} catch (err) {
  console.log(`SKIP: could not reach a SQL persistence provider (${String(err)}).`);
  process.exit(0);
}
if (db === null) {
  console.log("SKIP: no SQL persistence provider resolved.");
  process.exit(0);
}

// Resolve a target session: argv override, else the session with the most spawns.
let sessionId = process.argv[2];
if (!sessionId) {
  const rowsRes = await db.execute(
    sql`SELECT agent_session_id
        FROM agent_transcript_turns
        GROUP BY agent_session_id
        HAVING count(*) FILTER (WHERE is_spawn_boundary) > 0
        ORDER BY count(*) DESC
        LIMIT 1`
  );
  type SidRow = { agent_session_id?: string };
  // postgres-js drizzle returns an array-like RowList; node-postgres wraps in { rows }.
  // Distinguish "query ran, shape unrecognized" (FAIL — never silently skip a
  // verification) from "query ran, zero matching sessions" (legit SKIP below).
  let rows: SidRow[];
  if (Array.isArray(rowsRes)) {
    rows = rowsRes as SidRow[];
  } else if (
    rowsRes !== null &&
    typeof rowsRes === "object" &&
    Array.isArray((rowsRes as { rows?: unknown }).rows)
  ) {
    rows = (rowsRes as { rows: SidRow[] }).rows;
  } else {
    fail(`unrecognized drizzle result shape (${typeof rowsRes}); cannot resolve a session`);
  }
  sessionId = rows[0]?.agent_session_id;
}
if (!sessionId) {
  console.log("SKIP: no ingested session with spawn-boundary turns found locally.");
  process.exit(0);
}

console.log(`Verifying conversation render for session ${sessionId}`);

const snapshot = await assembleSessionContextSnapshot(db, sessionId);
if (snapshot === null) fail(`assembleSessionContextSnapshot returned null for ${sessionId}`);

const turns = snapshotBlocksToConversation(snapshot.blocks);

// Tally the element mix.
let textCount = 0;
let thinkingCount = 0;
let toolCallCount = 0;
let toolResultCount = 0;
let spawnTurns = 0;
const agentKinds = new Set<string>();
for (const turn of turns) {
  if (turn.isSpawnBoundary) {
    spawnTurns++;
    if (turn.spawnAgentKind) agentKinds.add(turn.spawnAgentKind);
  }
  for (const el of turn.elements) {
    if (el.kind === "text") textCount++;
    else if (el.kind === "thinking") thinkingCount++;
    else if (el.kind === "tool-call") toolCallCount++;
    else if (el.kind === "tool-result") toolResultCount++;
  }
}

// Chronological order check (timestamps non-decreasing).
let ordered = true;
for (let i = 1; i < turns.length; i++) {
  if (turns[i].timestamp < turns[i - 1].timestamp) {
    ordered = false;
    break;
  }
}

const roles = new Set(turns.map((t) => t.role));

console.log(
  JSON.stringify(
    {
      sessionId,
      turns: turns.length,
      roles: [...roles],
      textCount,
      thinkingCount,
      toolCallCount,
      toolResultCount,
      spawnTurns,
      agentKinds: [...agentKinds],
      chronological: ordered,
    },
    null,
    2
  )
);

// Acceptance assertions.
if (turns.length === 0) fail("no conversational turns produced");
if (!ordered) fail("turns are not in chronological order");
if (!roles.has("user") || !roles.has("assistant")) fail("missing user or assistant roles");
if (toolCallCount === 0) fail("no tool calls surfaced (tool-call resolution failed)");
if (toolResultCount === 0) fail("no tool results surfaced");
if (spawnTurns === 0)
  fail("no spawn-boundary affordance produced for a session known to have spawns");

console.log("\nPASS: conversation render satisfies acceptance criteria.");
process.exit(0);
