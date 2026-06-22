/**
 * Transcript Spawns Extract Command
 *
 * Registers the `transcripts.spawns-extract` MCP tool and
 * `minsky transcripts spawns-extract` CLI command.
 *
 * Delegates to AgentSpawnsPipeline (mt#1327) which scans
 * agent_transcript_turns rows where is_spawn_boundary = true,
 * extracts agent_kind / spawn_type from tool_calls JSON, resolves
 * child_agent_session_id (metadata first, then cwd-time heuristic),
 * and upserts into agent_spawns.
 *
 * Args:
 *   --session=<uuid>  Target a single parent agent session by its UUID
 *   --all             Sweep all spawn-boundary turns across all sessions
 *
 * Exactly one of --all or --session must be provided.
 * Idempotent: upserts on (parent_agent_session_id, parent_turn_index).
 *
 * DI pattern mirrors index-embeddings-command.ts: persistence provider
 * resolved from `context.container` at execute time.
 *
 * Design choice (post-pass orchestrator):
 *   AgentSpawnsPipeline is a separate post-pass sweep rather than an
 *   inline extension of PerTurnEmbeddingPipeline. This keeps mt#1352's
 *   pipeline untouched (no regression risk) and lets mt#1329 also extend
 *   ingest independently.
 *
 * @see mt#1327 — AgentSpawnsPipeline + this file
 * @see mt#1313 §Schema — agent_spawns table
 * @see mt#1352 — PerTurnEmbeddingPipeline (writes is_spawn_boundary flag)
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import type { SharedCommandRegistry } from "../../command-registry";
import {
  conversationIdParam,
  deprecatedConversationAlias,
  resolveConversationId,
} from "./conversation-id-param";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "@minsky/domain/errors/index";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { SpawnsPipelineRunResult } from "@minsky/domain/transcripts/agent-spawns-pipeline";

// ── Result shape ──────────────────────────────────────────────────────────────

export interface TranscriptSpawnsExtractResult {
  /** Raw pipeline result. */
  pipeline: SpawnsPipelineRunResult;
  /** Set when --session was provided. */
  agentSessionId?: string;
  /** Human-readable status. */
  message: string;
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the `transcripts.spawns-extract` shared command.
 *
 * @param _container Optional DI container (resolved at execute time).
 * @param registry   Defaults to global sharedCommandRegistry. Pass a fresh
 *                   registry in tests to avoid global state mutation.
 */
export function registerTranscriptSpawnsExtractCommand(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  targetRegistry.registerCommand({
    id: "transcripts.spawns-extract",
    category: CommandCategory.TRANSCRIPTS,
    name: "spawns-extract",
    description:
      "Extract agent spawn relationships from transcript turns where is_spawn_boundary=true " +
      "and upsert into agent_spawns. Pass --all to sweep every ingested conversation, or " +
      "--conversationId=<uuid> to target one parent conversation (--session is a deprecated " +
      "alias). Idempotent.",
    parameters: {
      all: {
        schema: z.boolean(),
        description: "Sweep and extract spawns for all ingested sessions",
        required: false,
        defaultValue: false,
      },
      conversationId: conversationIdParam(
        "Extract spawns for a single parent harness conversation by its id (agent-session UUID)"
      ),
      session: deprecatedConversationAlias("session"),
    },

    async execute(params, context): Promise<TranscriptSpawnsExtractResult> {
      const doAll = (params.all as boolean | undefined) ?? false;
      const sessionId = resolveConversationId(params);

      if (!doAll && !sessionId) {
        throw new Error(
          "transcripts.spawns-extract requires either --all or --conversationId=<uuid> " +
            "(--session is a deprecated alias). Pass --all to sweep all ingested conversations."
        );
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
            "transcripts.spawns-extract requires a PostgreSQL backend with Drizzle ORM."
        );
      }

      // ── Construct pipeline ────────────────────────────────────────────────
      const { AgentSpawnsPipeline } = await import(
        "@minsky/domain/transcripts/agent-spawns-pipeline"
      );

      const pipeline = new AgentSpawnsPipeline(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase
      );

      // ── Execute: --all mode ───────────────────────────────────────────────
      if (doAll) {
        log.info("transcripts.spawns-extract --all: starting pipeline");
        let pipelineResult: SpawnsPipelineRunResult;
        try {
          pipelineResult = await pipeline.run();
          log.info("transcripts.spawns-extract --all: pipeline complete", { ...pipelineResult });
        } catch (err) {
          log.error("transcripts.spawns-extract --all: pipeline failed", {
            error: getErrorMessage(err),
          });
          throw err;
        }

        const message =
          `Scanned=${pipelineResult.spawnsScanned}, ` +
          `written=${pipelineResult.spawnsWritten}, ` +
          `linkedFromMetadata=${pipelineResult.childLinkedFromMetadata}, ` +
          `linkedFromHeuristic=${pipelineResult.childLinkedFromHeuristic}, ` +
          `unresolved=${pipelineResult.childUnresolved}, ` +
          `errored=${pipelineResult.spawnsErrored}`;

        return { pipeline: pipelineResult, message };
      }

      // ── Execute: single-session mode ──────────────────────────────────────
      log.info(`transcripts.spawns-extract --session=${sessionId}: starting pipeline`);

      let pipelineResult: SpawnsPipelineRunResult;
      try {
        pipelineResult = await pipeline.runForSession(sessionId as string);
        log.info(`transcripts.spawns-extract --session=${sessionId}: pipeline complete`, {
          ...pipelineResult,
        });
      } catch (err) {
        log.error(`transcripts.spawns-extract --session=${sessionId}: pipeline failed`, {
          error: getErrorMessage(err),
        });
        throw err;
      }

      const message =
        `Session ${sessionId}: scanned=${pipelineResult.spawnsScanned}, ` +
        `written=${pipelineResult.spawnsWritten}`;

      return { pipeline: pipelineResult, agentSessionId: sessionId, message };
    },
  });

  log.debug("Transcript spawns-extract command registered");
}
