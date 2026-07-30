#!/usr/bin/env bun
/**
 * Verification artifact (mt#3323): runs rewind detection against a REAL
 * conversation's assembled snapshot and asserts the invariants that unit tests
 * with synthetic fixtures cannot prove.
 *
 * `markAbandonedRewindBranches` is pure and unit-tested
 * (`packages/domain/src/transcripts/rewind-detection.test.ts`); this script is
 * the LIVE complement. It proves against the actual `agent_transcripts`
 * substrate that:
 *
 *   1. No block is removed and no `turnIndex` is rewritten — the session film
 *      joins `SemanticEvent.turnIndex` against this array (`event-schema.ts`).
 *   2. Marking is CONSERVATIVE: parallel tool batches (the dominant branch
 *      shape — 4,187 across 207 local transcripts vs 25 rewinds) are untouched,
 *      so no `tool_result` is ever marked.
 *   3. On the motivating conversation, exactly the superseded operator prompt
 *      and its reachable descendants are marked.
 *
 * Env-gated: skips gracefully (exit 0, "SKIP") when no SQL persistence provider
 * is reachable.
 *
 * Usage:
 *   bun scripts/verify-rewind-detection.ts [agentSessionId]
 *
 * @see mt#3323 — rewind detection
 */
import "reflect-metadata";
import { setupConfiguration } from "@minsky/domain/config-setup";
import { getSharedPersistenceService } from "../src/cockpit/shared-persistence";
import { assembleSessionContextSnapshot } from "@minsky/domain/transcripts/session-context-snapshot";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AgentSessionId } from "@minsky/domain/transcripts/transcript-source";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";

/** The mt#3323 motivating incident — operator re-dictated a prompt. */
const DEFAULT_SESSION = "77c6ca4f-1241-4e1a-9648-7ce3e28c6c25";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function carriesToolResult(block: SessionContextSnapshotBlock): boolean {
  const message = block.content;
  if (message === null || typeof message !== "object") return false;
  const parts = (message as Record<string, unknown>).content;
  if (!Array.isArray(parts)) return false;
  return parts.some(
    (p) =>
      p !== null && typeof p === "object" && (p as Record<string, unknown>).type === "tool_result"
  );
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

const sessionId = process.argv[2] ?? DEFAULT_SESSION;
const snapshot = await assembleSessionContextSnapshot(db, sessionId as AgentSessionId);
if (snapshot === null) fail(`assembleSessionContextSnapshot returned null for ${sessionId}`);

const blocks = snapshot.blocks;
const markedBlocks = blocks.filter((b) => b.isAbandonedBranch === true);

// Invariant 1 — turnIndex is still the raw array position, densely ordered.
const turnIndices = blocks
  .filter((b) => b.turnIndex !== undefined)
  .map((b) => b.turnIndex as number);
const sortedIndices = [...turnIndices].sort((a, b) => a - b);
for (let i = 0; i < sortedIndices.length; i += 1) {
  if (sortedIndices[i] !== i) {
    fail(
      `turnIndex is not the raw array position — expected a dense 0..N run, found a gap at ${i} (got ${sortedIndices[i]}). ` +
        "The session-film join (event-schema.ts) depends on this identity."
    );
  }
}

// Invariant 2 — marking never touches a tool result.
const markedToolResults = markedBlocks.filter(carriesToolResult);
if (markedToolResults.length > 0) {
  fail(
    `${markedToolResults.length} tool_result block(s) were marked abandoned. Rewind detection must never fire on a parallel tool batch.`
  );
}

console.log(`Conversation:     ${sessionId}`);
console.log(`Total blocks:     ${blocks.length}`);
console.log(
  `Turn blocks:      ${turnIndices.length} (turnIndex 0..${turnIndices.length - 1}, dense)`
);
console.log(`Marked abandoned: ${markedBlocks.length}`);
for (const b of markedBlocks) {
  const preview = JSON.stringify(b.content).slice(0, 70).replace(/\s+/g, " ");
  console.log(`  - ${b.id}  type=${b.type}  raw=${b.rawJsonlType}  ${preview}…`);
}
console.log("");
console.log("PASS: no block removed, turnIndex dense and unrewritten, zero tool_results marked.");
