/**
 * Knowledge Scheduler Wiring
 *
 * Constructs and starts the KnowledgeSyncScheduler as part of MCP server startup.
 * Must NOT be called from CLI-only code paths (e.g. `minsky --help`) — see ADR-002.
 *
 * Called from start-command.ts after the DI container is initialized.
 */

import type { AppContainerInterface } from "../../composition/types";
import type { KnowledgeSyncScheduler } from "../../domain/knowledge/ingestion/scheduler";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

/**
 * Build and start a `KnowledgeSyncScheduler` from configured knowledge sources.
 *
 * Returns the live scheduler instance so the caller can register `stop()` with
 * the shutdown handler. Returns `null` when no sources with a non-`on-demand`
 * schedule are found — callers may skip registration in that case.
 *
 * Errors during service construction (missing API keys, bad config, etc.) are
 * logged at `warn` level and cause the function to return `null` rather than
 * crashing the MCP server — the scheduler is best-effort.
 */
export async function buildAndStartScheduler(
  container?: AppContainerInterface
): Promise<KnowledgeSyncScheduler | null> {
  try {
    const { getConfiguration } = await import("../../domain/configuration");
    const cfg = getConfiguration();

    const knowledgeBases =
      (cfg.knowledgeBases as Array<{
        name: string;
        type: string;
        sync?: { schedule?: string };
      }>) ?? [];

    // Only activate the scheduler when at least one source has an auto-firing schedule.
    const schedulableSources = knowledgeBases.filter(
      (s) => s.sync?.schedule && s.sync.schedule !== "on-demand"
    );

    if (schedulableSources.length === 0) {
      log.debug("[scheduler] No auto-scheduled knowledge sources found — scheduler not started");
      return null;
    }

    // Build the embedding service (reads AI config) and vector storage.
    const { createEmbeddingServiceFromConfig } = await import(
      "../../domain/ai/embedding-service-factory"
    );
    const embeddingService = await createEmbeddingServiceFromConfig();

    const persistence = container?.has("persistence") ? container.get("persistence") : undefined;
    let vectorStorage: import("../../domain/storage/vector/types").VectorStorage;

    if (persistence) {
      const { createVectorStorageFromConfig } = await import(
        "../../domain/storage/vector/vector-storage-factory"
      );
      vectorStorage = await createVectorStorageFromConfig(1536, persistence);
    } else {
      log.warn("[scheduler] No persistence provider — using in-memory vector storage");
      const { MemoryVectorStorage } = await import(
        "../../domain/storage/vector/memory-vector-storage"
      );
      vectorStorage = new MemoryVectorStorage(1536);
    }

    const deps: import("../../domain/knowledge/ingestion/sync-runner").SyncRunnerDeps = {
      embeddingService,
      vectorStorage,
    };

    // Build SchedulerSource list from configured sources.
    const { KnowledgeSyncScheduler } = await import("../../domain/knowledge/ingestion/scheduler");

    const sources: import("../../domain/knowledge/ingestion/scheduler").SchedulerSource[] = [];

    for (const src of schedulableSources) {
      try {
        const provider = await buildProviderForSource(
          src as import("../../domain/knowledge/types").KnowledgeSourceConfig
        );
        sources.push({
          name: src.name,
          provider,
          schedule: src.sync?.schedule ?? "on-demand",
        });
      } catch (err) {
        log.warn(
          `[scheduler] Could not build provider for source "${src.name}": ${getErrorMessage(err)}`
        );
        // Exclude this source from the scheduler but continue with others.
      }
    }

    if (sources.length === 0) {
      log.debug(
        "[scheduler] All auto-scheduled sources failed provider construction — scheduler not started"
      );
      return null;
    }

    const scheduler = new KnowledgeSyncScheduler({
      sources,
      deps,
      onError: (sourceName, error) => {
        log.error(`[scheduler] Sync error for source "${sourceName}"`, {
          error: getErrorMessage(error),
        });
      },
    });

    scheduler.start();
    log.cli(`[scheduler] Knowledge sync scheduler started (${sources.length} source(s))`);

    return scheduler;
  } catch (err) {
    log.warn(`[scheduler] Failed to start knowledge sync scheduler: ${getErrorMessage(err)}`);
    return null;
  }
}

/**
 * Build a KnowledgeSourceProvider for a single source config entry.
 * Mirrors the private createProvider logic in KnowledgeService.
 */
async function buildProviderForSource(
  config: import("../../domain/knowledge/types").KnowledgeSourceConfig
): Promise<import("../../domain/knowledge/types").KnowledgeSourceProvider> {
  switch (config.type) {
    case "notion": {
      const token =
        config.auth.token ??
        (config.auth.tokenEnvVar ? process.env[config.auth.tokenEnvVar] : undefined);
      if (!token) {
        throw new Error(
          `Notion API token not found for source "${config.name}". ${
            config.auth.tokenEnvVar
              ? `Set the "${config.auth.tokenEnvVar}" environment variable.`
              : `Provide a direct "token" value.`
          }`
        );
      }
      const notionConfig =
        config as import("../../domain/knowledge/types").KnowledgeSourceConfig & {
          rootPageId?: string;
        };
      if (!notionConfig.rootPageId) {
        throw new Error(
          `Notion source "${config.name}" requires a "rootPageId" in the configuration.`
        );
      }
      const { NotionKnowledgeProvider } = await import(
        "../../domain/knowledge/providers/notion-provider"
      );
      return new NotionKnowledgeProvider(notionConfig.rootPageId, token, config.name, {
        excludePatterns: config.sync?.excludePatterns,
      });
    }

    case "google-docs": {
      const accessToken =
        config.auth.token ??
        (config.auth.tokenEnvVar ? process.env[config.auth.tokenEnvVar] : undefined);
      const serviceAccountJsonStr = config.auth.serviceAccountJsonEnvVar
        ? process.env[config.auth.serviceAccountJsonEnvVar]
        : undefined;

      if (!accessToken && !serviceAccountJsonStr) {
        throw new Error(`Google Docs auth credentials not found for source "${config.name}".`);
      }

      let serviceAccountKey: import("../../domain/knowledge/providers/google-docs-provider").GoogleDocsProviderOptions["serviceAccountKey"];
      if (serviceAccountJsonStr) {
        try {
          serviceAccountKey = JSON.parse(serviceAccountJsonStr) as typeof serviceAccountKey;
        } catch {
          throw new Error(
            `Failed to parse service account JSON for Google Docs source "${config.name}".`
          );
        }
      }

      if (!config.driveFolderId && (!config.documentIds || config.documentIds.length === 0)) {
        throw new Error(
          `Google Docs source "${config.name}" requires either "driveFolderId" or "documentIds".`
        );
      }

      const { GoogleDocsKnowledgeProvider } = await import(
        "../../domain/knowledge/providers/google-docs-provider"
      );
      return new GoogleDocsKnowledgeProvider(config.name, {
        accessToken,
        serviceAccountKey,
        driveFolderId: config.driveFolderId,
        documentIds: config.documentIds,
        excludePatterns: config.sync?.excludePatterns,
      });
    }

    default:
      throw new Error(
        `Unsupported knowledge source type: "${config.type}". Supported: "notion", "google-docs".`
      );
  }
}
