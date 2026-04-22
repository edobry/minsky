/**
 * Knowledge Commands
 *
 * Commands for searching, fetching, listing, and syncing knowledge bases.
 * Registers 4 commands in the shared command registry under the TOOLS category:
 *   - knowledge.search  — semantic search over indexed documents
 *   - knowledge.fetch   — live-fetch a single document from a source
 *   - knowledge.sources — list configured knowledge sources
 *   - knowledge.sync    — sync one or all knowledge sources
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
  type CommandDefinition,
} from "../../command-registry";
import { log } from "../../../../utils/logger";
import { getErrorMessage } from "../../../../errors/index";
import type { EmbeddingService } from "../../../../domain/ai/embeddings/types";
import type { VectorStorage } from "../../../../domain/storage/vector/types";
import type {
  KnowledgeSourceConfig,
  SyncReport,
  KnowledgeSearchResponse,
  ChunkResult,
  ChunkFreshness,
  ChunkId,
} from "../../../../domain/knowledge/types";
import type { KnowledgeService } from "../../../../domain/knowledge/knowledge-service";
import { classifyFreshness } from "../../../../domain/knowledge/reconciliation/freshness";
import { rankByAuthority } from "../../../../domain/knowledge/reconciliation/authority-ranker";

// ─── Parameter shapes ────────────────────────────────────────────────────────

export interface KnowledgeSearchParams {
  query: string;
  sources?: string[];
  limit?: number;
}

export interface KnowledgeFetchParams {
  source: string;
  documentId: string;
}

export interface KnowledgeSourcesParams {
  // no params
}

export interface KnowledgeSyncParams {
  source?: string;
  force?: boolean;
}

// ─── Parameter definitions (Zod schemas) ─────────────────────────────────────

const knowledgeSearchParams = {
  query: {
    schema: z.string(),
    description: "Search query",
    required: true as const,
  },
  sources: {
    schema: z.array(z.string()),
    description: "Optional list of source names to restrict the search",
    required: false as const,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of results to return (default 5)",
    required: false as const,
    defaultValue: 5,
  },
} satisfies CommandParameterMap;

const knowledgeFetchParams = {
  source: {
    schema: z.string(),
    description: "Name of the knowledge source",
    required: true as const,
  },
  documentId: {
    schema: z.string(),
    description: "ID of the document to fetch",
    required: true as const,
  },
} satisfies CommandParameterMap;

const knowledgeSourcesParams = {} satisfies CommandParameterMap;

const knowledgeSyncParams = {
  source: {
    schema: z.string(),
    description: "Name of the knowledge source to sync (omit to sync all)",
    required: false as const,
  },
  force: {
    schema: z.boolean(),
    description: "Force re-index even if content is unchanged",
    required: false as const,
    defaultValue: false,
  },
} satisfies CommandParameterMap;

// ─── Injectable dependencies (for testing) ───────────────────────────────────

export interface KnowledgeCommandsDeps {
  /** Override for generating an embedding of a query string */
  generateEmbedding?: EmbeddingService["generateEmbedding"];
  /** Override for the vector storage search */
  vectorSearch?: VectorStorage["search"];
  /** Override for loading config (returns knowledgeBases array + optional reconciliation config) */
  getConfig?: () => Promise<{
    knowledgeBases: KnowledgeSourceConfig[];
    knowledgeReconciliation?: {
      staleness?: { agingDays?: number; staleDays?: number };
      sourceAuthority?: Record<string, number>;
      epsilon?: number;
    };
  }>;
  /** Override for creating a KnowledgeService */
  createKnowledgeService?: (deps: {
    embeddingService: EmbeddingService;
    vectorStorage: VectorStorage;
    config: { knowledgeBases: KnowledgeSourceConfig[] };
  }) => KnowledgeService;
}

// ─── Registration function ────────────────────────────────────────────────────

