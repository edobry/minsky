/**
 * Transcript Get Command
 *
 * Registers the `transcripts.get` MCP tool and
 * `minsky transcripts get` CLI command.
 *
 * Returns all turns for an agent session in turn_index order, optionally
 * sliced to a turn range. Delegates to TranscriptFtsService.getSession.
 *
 * Args:
 *   sessionId      Required. The agent session UUID.
 *   turnRange      Optional. Inclusive index range in "start-end" format (e.g. "10-20").
 *
 * DI pattern mirrors search-command.ts: persistence provider resolved from
 * `context.container` at execute time (not at registration time).
 *
 * @see mt#1355 — this file
 * @see mt#1352 — agent_transcript_turns schema
 * @see mt#1313 §Search tools — transcripts.get
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import type { SharedCommandRegistry } from "../../command-registry";
import { log } from "../../../../utils/logger";
import type { AppContainerInterface } from "../../../../composition/types";
import type { TranscriptTurnResult } from "../../../../domain/transcripts/transcript-fts-service";

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the `transcripts.get` shared command.
 *
 * @param _container Optional DI container (resolved at execute time).
 * @param registry   Defaults to global sharedCommandRegistry. Pass a fresh
 *                   registry in tests to avoid global state mutation.
 */
export function registerTranscriptGetCommand(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  targetRegistry.registerCommand({
    id: "transcripts.get",
    category: CommandCategory.TRANSCRIPTS,
    name: "get",
    description:
      "Return all turns for an agent session in turn_index order. " +
      "Optionally slice to a turn range using the turnRange parameter (format: 'start-end', e.g. '10-20'). " +
      "Throws if the session is not found. " +
      "Coverage: sessions are auto-ingested on MCP server boot; " +
      "if a session is missing, run `transcripts_ingest --all` to force a full sweep.",
    parameters: {
      sessionId: {
        schema: z.string(),
        description: "The agent session UUID to retrieve turns for",
        required: true,
      },
      turnRange: {
        schema: z
          .string()
          .regex(/^\d+-\d+$/, "turnRange must be in 'start-end' format, e.g. '10-20'"),
        description:
          "Inclusive turn index range in 'start-end' format (e.g. '10-20'). " +
          "Returns only turns with turn_index between start and end (inclusive).",
        required: false,
      },
    },

    async execute(params, context): Promise<TranscriptTurnResult[]> {
      const sessionId = params.sessionId as string;
      const turnRangeStr = params.turnRange as string | undefined;

      // ── Parse turnRange string into { start, end } ────────────────────────
      let turnRange: { start: number; end: number } | undefined;
      if (turnRangeStr) {
        const parts = turnRangeStr.split("-");
        const start = parseInt(parts[0] ?? "", 10);
        const end = parseInt(parts[1] ?? "", 10);
        if (!isNaN(start) && !isNaN(end)) {
          turnRange = { start, end };
        } else {
          throw new Error(
            `Invalid turnRange format: '${turnRangeStr}'. ` +
              "Expected 'start-end' with integer values, e.g. '10-20'."
          );
        }
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
            "transcripts.get requires a PostgreSQL backend with Drizzle ORM."
        );
      }

      // ── Construct service and fetch session ──────────────────────────────
      const { TranscriptFtsService } = await import(
        "../../../../domain/transcripts/transcript-fts-service"
      );
      const svc = new TranscriptFtsService(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase
      );

      const results = await svc.getSession(sessionId, { turnRange });

      log.debug("transcripts.get complete", { sessionId, resultCount: results.length });

      return results;
    },
  });

  log.debug("Transcript get command registered");
}
