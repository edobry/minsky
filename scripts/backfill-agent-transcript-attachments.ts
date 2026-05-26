#!/usr/bin/env bun
/**
 * mt#2022 backfill: populate `agent_transcript_attachments` for transcripts
 * already ingested before this task shipped.
 *
 * The normal ingest pipeline (`AgentTranscriptIngestService.ingestSession`)
 * uses a timestamp-based high-water-mark to skip already-seen lines. After
 * mt#2022 ships, attachments are written alongside turn rows on each new
 * ingest — but lines *before* the HWM never get re-streamed. This script
 * bypasses the HWM for attachment writes only, walking every session's JSONL
 * end-to-end and inserting any missing attachment rows. PK collisions
 * (`ON CONFLICT DO NOTHING`) make re-runs idempotent.
 *
 * Run:
 *   bun scripts/backfill-agent-transcript-attachments.ts
 *
 * Env-gated: requires the standard Minsky Postgres config to be available
 * (the script loads the canonical DB connection). Exits with a clear SKIP
 * message if the DB connection cannot be established.
 *
 * @see mt#2022 — substrate extension; this script
 */

import { eq } from "drizzle-orm";

import { ClaudeCodeTranscriptSource } from "@minsky/domain/transcripts/claude-code-transcript-source";
import {
  type AttachmentRow,
  buildAttachmentRow,
} from "@minsky/domain/transcripts/attachment-row-builder";
import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { agentTranscriptAttachmentsTable } from "@minsky/domain/storage/schemas/agent-transcript-attachments-schema";
import { log } from "../src/utils/logger";
import { getErrorMessage } from "../src/errors/index";

async function backfillSession(
  db: import("drizzle-orm/postgres-js").PostgresJsDatabase,
  source: ClaudeCodeTranscriptSource,
  agentSessionId: string
): Promise<{ inserted: number; scanned: number }> {
  // Verify the parent agent_transcripts row exists — FK requirement.
  const parent = await db
    .select({ agentSessionId: agentTranscriptsTable.agentSessionId })
    .from(agentTranscriptsTable)
    .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
    .limit(1);

  if (parent.length === 0) {
    // No parent — skip; the standard ingest pipeline will create it on its
    // next run and write attachments inline. No need to insert orphans here.
    return { inserted: 0, scanned: 0 };
  }

  const rows: AttachmentRow[] = [];
  let lineIndex = -1;
  let scanned = 0;

  for await (const line of source.readSession(agentSessionId)) {
    lineIndex++;
    scanned++;

    const tsStr = source.getJsonlTimestamp(line);
    const tsDate = tsStr ? new Date(tsStr) : null;
    const timestamp = tsDate && !isNaN(tsDate.getTime()) ? tsDate : null;

    const row = buildAttachmentRow(agentSessionId, lineIndex, line, timestamp);
    if (row !== null) rows.push(row);
  }

  if (rows.length === 0) return { inserted: 0, scanned };

  try {
    await db.insert(agentTranscriptAttachmentsTable).values(rows).onConflictDoNothing();
    return { inserted: rows.length, scanned };
  } catch (err) {
    log.warn(`Backfill insert failed for session ${agentSessionId}`, {
      error: getErrorMessage(err),
    });
    return { inserted: 0, scanned };
  }
}

async function main() {
  // Lazy-load the DB connection so the script doesn't crash at module-load
  // time when the Postgres config isn't available locally.
  let db: import("drizzle-orm/postgres-js").PostgresJsDatabase;
  try {
    // Reuse the project's canonical DB-init path. We import dynamically so
    // top-level imports don't fail in dry-run / env-missing scenarios.
    const { getDrizzleDb } = await import("@minsky/domain/storage/db");
    db = (await getDrizzleDb()) as import("drizzle-orm/postgres-js").PostgresJsDatabase;
  } catch (err) {
    console.error(
      "SKIP: failed to initialize DB connection — Postgres not available in this environment."
    );
    console.error(getErrorMessage(err));
    process.exit(0);
  }

  const source = new ClaudeCodeTranscriptSource();

  let sessionsProcessed = 0;
  let totalInserted = 0;
  let totalScanned = 0;
  let sessionsErrored = 0;

  for await (const discovered of source.discoverSessions()) {
    sessionsProcessed++;
    try {
      const result = await backfillSession(db, source, discovered.agentSessionId);
      totalInserted += result.inserted;
      totalScanned += result.scanned;
    } catch (err) {
      sessionsErrored++;
      log.warn(`Backfill failed for session ${discovered.agentSessionId}`, {
        error: getErrorMessage(err),
      });
    }
  }

  console.log("Backfill complete:");
  console.log(`  sessions processed: ${sessionsProcessed}`);
  console.log(`  sessions errored:   ${sessionsErrored}`);
  console.log(`  lines scanned:      ${totalScanned}`);
  console.log(`  rows inserted:      ${totalInserted}`);
  process.exit(sessionsErrored > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Backfill crashed:", getErrorMessage(err));
    process.exit(1);
  });
}
