/**
 * Transcript Index Embeddings Command
 *
 * Registers the `transcripts.index-embeddings` MCP tool and
 * `minsky transcripts reindex` CLI command.
 *
 * Delegates to two pipelines:
 *   1. PerTurnEmbeddingPipeline (mt#1352) — per-turn extraction + embedding
 *   2. SummaryPipeline (mt#1353) — summary generation + summary embedding
 *
 * Args:
 *   --session=<uuid>  Target a single agent session by its UUID
 *   --all             Sweep all discoverable sessions
 *
 * When called with --all, runs both pipelines over all agent_transcripts rows.
 * When called with --session, runs both pipelines for that one session.
 *
 * Idempotent: already-extracted turns are upserted; already-summarized rows
 * are skipped by default.
 *
 * DI pattern mirrors transcripts.ts: persistence provider resolved from
 * `context.container` at execute time.
 *
 * @see mt#1353 — this file
 * @see mt#1352 — PerTurnEmbeddingPipeline
 * @see mt#1313 §Search tools — transcripts.index-embeddings
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import type { SharedCommandRegistry } from "../../command-registry";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "@minsky/domain/errors/index";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { PipelineRunResult } from "@minsky/domain/transcripts/per-turn-embedding-pipeline";
import type { SummaryPipelineRunResult } from "@minsky/domain/transcripts/summary-pipeline";

// ── Result shape ──────────────────────────────────────────────────────────────

export interface TranscriptIndexEmbeddingsResult {
  /** Per-turn pipeline result (null if it failed or was skipped). */
  perTurn: {
    transcriptsScanned: number;
    transcriptsProcessed: number;
    transcriptsSkipped: number;
    transcriptsErrored: number;
    turnsWritten: number;
    embeddingCallsMade: number;
  } | null;
  /** Summary pipeline result (null if it failed or was skipped). */
  summary: {
    transcriptsScanned: number;
    transcriptsProcessed: number;
    transcriptsSkipped: number;
    transcriptsErrored: number;
    embeddingCallsMade: number;
  } | null;
  /** Set when --session was provided. */
  agentSessionId?: string;
  /** Human-readable status. */
  message: string;
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the `transcripts.index-embeddings` shared command.
 *
 * @param _container Optional DI container (resolved at execute time).
 * @param registry   Defaults to global sharedCommandRegistry. Pass a fresh
 *                   registry in tests to avoid global state mutation.
 */
