#!/usr/bin/env bun
/**
 * Export a Gource custom-log for a real ingested agent session (mt#3157
 * Phase 0 — the watchable-world program's affect probe).
 *
 * Thin CLI over `packages/domain/src/transcripts/event-adapter.ts` +
 * `gource-exporter.ts`: fetches a transcript via the `getTranscript` service
 * seam, resolves this session's user-turn actor (principal, or the parent
 * agent if this transcript is a spawned child — `agent_spawns`), adapts it to
 * a `SemanticEvent[]`, and exports the Gource custom log (scrub-gated).
 *
 * ## Usage
 *
 *   # Export one session by its harness conversation id:
 *   bun scripts/export-gource-log.ts <conversationId> [--out <path>] [--verified-rescrubbed]
 *
 *   # Report the adapter's tool-name coverage metric over the N most
 *   # recently ingested sessions (mt#3157 AT5):
 *   bun scripts/export-gource-log.ts --coverage [--limit N]
 *
 * ## Render the exported log
 *
 *   gource --log-format custom session.gource.log
 *
 * Env-gated like the other DB-backed scripts in this directory (see
 * `verify-driven-link-writer.ts`): SKIPs cleanly (exit 0) when Postgres is
 * unavailable rather than failing loudly in an environment with no DB.
 *
 * @see packages/domain/src/transcripts/event-adapter.ts
 * @see packages/domain/src/transcripts/gource-exporter.ts
 * @see mt#3157 — this task
 */

import "reflect-metadata";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ConversationId } from "@minsky/domain/ids";
import {
  adaptTranscriptToEvents,
  computeAdapterCoverage,
  extractLeadingUserTexts,
  type AdapterContext,
} from "@minsky/domain/transcripts/event-adapter";
import { exportGourceLog } from "@minsky/domain/transcripts/gource-exporter";
import type { EventActor } from "@minsky/domain/transcripts/event-schema";
import {
  computeConversationLabel,
  pickSubstantiveUserText,
} from "@minsky/domain/transcripts/conversation-label";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

async function getDb(): Promise<PostgresJsDatabase | null> {
  try {
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "@minsky/domain/configuration"
    );
    const { createCliContainer } = await import("../src/composition/cli");
    const { PersistenceProvider } = await import("@minsky/domain/persistence/types");

    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
    });

    const container = await createCliContainer();
    await container.initialize();

    const persistence = container.has("persistence") ? container.get("persistence") : undefined;
    if (!persistence || !(persistence instanceof PersistenceProvider)) return null;
    if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
      return null;
    }

    const connection = await persistence.getDatabaseConnection();
    return (connection as PostgresJsDatabase) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the actor to attribute this transcript's USER-role turns to
 * (RFC Amendment 2): the parent agent when this transcript is linked as a
 * spawn child via `agent_spawns`, else the human principal.
 */
async function resolveUserTurnActor(
  db: PostgresJsDatabase,
  conversationId: string
): Promise<EventActor> {
  const { agentSpawnsTable } = await import("@minsky/domain/storage/schemas/agent-spawns-schema");
  const { eq } = await import("drizzle-orm");

  const rows = await db
    .select({ parentAgentSessionId: agentSpawnsTable.parentAgentSessionId })
    .from(agentSpawnsTable)
    .where(eq(agentSpawnsTable.childAgentSessionId, conversationId))
    .limit(1);

  const parent = rows[0]?.parentAgentSessionId;
  return parent ? { kind: "agent", agentSessionId: parent } : { kind: "principal" };
}

async function exportSession(
  db: PostgresJsDatabase,
  conversationId: string,
  outPath: string | undefined,
  verifiedRescrubbed: boolean
): Promise<void> {
  const { AgentTranscriptService } = await import("@minsky/domain/provenance/transcript-service");
  const { agentTranscriptsTable } = await import(
    "@minsky/domain/storage/schemas/agent-transcripts-schema"
  );
  const { eq } = await import("drizzle-orm");

  const service = new AgentTranscriptService(db);
  const transcript = await service.getTranscript(conversationId as ConversationId);
  if (!transcript) {
    console.error(`No stored transcript for conversation ${conversationId}`);
    process.exit(1);
  }

  const rows = await db
    .select({
      ingestedAt: agentTranscriptsTable.ingestedAt,
      cwd: agentTranscriptsTable.cwd,
      startedAt: agentTranscriptsTable.startedAt,
    })
    .from(agentTranscriptsTable)
    .where(eq(agentTranscriptsTable.agentSessionId, conversationId as never))
    .limit(1);
  const row = rows[0];
  const ingestedAt = row?.ingestedAt ?? null;

  // Readable Gource actor label (cheap tiers only — no extra query beyond
  // what's already fetched above/loaded into `transcript`): a bound-task
  // title (tier 1) is NOT cheaply available here (would need an extra
  // minsky_session_links/tasks join), so this resolves tiers 2 (first
  // substantive user prompt) and 4 (timestamp-cwd-short-id fallback) of
  // mt#2770's precedence. A bare conversation UUID is unreadable as a
  // rendered Gource avatar name (the concrete complaint this fixes).
  const agentDisplayLabel = computeConversationLabel({
    agentSessionId: conversationId,
    cwd: row?.cwd ?? null,
    startedAt: row?.startedAt ?? null,
    linkedTaskTitle: null,
    firstUserText: pickSubstantiveUserText(extractLeadingUserTexts(transcript)),
    subagentDescriptor: null,
  });

  const userTurnActor = await resolveUserTurnActor(db, conversationId);
  const context: AdapterContext = {
    agentSessionId: conversationId,
    userTurnActor,
    agentDisplayLabel,
  };
  const events = adaptTranscriptToEvents(transcript, context);
  const log = exportGourceLog(events, { ingestedAt, verifiedRescrubbed });

  const lineCount = log.split("\n").filter((l) => l.length > 0).length;
  if (outPath) {
    await Bun.write(outPath, log);
    console.error(`Wrote ${lineCount} Gource log lines to ${outPath}`);
  } else {
    process.stdout.write(log);
    console.error(`(${lineCount} Gource log lines written to stdout)`);
  }
}

