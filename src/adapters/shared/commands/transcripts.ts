/**
 * Transcript Commands
 *
 * Exposes the AgentTranscriptIngestService as a shared command (MCP + CLI).
 *
 * `transcripts.ingest` — sweep all sessions or target a single session.
 *
 * DI pattern mirrors `provenance.ts` / `authorship.ts`: the persistence
 * provider is resolved from `context.container` at execute time (not at
 * registration time).
 *
 * @see mt#1351 — AgentTranscriptIngestService + ingest MCP tool/CLI
 * @see mt#1313 — parent: transcript search
 * @see mt#1350 — TranscriptSource adapter (ClaudeCodeTranscriptSource)
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import type { SharedCommandRegistry } from "../command-registry";
import { log } from "@minsky/shared/logger";
// mt#2741: migrate transcripts_ingest onto the family's canonical conversationId
// key (mt#2526 / ADR-022), keeping `session` as a deprecated back-compat alias —
// matching the other 6 transcripts_* commands.
import {
  conversationIdParam,
  deprecatedConversationAlias,
  resolveConversationId,
} from "./transcripts/conversation-id-param";
import { getErrorMessage } from "@minsky/domain/errors/index";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { registerTranscriptIndexEmbeddingsCommand } from "./transcripts/index-embeddings-command";
import { registerTranscriptSearchCommand } from "./transcripts/search-command";
import { registerTranscriptSimilarCommand } from "./transcripts/similar-command";
import { registerTranscriptSpawnsExtractCommand } from "./transcripts/spawns-extract-command";
import { registerTranscriptSearchTextCommand } from "./transcripts/search-text-command";
import { registerTranscriptGetCommand } from "./transcripts/get-command";

/**
 * Result returned by `transcripts.ingest`.
 */
export interface TranscriptIngestResult {
  totalIngested: number;
  sessionsProcessed: number;
  sessionsErrored: number;
  harness: string;
}

/**
 * Register all transcript-related shared commands.
 *
 * @param _container Optional DI container (unused at registration; resolved at execute time)
 * @param registry   Optional registry — defaults to global `sharedCommandRegistry`.
 *                   Pass a fresh registry in tests to avoid global state mutation.
 */
export function registerTranscriptCommands(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  // ── transcripts.ingest ────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "transcripts.ingest",
    category: CommandCategory.TRANSCRIPTS,
    name: "ingest",
    description:
      "Ingest agent conversation transcripts into the agent_transcripts table. " +
      "Pass --all to sweep every discoverable conversation, or --conversationId=<uuid> to " +
      "target one (the legacy --session alias is also accepted). " +
      "Incremental by timestamp: re-runs are no-ops when the JSONL is unchanged.",
    parameters: {
      all: {
        schema: z.boolean(),
        description: "Sweep and ingest all discoverable conversations",
        required: false,
        defaultValue: false,
      },
      conversationId: conversationIdParam("Ingest a single conversation by its agent session UUID"),
      session: deprecatedConversationAlias("session"),
      harness: {
        schema: z.string(),
        description: "Source harness label (default: claude_code)",
        required: false,
        defaultValue: "claude_code",
      },
    },
    async execute(params, context): Promise<TranscriptIngestResult> {
      const doAll = (params.all as boolean | undefined) ?? false;
      const sessionId = resolveConversationId(params);
      const harness = (params.harness as string | undefined) ?? "claude_code";

      if (!doAll && !sessionId) {
        throw new Error(
          "transcripts.ingest requires either --all or --conversationId=<uuid> " +
            "(the `session` alias is also accepted). Pass --all to sweep every discoverable conversation."
        );
      }

      // ── Resolve persistence provider from DI container ──────────────────
      const persistenceProvider = (() => {
        if (context.container?.has("persistence")) {
          return context.container.get(
            "persistence"
          ) as import("@minsky/domain/persistence/types").SqlCapablePersistenceProvider;
        }
        return null;
      })();

      if (!persistenceProvider) {
        throw new Error(
          "DI container missing 'persistence'. " +
            "Ensure the container was initialized before running this command."
        );
      }

      const db = await persistenceProvider.getDatabaseConnection();
      if (!db) {
        throw new Error(
          "getDatabaseConnection() returned null. " +
            "transcripts.ingest requires a PostgreSQL backend with Drizzle ORM."
        );
      }

      // ── Build TranscriptSource ───────────────────────────────────────────
      const { ClaudeCodeTranscriptSource } = await import(
        "@minsky/domain/transcripts/claude-code-transcript-source"
      );
      const source = new ClaudeCodeTranscriptSource();

      const { AgentTranscriptIngestService } = await import(
        "@minsky/domain/transcripts/agent-transcript-ingest-service"
      );
      const svc = new AgentTranscriptIngestService(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
        source
      );

      // ── Execute ingest ───────────────────────────────────────────────────
      if (doAll) {
        try {
          const result = await svc.ingestAll();
          log.info("transcripts.ingest --all complete", { ...result });
          return { ...result, harness };
        } catch (err) {
          log.error("transcripts.ingest --all failed", { error: getErrorMessage(err) });
          throw err;
        }
      }

      // Single-session mode.
      // Locate the session in discovered sessions to get full DiscoveredSession metadata.
      let found: import("@minsky/domain/transcripts/transcript-source").DiscoveredSession | null =
        null;
      for await (const sess of source.discoverSessions()) {
        if (sess.agentSessionId === sessionId) {
          found = sess;
          break;
        }
      }

      if (!found) {
        throw new Error(
          `Session '${sessionId}' not found in source '${harness}'. ` +
            "Pass --all to sweep all sessions."
        );
      }

      try {
        const result = await svc.ingestSession(found);
        log.info(`transcripts.ingest --session=${sessionId} complete`, {
          ingested: result.ingested,
          harness,
          ...(result.error ? { swallowedError: getErrorMessage(result.error) } : {}),
        });
        return {
          totalIngested: result.ingested,
          sessionsProcessed: 1,
          // mt#1444: ingestSession returns a typed result so degraded paths
          // (HWM read / stream / upsert failure) surface here instead of
          // silently reporting 0.
          sessionsErrored: result.error ? 1 : 0,
          harness,
        };
      } catch (err) {
        log.error(`transcripts.ingest --session=${sessionId} failed`, {
          error: getErrorMessage(err),
        });
        throw err;
      }
    },
  });

  log.debug("Transcript commands registered");

  // ── transcripts.index-embeddings ─────────────────────────────────────────
  registerTranscriptIndexEmbeddingsCommand(_container, targetRegistry);

  // ── transcripts.search ───────────────────────────────────────────────────
  registerTranscriptSearchCommand(_container, targetRegistry);

  // ── transcripts.similar ──────────────────────────────────────────────────
  registerTranscriptSimilarCommand(_container, targetRegistry);

  // ── transcripts.spawns-extract ───────────────────────────────────────────
  registerTranscriptSpawnsExtractCommand(_container, targetRegistry);

  // ── transcripts.search-text ──────────────────────────────────────────────
  registerTranscriptSearchTextCommand(_container, targetRegistry);

  // ── transcripts.get ──────────────────────────────────────────────────────
  registerTranscriptGetCommand(_container, targetRegistry);
}