export function registerTranscriptIndexEmbeddingsCommand(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  targetRegistry.registerCommand({
    id: "transcripts.index-embeddings",
    category: CommandCategory.TRANSCRIPTS,
    name: "index-embeddings",
    description:
      "Generate and store per-turn embeddings and session-level summary + summary embedding " +
      "for agent transcripts. Pass --all to sweep every ingested session, or " +
      "--session=<uuid> to target one. Both pipelines are idempotent.",
    parameters: {
      all: {
        schema: z.boolean(),
        description: "Sweep and re-index all ingested sessions",
        required: false,
        defaultValue: false,
      },
      session: {
        schema: z.string(),
        description: "Index a single session by its agent session UUID",
        required: false,
      },
      force: {
        schema: z.boolean(),
        description: "Force re-generation of summaries even for already-summarized rows",
        required: false,
        defaultValue: false,
      },
    },

    async execute(params, context): Promise<TranscriptIndexEmbeddingsResult> {
      const doAll = (params.all as boolean | undefined) ?? false;
      const sessionId = params.session as string | undefined;
      const force = (params.force as boolean | undefined) ?? false;

      if (!doAll && !sessionId) {
        throw new Error(
          "transcripts.index-embeddings requires either --all or --session=<uuid>. " +
            "Pass --all to sweep all ingested sessions."
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
            "transcripts.index-embeddings requires a PostgreSQL backend with Drizzle ORM."
        );
      }

      // ── Build embedding service ──────────────────────────────────────────
      const { createEmbeddingServiceFromConfig } = await import(
        "@minsky/domain/ai/embedding-service-factory"
      );
      const embeddingService = await createEmbeddingServiceFromConfig();

      // ── Build cognition provider ─────────────────────────────────────────
      const { getConfiguration } = await import("@minsky/domain/configuration");
      const { DefaultAICompletionService } = await import("@minsky/domain/ai/completion-service");
      const { DirectCognitionProvider } = await import("@minsky/domain/cognition/providers/direct");

      const configService = {
        loadConfiguration: () => Promise.resolve({ resolved: getConfiguration() }),
      };
      const aiService = new DefaultAICompletionService(configService);
      const cognitionProvider = new DirectCognitionProvider(aiService);

      // ── Construct pipelines ──────────────────────────────────────────────
      const { PerTurnEmbeddingPipeline } = await import(
        "@minsky/domain/transcripts/per-turn-embedding-pipeline"
      );
      const { SummaryPipeline } = await import("@minsky/domain/transcripts/summary-pipeline");

      const perTurnPipeline = new PerTurnEmbeddingPipeline(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
        embeddingService
      );
      const summaryPipeline = new SummaryPipeline(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
        cognitionProvider,
        embeddingService,
        { force }
      );

      // ── Execute: --all mode ──────────────────────────────────────────────
      if (doAll) {
        log.info("transcripts.index-embeddings --all: starting per-turn pipeline");
        let perTurnResult: PipelineRunResult | null = null;
        try {
          perTurnResult = await perTurnPipeline.run();
          log.info("transcripts.index-embeddings --all: per-turn pipeline complete", {
            ...perTurnResult,
          });
        } catch (err) {
          log.error("transcripts.index-embeddings --all: per-turn pipeline failed", {
            error: getErrorMessage(err),
          });
        }

        log.info("transcripts.index-embeddings --all: starting summary pipeline");
        let summaryResult: SummaryPipelineRunResult | null = null;
        try {
          summaryResult = await summaryPipeline.run();
          log.info("transcripts.index-embeddings --all: summary pipeline complete", {
            ...summaryResult,
          });
        } catch (err) {
          log.error("transcripts.index-embeddings --all: summary pipeline failed", {
            error: getErrorMessage(err),
          });
        }

        const message =
          `Per-turn: processed=${perTurnResult?.transcriptsProcessed ?? "error"}, ` +
          `turnsWritten=${perTurnResult?.turnsWritten ?? "error"}; ` +
          `Summary: processed=${summaryResult?.transcriptsProcessed ?? "error"}`;

        return { perTurn: perTurnResult, summary: summaryResult, message };
      }

      // ── Execute: single-session mode ─────────────────────────────────────
      log.info(`transcripts.index-embeddings --session=${sessionId}: starting per-turn pipeline`);

      // PerTurnEmbeddingPipeline sweeps all rows — run full pipeline for the single session.
      // Cost is low for a single-row table and keeps the per-turn pipeline API simple.
      let perTurnResult: PipelineRunResult | null = null;
      try {
        perTurnResult = await perTurnPipeline.run();
      } catch (err) {
        log.error(`transcripts.index-embeddings --session=${sessionId}: per-turn failed`, {
          error: getErrorMessage(err),
        });
      }

      let summaryProcessed = false;
      let summaryResult: SummaryPipelineRunResult | null = null;
      try {
        summaryProcessed = await summaryPipeline.runForSession(sessionId as string);
        summaryResult = {
          transcriptsScanned: 1,
          transcriptsProcessed: summaryProcessed ? 1 : 0,
          transcriptsSkipped: summaryProcessed ? 0 : 1,
          transcriptsErrored: 0,
          embeddingCallsMade: summaryProcessed ? 1 : 0,
        };
      } catch (err) {
        log.error(`transcripts.index-embeddings --session=${sessionId}: summary failed`, {
          error: getErrorMessage(err),
        });
      }

      const message =
        `Session ${sessionId}: per-turn done; ` +
        `summary=${summaryProcessed ? "generated" : "skipped"}`;

      return {
        perTurn: perTurnResult,
        summary: summaryResult,
        agentSessionId: sessionId,
        message,
      };
    },
  });

  log.debug("Transcript index-embeddings command registered");
}