async function reportCoverage(db: PostgresJsDatabase, limit: number): Promise<void> {
  const { AgentTranscriptService } = await import("@minsky/domain/provenance/transcript-service");
  const { agentTranscriptsTable } = await import(
    "@minsky/domain/storage/schemas/agent-transcripts-schema"
  );
  const { desc } = await import("drizzle-orm");

  const rows = await db
    .select({ agentSessionId: agentTranscriptsTable.agentSessionId })
    .from(agentTranscriptsTable)
    .orderBy(desc(agentTranscriptsTable.startedAt))
    .limit(limit);

  const service = new AgentTranscriptService(db);
  let total = 0;
  let nonFallback = 0;
  let sessionsScanned = 0;

  for (const row of rows) {
    const transcript = await service.getTranscript(row.agentSessionId as ConversationId);
    if (!transcript) continue;
    sessionsScanned++;
    const userTurnActor = await resolveUserTurnActor(db, row.agentSessionId);
    const events = adaptTranscriptToEvents(transcript, {
      agentSessionId: row.agentSessionId,
      userTurnActor,
    });
    const coverage = computeAdapterCoverage(events);
    total += coverage.totalToolEvents;
    nonFallback += coverage.nonFallbackToolEvents;
  }

  const coverage = total === 0 ? 1 : nonFallback / total;
  console.log(
    JSON.stringify(
      {
        sessionsRequested: rows.length,
        sessionsScanned,
        totalToolEvents: total,
        nonFallbackToolEvents: nonFallback,
        coverage,
      },
      null,
      2
    )
  );
}

const HELP_TEXT = `
export-gource-log.ts — export a Gource custom-log for an ingested agent session (mt#3157)

What it does:
  Fetches a session's transcript via the getTranscript() service seam, adapts it to
  a SemanticEvent[] stream (packages/domain/src/transcripts/event-adapter.ts), and
  serializes the path-bearing events to Gource's custom log format
  (packages/domain/src/transcripts/gource-exporter.ts).

Usage:
  bun scripts/export-gource-log.ts <conversationId> [--out <path>] [--verified-rescrubbed]
  bun scripts/export-gource-log.ts --coverage [--limit N]
  bun scripts/export-gource-log.ts --help

Options:
  <conversationId>       Harness conversation id (agent_transcripts.agent_session_id).
  --out <path>           Write the log to <path> instead of stdout.
  --verified-rescrubbed  Bypass the credential-scrub-cutoff gate (see below) after
                          confirming this specific session was re-scrubbed.
  --coverage             Report the adapter's tool-name coverage metric (mapped vs.
                          fallback verb) over the N most-recently-ingested sessions.
  --limit N              Session count for --coverage (default 50).

Credential-scrub gate:
  Export refuses a session ingested before 2026-07-18 (the mt#2864 sweep's confirmed
  residue=0 date) unless --verified-rescrubbed is passed. See
  gource-exporter.ts's CREDENTIAL_SCRUB_CUTOFF_ISO / assertScrubGate for the full
  rationale (conservative ingestion-date cutoff — no per-row scrub flag exists).

Viewing the exported log:
  gource --log-format custom session.gource.log
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }

  const db = await getDb();
  if (!db) {
    console.error("SKIP: no Postgres connection available in this environment.");
    process.exit(0);
  }

  if (args[0] === "--coverage") {
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 50;
    await reportCoverage(db, limit);
    return;
  }

  const conversationId = args[0];
  if (!conversationId) {
    console.error(HELP_TEXT);
    process.exit(1);
  }

  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const verifiedRescrubbed = args.includes("--verified-rescrubbed");

  await exportSession(db, conversationId, outPath, verifiedRescrubbed);
}

if (import.meta.main) {
  main()
    .then(() => {
      // Force a clean exit — the postgres-js pool otherwise keeps an open
      // handle alive and the process hangs after work is already done.
      process.exit(0);
    })
    .catch((err) => {
      console.error(getLoggableErrorSummary(err));
      process.exit(1);
    });
}
