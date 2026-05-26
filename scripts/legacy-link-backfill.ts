#!/usr/bin/env bun
/**
 * Legacy link backfill script for mt#1329.
 *
 * Reads agent_transcripts rows whose `cwd` matches a Minsky session workspace
 * path, then inserts minsky_session_links rows with link_type='cwd_match'.
 *
 * This one-shot script recovers the linkage for the ~7 historical Minsky
 * sessions that had prior session_transcripts rows before the schema migration
 * in mt#1324 dropped that table. Those sessions have agent_transcripts rows
 * ingested via the mt#1351 sweep but no minsky_session_links entries.
 *
 * Matching heuristic (link_type='cwd_match', confidence=0.8):
 *   - Join agent_transcripts.cwd to the Minsky session workspace path
 *     (resolved as `<stateDir>/sessions/<minskySessionId>`).
 *   - Exact string match (normalized path).
 *   - Confidence 0.8: cwd-based matching is strong but not definitive since
 *     multiple agent sessions may have run in the same workspace.
 *
 * Acceptance criterion from spec:
 *   Non-zero minsky_session_links rows inserted for the historical sessions.
 *
 * Note: The "minsky provenance recompute produces non-null tier_rationale"
 * criterion is an integration-level check requiring live data. Document in
 * the PR body; do not verify in this script.
 *
 * Usage:
 *   bun scripts/legacy-link-backfill.ts [--dry-run]
 *
 * Flags:
 *   --dry-run    Print what would be inserted without writing to DB.
 *
 * @see mt#1329 — this file
 * @see mt#1313 — Transcript search: harness-agnostic ingestion
 * @see mt#1324 — Foundation schema migration (minsky_session_links table)
 */

import "reflect-metadata";
import { homedir } from "os";
import { join, resolve } from "path";
import { sql } from "drizzle-orm";

import { setupConfiguration } from "../src/config-setup";
await setupConfiguration();

import { PersistenceService } from "@minsky/domain/persistence/service";
import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { minskySessionLinksTable } from "@minsky/domain/storage/schemas/minsky-session-links-schema";
import { postgresSessions } from "@minsky/domain/storage/schemas/session-schema";

const isDryRun = process.argv.includes("--dry-run");

// ── Configuration ─────────────────────────────────────────────────────────────

/** Minsky state directory where session workspaces live. */
const MINSKY_STATE_DIR = join(homedir(), ".local", "state", "minsky");

/** Confidence for cwd-based matching (heuristic, not definitive). */
const CWD_MATCH_CONFIDENCE = 0.8;

const LINK_TYPE = "cwd_match";

// ── DB setup ──────────────────────────────────────────────────────────────────

const persistence = new PersistenceService();
await persistence.initialize();
const provider = persistence.getProvider();
const db = await provider.getDatabaseConnection();

if (!db) {
  console.error("ERROR: No database connection available. Check persistence configuration.");
  process.exit(1);
}

// ── Check that minsky_session_links table exists ──────────────────────────────

let tableExists = true;
try {
  await db.execute(sql`SELECT 1 FROM minsky_session_links LIMIT 1`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("does not exist") || msg.includes("no such table")) {
    tableExists = false;
    console.warn("WARNING: minsky_session_links table does not exist in the database.");
    console.warn("  Run database migrations first (bun run migrate or equivalent).");
    console.warn("  Proceeding in analysis-only mode...");
  } else {
    console.error(`ERROR: Unexpected DB error checking table: ${msg}`);
    process.exit(1);
  }
}

// ── Load agent_transcripts with cwd ──────────────────────────────────────────

console.log("Loading agent_transcripts rows with non-null cwd...");
const agentRows = await db
  .select({
    agentSessionId: agentTranscriptsTable.agentSessionId,
    cwd: agentTranscriptsTable.cwd,
    startedAt: agentTranscriptsTable.startedAt,
    harness: agentTranscriptsTable.harness,
  })
  .from(agentTranscriptsTable)
  .where(sql`${agentTranscriptsTable.cwd} IS NOT NULL`);

console.log(`Found ${agentRows.length} agent_transcripts rows with cwd.`);

if (agentRows.length === 0) {
  console.log("No agent_transcripts rows with cwd found. Nothing to backfill.");
  await provider.close();
  process.exit(0);
}

// ── Load Minsky sessions ──────────────────────────────────────────────────────

console.log("Loading Minsky sessions from sessions table...");
let minkySessions: Array<{ sessionId: string; workspacePath: string }> = [];