export function registerKnowledgeCommands(
  targetRegistry: {
    registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => void;
  } = sharedCommandRegistry,
  deps?: KnowledgeCommandsDeps
): void {
  // ── knowledge.search ──────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "knowledge.search",
    category: CommandCategory.KNOWLEDGE,
    name: "search",
    description:
      "Semantic search across indexed knowledge bases. Returns ranked results with excerpts.",
    parameters: knowledgeSearchParams,
    execute: async (params: KnowledgeSearchParams, _ctx?: CommandExecutionContext) => {
      log.debug("Executing knowledge.search", { query: params.query, limit: params.limit });

      const limit = params.limit ?? 5;

      // Resolve dependencies
      const generateEmbedding = deps?.generateEmbedding;
      const vectorSearch = deps?.vectorSearch;

      let embeddingFn: EmbeddingService["generateEmbedding"];
      let searchFn: VectorStorage["search"];

      if (!vectorSearch) {
        // No vector storage — return degraded result immediately
        log.warn("[knowledge.search] Vector storage not available, returning empty results");
        return {
          chunks: [],
          freshness: {} as Record<ChunkId, ChunkFreshness>,
          authority: [] as ChunkId[],
          conflicts: [],
          redundancies: [],
          backend: "none" as const,
          degraded: true,
        };
      }

      if (generateEmbedding) {
        embeddingFn = generateEmbedding;
        searchFn = vectorSearch;
      } else {
        // Create real embedding service from config
        const { createEmbeddingServiceFromConfig } = await import(
          "../../../../domain/ai/embedding-service-factory"
        );
        const embeddingService = await createEmbeddingServiceFromConfig();
        embeddingFn = embeddingService.generateEmbedding.bind(embeddingService);
        searchFn = vectorSearch;
      }

      // Load reconciliation config for freshness + authority
      let reconciliationConfig:
        | {
            staleness?: { agingDays?: number; staleDays?: number };
            sourceAuthority?: Record<string, number>;
            epsilon?: number;
          }
        | undefined;
      try {
        if (deps?.getConfig) {
          const cfg = await deps.getConfig();
          reconciliationConfig = cfg.knowledgeReconciliation;
        } else {
          const { getConfiguration } = await import("../../../../domain/configuration");
          const cfg = getConfiguration();
          reconciliationConfig = (cfg as { knowledgeReconciliation?: typeof reconciliationConfig })
            .knowledgeReconciliation;
        }
      } catch {
        // Reconciliation config is optional — proceed without it
      }

      try {
        const queryVector = await embeddingFn(params.query);
        const rawResults = await searchFn(queryVector, {
          limit,
          filters: params.sources ? { sourceName: params.sources } : undefined,
        });

        const chunks: ChunkResult[] = rawResults.map((r) => ({
          id: r.id,
          title: (r.metadata?.title as string) ?? r.id,
          excerpt: (r.metadata?.excerpt as string) ?? (r.metadata?.content as string) ?? "",
          url: (r.metadata?.url as string) ?? "",
          source: (r.metadata?.sourceName as string) ?? "",
          score: r.score,
        }));

        // Build freshness map — classify each chunk
        const freshness: Record<ChunkId, ChunkFreshness> = {};
        for (const chunk of chunks) {
          const rawResult = rawResults.find((r) => r.id === chunk.id);
          const lastModifiedRaw = rawResult?.metadata?.["lastModified"];
          const lastModified =
            typeof lastModifiedRaw === "string" ? lastModifiedRaw : new Date(0).toISOString(); // fallback: epoch = stale
          const staleness = classifyFreshness(lastModified, reconciliationConfig?.staleness);
          freshness[chunk.id] = { lastModified, staleness };
        }

        // Build authority-ordered chunk ID list
        const authority = rankByAuthority(chunks, {
          sourceAuthority: reconciliationConfig?.sourceAuthority,
          epsilon: reconciliationConfig?.epsilon,
        });

        const response: KnowledgeSearchResponse & { backend: string; degraded: boolean } = {
          chunks,
          freshness,
          authority,
          conflicts: [],
          redundancies: [],
          backend: "embeddings" as const,
          degraded: false,
        };

        return response;
      } catch (error) {
        log.error("[knowledge.search] Search failed", { error: getErrorMessage(error) });
        return {
          chunks: [],
          freshness: {} as Record<ChunkId, ChunkFreshness>,
          authority: [] as ChunkId[],
          conflicts: [],
          redundancies: [],
          backend: "none" as const,
          degraded: true,
        };
      }
    },
  });

  // ── knowledge.fetch ───────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "knowledge.fetch",
    category: CommandCategory.KNOWLEDGE,
    name: "fetch",
    description: "Live-fetch a single document from a configured knowledge source by ID.",
    parameters: knowledgeFetchParams,
    execute: async (params: KnowledgeFetchParams, _ctx?: CommandExecutionContext) => {
      log.debug("Executing knowledge.fetch", {
        source: params.source,
        documentId: params.documentId,
      });

      const getConfig = deps?.getConfig;

      let config: { knowledgeBases: KnowledgeSourceConfig[] };
      if (getConfig) {
        config = await getConfig();
      } else {
        const { getConfiguration } = await import("../../../../domain/configuration");
        const cfg = getConfiguration();
        config = { knowledgeBases: (cfg.knowledgeBases as KnowledgeSourceConfig[]) ?? [] };
      }

      const sourceConfig = config.knowledgeBases.find((s) => s.name === params.source);
      if (!sourceConfig) {
        throw new Error(
          `Knowledge source not found: "${params.source}". ` +
            `Available sources: ${config.knowledgeBases.map((s) => s.name).join(", ") || "(none)"}`
        );
      }

      // Create a minimal EmbeddingService and VectorStorage to satisfy KnowledgeService deps,
      // then use it only for provider creation (fetch does not need embeddings).
      const { KnowledgeService } = await import("../../../../domain/knowledge/knowledge-service");
      const noopEmbeddingService: EmbeddingService = {
        generateEmbedding: async () => [],
        generateEmbeddings: async () => [],
      };
      const { MemoryVectorStorage } = await import(
        "../../../../domain/storage/vector/memory-vector-storage"
      );
      const noopVectorStorage = new MemoryVectorStorage(1);

      const createKnowledgeServiceFn =
        deps?.createKnowledgeService ??
        ((d) =>
          new KnowledgeService({
            embeddingService: d.embeddingService,
            vectorStorage: d.vectorStorage,
            config: d.config,
          }));

      const service = createKnowledgeServiceFn({
        embeddingService: noopEmbeddingService,
        vectorStorage: noopVectorStorage,
        config,
      });

      // Access the private createProvider via sync path — instead, call the provider directly
      // by delegating to a single-source sync approach is wasteful.
      // We expose provider creation by building an ad-hoc single-source KnowledgeService,
      // then rely on the provider's fetchDocument via the service's internal mechanism.
      // Since KnowledgeService.createProvider is private, we replicate the minimal logic here.
      const token =
        sourceConfig.auth.token ??
        (sourceConfig.auth.tokenEnvVar ? process.env[sourceConfig.auth.tokenEnvVar] : undefined);
      if (!token) {
        const hint = sourceConfig.auth.tokenEnvVar
          ? `Set the "${sourceConfig.auth.tokenEnvVar}" environment variable or provide a direct "token" value.`
          : `Provide a direct "token" value in the auth configuration.`;
        throw new Error(`API token not found. ${hint}`);
      }

      let provider;
      if (sourceConfig.type === "notion") {
        const notionConfig = sourceConfig as KnowledgeSourceConfig & { rootPageId?: string };
        if (!notionConfig.rootPageId) {
          throw new Error(
            `Notion knowledge source "${sourceConfig.name}" requires a "rootPageId" in the configuration.`
          );
        }
        const { NotionKnowledgeProvider } = await import(
          "../../../../domain/knowledge/providers/notion-provider"
        );
        provider = new NotionKnowledgeProvider(notionConfig.rootPageId, token, sourceConfig.name, {
          excludePatterns: sourceConfig.sync?.excludePatterns,
        });
      } else {
        throw new Error(
          `Unsupported knowledge source type: "${sourceConfig.type}". Only "notion" is currently supported.`
        );
      }

      // Suppress unused variable warning - service was created but provider created directly
      void service;

      const doc = await provider.fetchDocument(params.documentId);

      return {
        title: doc.title,
        content: doc.content,
        url: doc.url,
        lastModified: doc.lastModified,
      };
    },
  });

  // ── knowledge.sources ─────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "knowledge.sources",
    category: CommandCategory.KNOWLEDGE,
    name: "sources",
    description: "List configured knowledge sources with their sync status.",
    parameters: knowledgeSourcesParams,
    execute: async (_params: KnowledgeSourcesParams, _ctx?: CommandExecutionContext) => {
      log.debug("Executing knowledge.sources");

      const getConfig = deps?.getConfig;

      let config: { knowledgeBases: KnowledgeSourceConfig[] };
      if (getConfig) {
        config = await getConfig();
      } else {
        const { getConfiguration } = await import("../../../../domain/configuration");
        const cfg = getConfiguration();
        config = { knowledgeBases: (cfg.knowledgeBases as KnowledgeSourceConfig[]) ?? [] };
      }

      const sources = config.knowledgeBases.map((s) => ({
        name: s.name,
        type: s.type,
        syncSchedule: s.sync?.schedule ?? "on-demand",
      }));

      return { sources };
    },
  });

  // ── knowledge.sync ────────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "knowledge.sync",
    category: CommandCategory.KNOWLEDGE,
    name: "sync",
    description: "Sync one or all configured knowledge sources into the vector index.",
    parameters: knowledgeSyncParams,
    execute: async (params: KnowledgeSyncParams, ctx?: CommandExecutionContext) => {
      log.debug("Executing knowledge.sync", { source: params.source, force: params.force });

      const getConfig = deps?.getConfig;
      const createKnowledgeServiceFn = deps?.createKnowledgeService;

      let config: { knowledgeBases: KnowledgeSourceConfig[] };
      if (getConfig) {
        config = await getConfig();
      } else {
        const { getConfiguration } = await import("../../../../domain/configuration");
        const cfg = getConfiguration();
        config = { knowledgeBases: (cfg.knowledgeBases as KnowledgeSourceConfig[]) ?? [] };
      }

      let service: KnowledgeService;

      if (createKnowledgeServiceFn) {
        // Use injected factory (test path — skip real service creation)
        const { MemoryVectorStorage } = await import(
          "../../../../domain/storage/vector/memory-vector-storage"
        );
        const noopEmbed: EmbeddingService = {
          generateEmbedding: async () => [],
          generateEmbeddings: async () => [],
        };
        service = createKnowledgeServiceFn({
          embeddingService: noopEmbed,
          vectorStorage: new MemoryVectorStorage(1),
          config,
        });
      } else {
        // Create real services
        const { createEmbeddingServiceFromConfig } = await import(
          "../../../../domain/ai/embedding-service-factory"
        );
        const embeddingService = await createEmbeddingServiceFromConfig();

        // Get vector storage from container if available
        const persistence = ctx?.container?.has("persistence")
          ? ctx.container.get("persistence")
          : undefined;
        let vectorStorage: VectorStorage;

        if (persistence) {
          const { createVectorStorageFromConfig } = await import(
            "../../../../domain/storage/vector/vector-storage-factory"
          );
          vectorStorage = await createVectorStorageFromConfig(1536, persistence);
        } else {
          log.warn("[knowledge.sync] No persistence provider; using in-memory vector storage");
          const { MemoryVectorStorage } = await import(
            "../../../../domain/storage/vector/memory-vector-storage"
          );
          vectorStorage = new MemoryVectorStorage(1536);
        }

        const { KnowledgeService: KnowledgeServiceClass } = await import(
          "../../../../domain/knowledge/knowledge-service"
        );
        service = new KnowledgeServiceClass({ embeddingService, vectorStorage, config });
      }

      const reports: SyncReport[] = await service.sync(params.source, { force: params.force });

      return { reports };
    },
  });
}
