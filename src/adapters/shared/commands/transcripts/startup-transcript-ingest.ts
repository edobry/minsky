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
 * @see mt#2051 — this file (indexing gap fix)
 * @see mt#1351 — AgentTranscriptIngestService
 * @see mt#1350 — ClaudeCodeTranscriptSource
 */

import { log } from "../../../../utils/logger";
import type { BasePersistenceProvider } from "../../../../domain/persistence/types";

/**
 * Triggers a background transcript ingest sweep for all discoverable sessions.
 *
 * @param persistenceProvider - The persistence provider from the DI container.
 */
export async function triggerStartupTranscriptIngest(
  persistenceProvider: BasePersistenceProvider
): Promise<void> {
  if (!persistenceProvider.capabilities.sql) return;

  const getDb =
    "getDatabaseConnection" in persistenceProvider &&
    typeof persistenceProvider.getDatabaseConnection === "function"
      ? persistenceProvider.getDatabaseConnection
      : undefined;
  const db = getDb ? await getDb.call(persistenceProvider) : undefined;
  if (!db) return;

  const { ClaudeCodeTranscriptSource } = await import(
    "../../../../domain/transcripts/claude-code-transcript-source"
  );
  const { AgentTranscriptIngestService } = await import(
    "../../../../domain/transcripts/agent-transcript-ingest-service"
  );

  const source = new ClaudeCodeTranscriptSource();
  const svc = new AgentTranscriptIngestService(
    db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
    source
  );

  const result = await svc.ingestAll();

  if (result.totalIngested > 0 || result.sessionsErrored > 0) {
    log.debug("Startup transcript ingest complete", {
      totalIngested: result.totalIngested,
      sessionsProcessed: result.sessionsProcessed,
      sessionsErrored: result.sessionsErrored,
    });
  }
}
