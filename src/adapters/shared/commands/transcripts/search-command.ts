/**
 * Transcript Search Command
 *
 * Registers the `transcripts.search` MCP tool and
 * `minsky transcripts search` CLI command.
 *
 * Embeds the query text and returns nearest-neighbor turns from
 * agent_transcript_turns by cosine distance (pgvector <=> operator).
 *
 * Args:
 *   query          Required. The natural-language search query.
 *   limit          Optional. Max results to return (default 10).
 *   role           Optional. Filter to 'user' or 'assistant' turns.
 *   from           Optional. ISO date string — filter sessions started after this date.
 *   to             Optional. ISO date string — filter sessions started before this date.
 *   session        Optional. Restrict results to a single agent session UUID.
 *
 * DI pattern mirrors index-embeddings-command.ts: persistence provider
 * resolved from `context.container` at execute time.
 *
 * @see mt#1354 — this file
 * @see mt#1352 — PerTurnEmbeddingPipeline (populates turn embeddings)
 * @see mt#1313 §Search tools — transcripts.search
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import type { SharedCommandRegistry } from "../../command-registry";
import { log } from "@minsky/shared/logger";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { TranscriptTurnResult } from "@minsky/domain/transcripts/transcript-similarity-service";

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the `transcripts.search` shared command.
 *
 * @param _container Optional DI container (resolved at execute time).
 * @param registry   Defaults to global sharedCommandRegistry. Pass a fresh
 *                   registry in tests to avoid global state mutation.
 */
export function registerTranscriptSearchCommand(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  targetRegistry.registerCommand({
    id: "transcripts.search",
    category: CommandCategory.TRANSCRIPTS,
    name: "search",
    description:
      "Search agent transcript turns by semantic similarity. " +
      "Embeds the query text and returns the nearest-neighbor turns " +
      "ranked by cosine distance (pgvector). " +
      "Optionally filter by role (user/assistant), date range, or session UUID. " +
      "Coverage: sessions are auto-ingested on MCP server boot; " +
      "if a session is missing, run `transcripts_ingest --all` to force a full sweep.",
    parameters: {
      query: {
        schema: z.string(),
        description: "Natural-language search query to embed and match against transcript turns",
        required: true,
      },
      limit: {
        schema: z.number().int().positive(),
        description: "Maximum number of results to return (default 10)",
        required: false,
        defaultValue: 10,
      },
      role: {
        schema: z.enum(["user", "assistant"]),
        description: "Filter to turns by role: 'user' or 'assistant'",
        required: false,
      },
      from: {
        schema: z.string(),
        description: "ISO date string — include only turns from sessions started after this date",
        required: false,
      },
      to: {
        schema: z.string(),
        description: "ISO date string — include only turns from sessions started before this date",
        required: false,
      },
      session: {
        schema: z.string(),
        description: "Restrict results to a single agent session by its UUID",
        required: false,
      },
    },

    async execute(params, context): Promise<TranscriptTurnResult[]> {
      const query = params.query as string;
      const limit = (params.limit as number | undefined) ?? 10;
      const role = params.role as "user" | "assistant" | undefined;
      const from = params.from as string | undefined;
      const to = params.to as string | undefined;
      const sessionId = params.session as string | undefined;

      // ── Resolve DB from DI container ─────────────────────────────────────
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
            "transcripts.search requires a PostgreSQL backend with Drizzle ORM."
        );
      }

      // ── Build embedding service ──────────────────────────────────────────
      const { createEmbeddingServiceFromConfig } = await import(
        "@minsky/domain/ai/embedding-service-factory"
      );
      const embeddingService = await createEmbeddingServiceFromConfig();

      // ── Construct service and search ─────────────────────────────────────
      const { TranscriptSimilarityService } = await import(
        "@minsky/domain/transcripts/transcript-similarity-service"
      );
      const svc = new TranscriptSimilarityService(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
        embeddingService
      );

      const dateRange: { from?: Date; to?: Date } = {};
      if (from) {
        dateRange.from = new Date(from);
      }
      if (to) {
        dateRange.to = new Date(to);
      }

      const results = await svc.search(query, {
        limit,
        role,
        dateRange: Object.keys(dateRange).length > 0 ? dateRange : undefined,
        sessionId,
      });

      log.debug("transcripts.search complete", { query, resultCount: results.length });

      return results;
    },
  });

  log.debug("Transcript search command registered");
}
