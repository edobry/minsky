/**
 * Startup Transcript Ingest
 *
 * Fire-and-forget background sweep that ingests new JSONL transcript sessions
 * into `agent_transcripts` on MCP server boot. Follows the same pattern as
 * `tasks/startup-embedding-sweep.ts`.
 *
 * The ingestion is incremental (HWM-gated): already-ingested sessions are
 * no-ops at the DB layer. This achieves ≥95% coverage of recent JSONL sessions
 * without requiring manual `transcripts_ingest --all` invocations.
 *
 * DI readiness: on stdio cold start, container.initialize() runs in the
 * background. getDatabaseConnection() may return null before init completes.
 * This function retries once after a delay to coordinate with the init signal.
 *
 * @see mt#2051 — this file (indexing gap fix)
 * @see mt#1351 — AgentTranscriptIngestService
 * @see mt#1350 — ClaudeCodeTranscriptSource
 */

import { log } from "@minsky/shared/logger";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";

const INIT_RETRY_DELAY_MS = 5_000;

/**
 * Triggers a background transcript ingest sweep for all discoverable sessions.
 *
 * @param persistenceProvider - The persistence provider from the DI container.
 */
export async function triggerStartupTranscriptIngest(
  persistenceProvider: BasePersistenceProvider
): Promise<void> {
  if (!persistenceProvider.capabilities.sql) return;

  const db = await resolveDb(persistenceProvider);
  if (!db) {
    // mt#2192: surface at warn — a skipped boot sweep means NO automatic
    // ingestion ran this boot, which is an operationally interesting signal
    // (not the silent debug-only it was before).
    log.warn("Startup transcript ingest skipped: DB not available after retry");
    return;
  }

  const { ClaudeCodeTranscriptSource } = await import(
    "@minsky/domain/transcripts/claude-code-transcript-source"
  );
  const { AgentTranscriptIngestService } = await import(
    "@minsky/domain/transcripts/agent-transcript-ingest-service"
  );

  const source = new ClaudeCodeTranscriptSource();
  const svc = new AgentTranscriptIngestService(
    db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
    source
  );

  const result = await svc.ingestAll();

  // mt#2192 (SC2): make per-session ingest failures observable rather than
  // silently swallowed. Errored sessions surface at warn; a clean run with
  // new turns stays at debug.
  if (result.sessionsErrored > 0) {
    log.warn("Startup transcript ingest completed with errors", {
      totalIngested: result.totalIngested,
      sessionsProcessed: result.sessionsProcessed,
      sessionsErrored: result.sessionsErrored,
    });
  } else if (result.totalIngested > 0) {
    log.debug("Startup transcript ingest complete", {
      totalIngested: result.totalIngested,
      sessionsProcessed: result.sessionsProcessed,
      sessionsErrored: result.sessionsErrored,
    });
  }
}

async function resolveDb(provider: BasePersistenceProvider): Promise<unknown> {
  const getDb =
    "getDatabaseConnection" in provider && typeof provider.getDatabaseConnection === "function"
      ? provider.getDatabaseConnection
      : undefined;
  if (!getDb) return undefined;

  const first = await getDb.call(provider);
  if (first) return first;

  await new Promise((r) => setTimeout(r, INIT_RETRY_DELAY_MS));
  return getDb.call(provider);
}
