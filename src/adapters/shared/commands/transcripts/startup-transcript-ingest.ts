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
 * Test-only-seam guard (mt#2980 R2), same convention as
 * `src/cockpit/routes/events.ts`'s `assertTestEnv`: throws when a test-only
 * override is supplied outside `NODE_ENV=test` (set by `tests/setup.ts` for
 * every `bun test` run). This is the concrete "test-only gate" the
 * reviewer-bot requested for `initRetryDelayMs` — a caller that accidentally
 * threads a tiny override into a production path now fails loudly at call
 * time instead of silently shortening the real init-coordination delay.
 */
function assertTestEnv(seam: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(`${seam} is test-only (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`);
  }
}

/**
 * Triggers a background transcript ingest sweep for all discoverable sessions.
 *
 * @param persistenceProvider - The persistence provider from the DI container.
 * @param options.initRetryDelayMs - mt#2980: overrides `INIT_RETRY_DELAY_MS` for
 *   the single init-coordination retry in `resolveDb`. Defaults to the real
 *   5s production delay; tests inject a near-zero value to exercise the
 *   retry-once behavior without a real 5s sleep.
 *
 *   Test-only, structurally enforced: supplying `initRetryDelayMs` outside
 *   `NODE_ENV=test` throws via `assertTestEnv` (mt#2980 R2) — the guardrail
 *   the reviewer-bot requested, following the identical pattern already
 *   established in `src/cockpit/routes/events.ts`. The sole production
 *   caller (`src/commands/mcp/start-command.ts`) never passes `options`, so
 *   it is unaffected. `resolveDb` additionally clamps the value to a
 *   non-negative number as basic input validation.
 */
export async function triggerStartupTranscriptIngest(
  persistenceProvider: BasePersistenceProvider,
  options?: { initRetryDelayMs?: number }
): Promise<void> {
  if (!persistenceProvider.capabilities.sql) return;

  if (options?.initRetryDelayMs !== undefined) {
    assertTestEnv("triggerStartupTranscriptIngest({ initRetryDelayMs })");
  }

  const db = await resolveDb(persistenceProvider, options?.initRetryDelayMs);
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

async function resolveDb(
  provider: BasePersistenceProvider,
  retryDelayMs: number = INIT_RETRY_DELAY_MS
): Promise<unknown> {
  const getDb =
    "getDatabaseConnection" in provider && typeof provider.getDatabaseConnection === "function"
      ? provider.getDatabaseConnection
      : undefined;
  if (!getDb) return undefined;

  const first = await getDb.call(provider);
  if (first) return first;

  // mt#2980 R1: clamp to non-negative — a negative override (malformed input,
  // not a real usage today) must not be passed to setTimeout as a signal that
  // something is misconfigured; treat it as an immediate retry instead.
  await new Promise((r) => setTimeout(r, Math.max(0, retryDelayMs)));
  return getDb.call(provider);
}
