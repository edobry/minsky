/**
 * Transcript Similar Command
 *
 * Registers the `transcripts.similar` MCP tool and
 * `minsky transcripts similar` CLI command.
 *
 * Routes to two query modes:
 *   - turnId set   → findSimilarTurn(turnId, { limit })
 *   - sessionId set → findSimilarSession(sessionId, { limit })
 *
 * Exactly one of turnId / sessionId must be provided. Both or neither is an error.
 *
 * Args:
 *   turnId     Optional. Composite key "<agentSessionId>:<turnIndex>".
 *   sessionId  Optional. Agent session UUID to find similar sessions for.
 *   limit      Optional. Max results to return (default 10).
 *
 * DI pattern mirrors index-embeddings-command.ts: persistence provider
 * resolved from `context.container` at execute time.
 *
 * @see mt#1354 — this file
 * @see mt#1352 — PerTurnEmbeddingPipeline (populates turn embeddings)
 * @see mt#1353 — SummaryPipeline (populates summary_embedding used by findSimilarSession)
 * @see mt#1313 §Search tools — transcripts.similar
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import type { SharedCommandRegistry } from "../../command-registry";
import { log } from "../../../../utils/logger";
import type { AppContainerInterface } from "../../../../composition/types";
import type {
  TranscriptTurnResult,
  TranscriptSessionResult,
} from "../../../../domain/transcripts/transcript-similarity-service";

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the `transcripts.similar` shared command.
 *
 * @param _container Optional DI container (resolved at execute time).
 * @param registry   Defaults to global sharedCommandRegistry. Pass a fresh
 *                   registry in tests to avoid global state mutation.
 */
export function registerTranscriptSimilarCommand(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  targetRegistry.registerCommand({
    id: "transcripts.similar",
    category: CommandCategory.TRANSCRIPTS,
    name: "similar",
    description:
      "Find transcript turns or sessions similar to a known seed. " +
      "Pass --turnId=<agentSessionId>:<turnIndex> to find similar turns, " +
      "or --sessionId=<uuid> to find similar sessions by summary embedding. " +
      "Exactly one of turnId or sessionId must be provided.",
    parameters: {
      turnId: {
        schema: z.string(),
        description:
          'Composite turn key "<agentSessionId>:<turnIndex>" — find turns similar to this seed turn',
        required: false,
      },
      sessionId: {
        schema: z.string(),
        description: "Agent session UUID — find sessions similar to this seed session",
        required: false,
      },
      limit: {
        schema: z.number().int().positive(),
        description: "Maximum number of results to return (default 10)",
        required: false,
        defaultValue: 10,
      },
    },

    async execute(params, context): Promise<TranscriptTurnResult[] | TranscriptSessionResult[]> {
      const turnId = params.turnId as string | undefined;
      const sessionId = params.sessionId as string | undefined;
      const limit = (params.limit as number | undefined) ?? 10;

      // ── Validate: exactly one of turnId / sessionId required ─────────────
      if (!turnId && !sessionId) {
        throw new Error(
          "transcripts.similar requires exactly one of --turnId or --sessionId. " +
            "Pass --turnId=<agentSessionId>:<turnIndex> to find similar turns, " +
            "or --sessionId=<uuid> to find similar sessions."
        );
      }
      if (turnId && sessionId) {
        throw new Error(
          "transcripts.similar accepts only one of --turnId or --sessionId, not both. " +
            "Pass --turnId to search by turn, or --sessionId to search by session."
        );
      }

      // ── Resolve DB from DI container ─────────────────────────────────────
      const persistenceProvider = (() => {
        if (context.container?.has("persistence")) {
          return context.container.get(
            "persistence"
          ) as import("../../../../domain/persistence/types").SqlCapablePersistenceProvider;
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
            "transcripts.similar requires a PostgreSQL backend with Drizzle ORM."
        );
      }

      // ── Build embedding service ──────────────────────────────────────────
      const { createEmbeddingServiceFromConfig } = await import(
        "../../../../domain/ai/embedding-service-factory"
      );
      const embeddingService = await createEmbeddingServiceFromConfig();

      // ── Construct service and route ──────────────────────────────────────
      const { TranscriptSimilarityService } = await import(
        "../../../../domain/transcripts/transcript-similarity-service"
      );
      const svc = new TranscriptSimilarityService(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
        embeddingService
      );

      if (turnId) {
        const results = await svc.findSimilarTurn(turnId, { limit });
        log.debug("transcripts.similar (turn) complete", { turnId, resultCount: results.length });
        return results;
      }

      // sessionId is set (validated above)
      const results = await svc.findSimilarSession(sessionId as string, { limit });
      log.debug("transcripts.similar (session) complete", {
        sessionId,
        resultCount: results.length,
      });
      return results;
    },
  });

  log.debug("Transcript similar command registered");
}