try {
  const sessionRows = await db
    .select({ sessionId: postgresSessions.sessionId })
    .from(postgresSessions);

  minkySessions = sessionRows.map((r) => ({
    sessionId: r.sessionId,
    workspacePath: resolve(join(MINSKY_STATE_DIR, "sessions", r.sessionId)),
  }));

  console.log(`Found ${minkySessions.length} Minsky sessions in the sessions table.`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`WARNING: Could not load Minsky sessions: ${msg}`);
  console.warn("  Falling back to filesystem enumeration from state directory...");

  // Fallback: enumerate session directories from filesystem if DB read fails.
  try {
    const { promises: fs } = await import("fs");
    const sessionsDir = join(MINSKY_STATE_DIR, "sessions");
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    minkySessions = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        sessionId: e.name,
        workspacePath: resolve(join(sessionsDir, e.name)),
      }));
    console.log(`Filesystem fallback: found ${minkySessions.length} session directories.`);
  } catch (fsErr) {
    const fsMsg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    console.error(`ERROR: Could not enumerate sessions from filesystem: ${fsMsg}`);
    await provider.close();
    process.exit(1);
  }
}

// ── Build cwd → Minsky session map ───────────────────────────────────────────

const cwdToSessions = new Map<string, string[]>();
for (const ms of minkySessions) {
  const normalizedPath = resolve(ms.workspacePath);
  const existing = cwdToSessions.get(normalizedPath) ?? [];
  existing.push(ms.sessionId);
  cwdToSessions.set(normalizedPath, existing);
}

// ── Match and collect links ───────────────────────────────────────────────────

interface LinkToInsert {
  agentSessionId: string;
  minskySessionId: string;
  confidence: number;
}

const linksToInsert: LinkToInsert[] = [];

for (const agentRow of agentRows) {
  const { agentSessionId, cwd } = agentRow;
  if (!cwd) continue;

  const normalizedCwd = resolve(cwd);
  const matchedSessions = cwdToSessions.get(normalizedCwd);

  if (!matchedSessions || matchedSessions.length === 0) {
    // No match — agent session ran in a path not corresponding to any known Minsky session.
    continue;
  }

  for (const minskySessionId of matchedSessions) {
    linksToInsert.push({
      agentSessionId,
      minskySessionId,
      confidence: CWD_MATCH_CONFIDENCE,
    });
  }
}

console.log(`\nMatching results:`);
console.log(`  Agent transcripts with cwd: ${agentRows.length}`);
console.log(`  Minsky sessions loaded: ${minkySessions.length}`);
console.log(`  Links to insert: ${linksToInsert.length}`);

if (linksToInsert.length === 0) {
  console.log("\nNo cwd matches found. This may indicate:");
  console.log("  1. Agent transcripts have cwds pointing to non-session paths.");
  console.log("  2. Minsky session workspaces no longer exist on disk.");
  console.log("  3. The sessions table is empty (try the filesystem fallback).");
  await provider.close();
  process.exit(0);
}

// ── Preview / dry-run output ──────────────────────────────────────────────────

console.log("\nLinks to insert:");
for (const link of linksToInsert) {
  console.log(
    `  ${link.agentSessionId} → Minsky session ${link.minskySessionId}` +
      ` (link_type=${LINK_TYPE}, confidence=${link.confidence})`
  );
}

if (isDryRun || !tableExists) {
  if (isDryRun) {
    console.log("\nDry-run mode: not writing to database.");
  } else {
    console.log("\nTable does not exist: cannot insert.");
  }
  console.log("Re-run without --dry-run to apply.");
  await provider.close();
  process.exit(0);
}

// ── Insert links ──────────────────────────────────────────────────────────────

console.log("\nInserting minsky_session_links rows...");
let inserted = 0;
let skipped = 0;
let errored = 0;

for (const link of linksToInsert) {
  try {
    await db
      .insert(minskySessionLinksTable)
      .values({
        agentSessionId: link.agentSessionId,
        minskySessionId: link.minskySessionId,
        linkType: LINK_TYPE,
        confidence: link.confidence,
        detectedAt: new Date(),
      })
      .onConflictDoNothing();
    inserted++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // FK violation: agent_session_id not in agent_transcripts — skip silently.
    if (msg.includes("foreign key") || msg.includes("violates")) {
      console.warn(
        `  WARN: FK violation for agent=${link.agentSessionId}, session=${link.minskySessionId}: ${msg}`
      );
      skipped++;
    } else {
      console.error(
        `  ERROR: Failed to insert link agent=${link.agentSessionId}, ` +
          `session=${link.minskySessionId}: ${msg}`
      );
      errored++;
    }
  }
}

console.log(`\nBackfill complete:`);
console.log(`  Inserted: ${inserted}`);
console.log(`  Skipped (FK/conflict): ${skipped}`);
console.log(`  Errored: ${errored}`);

if (inserted > 0) {
  console.log(`\nSuccess: ${inserted} minsky_session_links rows written.`);
  console.log(
    "Next step: run 'minsky provenance recompute' to verify tier_rationale is populated."
  );
} else {
  console.log("\nNo new rows inserted. Check the matching output above for details.");
}

await provider.close();
