#!/usr/bin/env bun
/**
 * mt#3482 §7a verification artifact — a conversation's FIRST ingest, with
 * attachments, against a REAL Postgres.
 *
 * This exercises the whole write path end to end rather than a slice of it:
 * a synthetic Claude Code JSONL (one user line + one attachment line) is
 * discovered by the real `ClaudeCodeTranscriptSource`, ingested by the real
 * `AgentTranscriptIngestService`, and the resulting rows are read back. It is
 * the acceptance test the unit and integration suites approximate — the unit
 * suite's fake DB cannot enforce the foreign key, and the integration suite
 * exercises the constraint without going through the ingest.
 *
 * Pre-fix this fails: the attachment insert runs before any `agent_transcripts`
 * row exists, so Postgres rejects it with 23503 and the ingest aborts with
 * `ingested: 0` and a recorded failure.
 *
 * Usage — needs a Postgres with this repo's schema applied:
 *
 *   createdb minsky_scratch
 *   MINSKY_PERSISTENCE_BACKEND=postgres \
 *     MINSKY_POSTGRES_URL=postgres://<user>@127.0.0.1:5432/minsky_scratch \
 *     bun src/cli.ts persistence migrate --execute
 *   VERIFY_POSTGRES_URL=postgres://<user>@127.0.0.1:5432/minsky_scratch \
 *     bun scripts/verify-transcript-attachment-ingest.ts
 *
 * Exits 0 on pass, 1 on fail, and 0 with a SKIP line when
 * `VERIFY_POSTGRES_URL` is absent — safe to run unattended.
 *
 * @see mt#3482 — the fix this verifies
 * @see mt#3278 — why attachments are written before the transcript upsert
 */
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { agentTranscriptAttachmentsTable } from "@minsky/domain/storage/schemas/agent-transcript-attachments-schema";
import { AgentTranscriptIngestService } from "@minsky/domain/transcripts/agent-transcript-ingest-service";
import { ClaudeCodeTranscriptSource } from "@minsky/domain/transcripts/claude-code-transcript-source";
import type { ConversationId } from "@minsky/domain/ids";

const url = process.env.VERIFY_POSTGRES_URL;
if (!url) {
  console.log("SKIP: VERIFY_POSTGRES_URL not set");
  process.exit(0);
}

const conversationId = `mt3482-verify-${process.pid}-${Date.now()}` as ConversationId;
const client = postgres(url, { max: 2 });
const db = drizzle(client);

/** A minimal Claude Code JSONL: one retained turn, one attachment line. */
const LINES = [
  {
    type: "user",
    uuid: "verify-user-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "hello" },
  },
  {
    type: "attachment",
    uuid: "verify-attachment-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    parentUuid: "verify-user-1",
    attachment: { type: "hook_additional_context", content: "injected context" },
  },
];

let projectsDir: string | undefined;
let failed = false;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failed = true;
}

try {
  projectsDir = await mkdtemp(join(tmpdir(), "mt3482-projects-"));
  const projectDir = join(projectsDir, "-tmp-mt3482-verify");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, `${conversationId}.jsonl`),
    `${LINES.map((l) => JSON.stringify(l)).join("\n")}\n`
  );

  const source = new ClaudeCodeTranscriptSource({ claudeProjectsDir: projectsDir });
  const discovered = await source.locateSession(conversationId);
  if (!discovered) {
    console.log(`FAIL  discovery — ${conversationId} not found under ${projectsDir}`);
    process.exit(1);
  }

  const service = new AgentTranscriptIngestService(db, source);
  const result = await service.ingestSession(discovered);

  check(
    "ingest completes without error",
    result.error === undefined,
    result.error ? String(result.error.message).slice(0, 160) : "no error"
  );
  check("turns ingested", result.ingested > 0, `ingested=${result.ingested}`);

  const transcriptRows = await db
    .select({
      harness: agentTranscriptsTable.harness,
      ingestFailureCount: agentTranscriptsTable.ingestFailureCount,
      lastIngestedJsonlTimestamp: agentTranscriptsTable.lastIngestedJsonlTimestamp,
    })
    .from(agentTranscriptsTable)
    .where(eq(agentTranscriptsTable.agentSessionId, conversationId))
    .limit(1);

  check("transcript row written", transcriptRows.length === 1, `rows=${transcriptRows.length}`);
  check(
    "harness is real, not the 'unknown' failure placeholder",
    transcriptRows[0]?.harness === "claude_code",
    `harness=${transcriptRows[0]?.harness}`
  );
  check(
    "no failure recorded (quarantine budget untouched)",
    transcriptRows[0]?.ingestFailureCount === 0,
    `ingest_failure_count=${transcriptRows[0]?.ingestFailureCount}`
  );
  check(
    "high-water mark advanced by the upsert",
    transcriptRows[0]?.lastIngestedJsonlTimestamp !== null,
    `last_ingested_jsonl_timestamp=${transcriptRows[0]?.lastIngestedJsonlTimestamp?.toISOString()}`
  );

  const attachmentRows = await db
    .select({ attachmentType: agentTranscriptAttachmentsTable.attachmentType })
    .from(agentTranscriptAttachmentsTable)
    .where(eq(agentTranscriptAttachmentsTable.agentSessionId, conversationId));

  check(
    "attachment row written",
    attachmentRows.length === 1,
    `rows=${attachmentRows.length}, type=${attachmentRows[0]?.attachmentType}`
  );
} finally {
  // Children first: five tables carry an FK to agent_transcripts, and a full
  // ingest writes turns / spawns / tool-call projections as well as the
  // attachment row this script is about. Deleting the parent first fails with
  // 23503 — the same class of constraint error the fix under test is about.
  // Raw SQL keeps this list in one place without importing five schemas.
  await client`DELETE FROM agent_transcript_attachments WHERE agent_session_id = ${conversationId}`;
  await client`DELETE FROM agent_transcript_turns WHERE agent_session_id = ${conversationId}`;
  await client`DELETE FROM agent_tool_call_projection WHERE agent_session_id = ${conversationId}`;
  // agent_spawns references the parent on TWO columns, neither named
  // `agent_session_id`.
  await client`DELETE FROM agent_spawns WHERE parent_agent_session_id = ${conversationId} OR child_agent_session_id = ${conversationId}`;
  await client`DELETE FROM minsky_session_links WHERE agent_session_id = ${conversationId}`;
  await client`DELETE FROM agent_transcripts WHERE agent_session_id = ${conversationId}`;
  await client.end({ timeout: 5 });
  if (projectsDir) await rm(projectsDir, { recursive: true, force: true });
}

console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(failed ? 1 : 0);
