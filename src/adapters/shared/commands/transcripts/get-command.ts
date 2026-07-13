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
import { log } from "@minsky/shared/logger";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { TranscriptTurnResult } from "@minsky/domain/transcripts/transcript-fts-service";
import type { AgentSessionId } from "@minsky/domain/transcripts/transcript-source";
import {
  conversationIdParam,
  deprecatedConversationAlias,
  resolveConversationId,
} from "./conversation-id-param";

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
      "Return all turns for a harness conversation in turn_index order. " +
      "Optionally slice to a turn range using the turnRange parameter (format: 'start-end', e.g. '10-20'). " +
      "Throws if the conversation is not found. " +
      "Coverage: conversations are auto-ingested on MCP server boot; " +
      "if a conversation is missing, run `transcripts_ingest --all` to force a full sweep.",
    parameters: {
      // NOTE (mt#2526): the conversation id is REQUIRED, but enforced at execute time
      // (resolveConversationId below) rather than via the schema `required` flag — so the
      // deprecated `sessionId` alias still satisfies it. Schema/MCP consumers should NOT
      // read `required: false` as "optional": exactly one of conversationId / sessionId
      // must be supplied (the execute path throws otherwise).
      conversationId: conversationIdParam(
        "The harness conversation id (agent-session UUID) to retrieve turns for"
      ),
      sessionId: deprecatedConversationAlias("sessionId"),
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
      const sessionId = resolveConversationId(params);
      if (!sessionId) {
        throw new Error(
          "transcripts.get requires conversationId (or its deprecated alias sessionId)."
        );
      }
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
            "transcripts.get requires a PostgreSQL backend with Drizzle ORM."
        );
      }

      // ── Construct service and fetch session ──────────────────────────────
      const { TranscriptFtsService } = await import(
        "@minsky/domain/transcripts/transcript-fts-service"
      );
      const svc = new TranscriptFtsService(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase
      );

      const results = await svc.getSession(sessionId as AgentSessionId, { turnRange });

      log.debug("transcripts.get complete", { sessionId, resultCount: results.length });

      return results;
    },
  });

  log.debug("Transcript get command registered");
}
