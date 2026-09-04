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
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
import type { EmbeddingService } from "@minsky/domain/ai/embeddings/types";
import type { VectorStorage } from "@minsky/domain/storage/vector/types";
import type {
  KnowledgeSourceConfig,
  SyncReport,
  KnowledgeSearchResponse,
  ChunkResult,
  ChunkFreshness,
  ChunkId,
} from "@minsky/domain/knowledge/types";
import type { KnowledgeService } from "@minsky/domain/knowledge/knowledge-service";
import { classifyFreshness } from "@minsky/domain/knowledge/reconciliation/freshness";
import { rankByAuthority } from "@minsky/domain/knowledge/reconciliation/authority-ranker";
import { buildRedundanciesFromMetadata } from "@minsky/domain/knowledge/reconciliation/redundancy-reader";
import {
  AnthropicNliClassifier,
  detectConflicts,
  type NliClassifier,
  type ClassifiableChunk,
} from "@minsky/domain/knowledge/reconciliation/conflicts";

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

// ─── Injectable dependencies ─────────────────────────────────────────────────

/** Embedding width of `knowledge_embeddings`, matching every other consumer of this domain. */
const KNOWLEDGE_EMBEDDING_DIMENSION = 1536;

/**
 * Outcome of resolving knowledge.search's embedding + vector-storage backend.
 *
 * Deliberately a RESULT type rather than a nullable handle: the unavailable
 * case has to carry a reason. Before mt#4946 the two commonest ways for this
 * command to return nothing — storage that was never wired, and an empty
 * corpus — were byte-identical at every surface, which is how a command that
 * had never once returned a result went undetected (mem#78 / mt#2757's shape).
 */
export type KnowledgeSearchBackend =
  | {
      ok: true;
      generateEmbedding: EmbeddingService["generateEmbedding"];
      search: VectorStorage["search"];
    }
  | { ok: false; reason: string };

export interface KnowledgeCommandsDeps {
  /**
   * Resolve knowledge.search's embedding service and vector storage, at
   * DISPATCH time.
   *
   * Required, with no `?? createReal(...)` behind it. ADR-026 §Decision rule 3
   * bans the `deps?.x ?? createConfiguredX(...)` shape outright because it
   * "hides missing DI wiring in new callers behind an apparently-working
   * default" — which is exactly what mt#4946 was: `registerKnowledgeCommands()`
   * was called with no arguments from its only production call site, so the
   * optional `vectorSearch` was permanently undefined and every query took the
   * degraded early return. Making this a required member moves that failure
   * from runtime silence to a compile error.
   *
   * A resolver rather than a resolved value, so construction stays at dispatch
   * time: registration runs at process start for every command, and building a
   * DB-backed vector store there would make command registration depend on a
   * live database. Same shape as the mt#3609 precedent
   * (`createRealPrincipalChannelDeps`), whose members are function references
   * invoked later rather than services constructed eagerly.
   */
  resolveSearchBackend: (ctx?: CommandExecutionContext) => Promise<KnowledgeSearchBackend>;
  /**
   * Build the conflict-detection classifier, or return null to disable it.
   *
   * Required for the same reason, and a factory for the same reason. This
   * replaced a three-way `deps === undefined` / `nliClassifier === null` /
   * `nliClassifier set` discriminator that keyed production behaviour on the
   * ABSENCE of the deps object — an idiom that silently stops working the
   * moment deps becomes required, disabling conflict detection in production
   * with nothing to notice.
   */
  createNliClassifier: (conflictModel?: string) => NliClassifier | null;
  /** Override for loading config (returns knowledgeBases array + optional reconciliation config) */
  getConfig?: () => Promise<{
    knowledgeBases: KnowledgeSourceConfig[];
    knowledgeReconciliation?: {
      staleness?: { agingDays?: number; staleDays?: number };
      sourceAuthority?: Record<string, number>;
      epsilon?: number;
      conflictModel?: string;
    };
  }>;
  /** Override for creating a KnowledgeService */
  createKnowledgeService?: (deps: {
    embeddingService: EmbeddingService;
    vectorStorage: VectorStorage;
    config: { knowledgeBases: KnowledgeSourceConfig[] };
  }) => KnowledgeService;
}

// ─── Production dependency construction (the composition-root half) ──────────

/**
 * Resolve the real embedding service + knowledge vector storage from the DI
 * container carried on the execution context.
 *
 * Every unavailable path returns a REASON rather than an empty stand-in. That
 * is the point of criterion 6: `createVectorStorageForDomain` answers a
 * provider it cannot use with an empty `MemoryVectorStorage` and a log line,
 * so wiring this command through it naively would turn today's honest
 * `backend: "none", degraded: true` into `backend: "embeddings",
 * degraded: false` over an empty store — a strictly worse failure, because it
 * stops looking like one.
 *
 * The container is populated on both interfaces that reach this command: MCP
 * sets it in `src/adapters/mcp/shared-command-integration.ts`, and the CLI
 * bridge sets it in `src/adapters/shared/bridges/cli/command-generator-core.ts`.
 */
async function resolveRealSearchBackend(
  ctx?: CommandExecutionContext
): Promise<KnowledgeSearchBackend> {
  const persistence = ctx?.container?.has("persistence")
    ? (ctx.container.get(
        "persistence"
      ) as import("@minsky/domain/persistence/types").PersistenceProvider)
    : undefined;

  if (!persistence) {
    return {
      ok: false,
      reason:
        "knowledge.search: no persistence provider on the execution context, so vector storage " +
        "could not be resolved. This command requires a running Minsky server with Postgres configured.",
    };
  }

  if (!persistence.capabilities.vectorStorage) {
    return {
      ok: false,
      reason:
        "knowledge.search: the configured persistence provider does not support vector storage, " +
        "so there is no knowledge_embeddings table to search.",
    };
  }

  const { createVectorStorageForDomain } = await import(
    "@minsky/domain/storage/vector/vector-storage-factory"
  );
  const vectorStorage = await createVectorStorageForDomain(
    "knowledge",
    KNOWLEDGE_EMBEDDING_DIMENSION,
    persistence
  );

  // The capability check above covers the factory's documented fallback
  // condition, but not a provider that declares the capability and still
  // answers null. Assert the outcome rather than the precondition: an empty
  // in-memory store returned here would search clean and find nothing.
  const { MemoryVectorStorage } = await import(
    "@minsky/domain/storage/vector/memory-vector-storage"
  );
  if (vectorStorage instanceof MemoryVectorStorage) {
    return {
      ok: false,
      reason:
        "knowledge.search: vector-storage resolution fell back to an empty in-memory store, " +
        "so a search would report success over no corpus. Refusing rather than returning zero results.",
    };
  }

  const { createEmbeddingServiceFromConfig } = await import(
    "@minsky/domain/ai/embedding-service-factory"
  );
  const embeddingService = await createEmbeddingServiceFromConfig();

  return {
    ok: true,
    generateEmbedding: embeddingService.generateEmbedding.bind(embeddingService),
    search: vectorStorage.search.bind(vectorStorage),
  };
}

/**
 * The production dependency set for {@link registerKnowledgeCommands}.
 *
 * Follows the mt#3609 / ADR-026 composition-root pattern already used three
 * lines away from this command's registration call, at
 * `src/adapters/shared/commands/index.ts` —
 * `registerPrincipalCommands(createRealPrincipalChannelDeps())`. Members are
 * function references, invoked at dispatch time; nothing is constructed here.
 * A grep for the production wiring of knowledge.search now finds this.
 */
export function createRealKnowledgeCommandsDeps(): KnowledgeCommandsDeps {
  return {
    resolveSearchBackend: resolveRealSearchBackend,
    createNliClassifier: (conflictModel?: string) =>
      new AnthropicNliClassifier({ model: conflictModel }),
  };
}

// ─── Registration function ────────────────────────────────────────────────────

export function registerKnowledgeCommands(
  targetRegistry: {
    registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => void;
  } = sharedCommandRegistry,
  deps: KnowledgeCommandsDeps
): void {
  // ── knowledge.search ──────────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "knowledge.search",
    category: CommandCategory.KNOWLEDGE,
    name: "search",
    description:
      "Semantic search across indexed knowledge bases. Returns ranked results with excerpts.",
    parameters: knowledgeSearchParams,
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing knowledge.search", { query: params.query, limit: params.limit });

      const limit = params.limit ?? 5;

      // Resolve the backend at DISPATCH time through the required injected
      // resolver. Until mt#4946 this read an OPTIONAL `deps.vectorSearch` that
      // the single production call site never supplied, so the degraded branch
      // below fired on every query the command ever served. The context is what
      // carries the DI container, and it was previously bound as `_ctx` and
      // discarded — the dependency was reachable the whole time.
      const backend = await deps.resolveSearchBackend(ctx);

      if (!backend.ok) {
        // PR #3602 R1 (NON-BLOCKING), taken at the class level: the catch below
        // carries a reason and this sibling degraded path did not, so the two
        // most common ways for this command to return nothing were
        // indistinguishable from an empty corpus and from EACH OTHER. The
        // resolver now names the specific condition instead of a fixed string,
        // which is what distinguishes "no persistence provider" from "provider
        // has no vector capability" from "resolution fell back to an empty store".
        log.warn("[knowledge.search] Search backend unavailable, returning empty results", {
          reason: backend.reason,
        });
        return {
          chunks: [],
          freshness: {} as Record<ChunkId, ChunkFreshness>,
          authority: [] as ChunkId[],
          conflicts: [],
          redundancies: [],
          backend: "none" as const,
          degraded: true,
          degradedReason: backend.reason,
        };
      }

      const embeddingFn: EmbeddingService["generateEmbedding"] = backend.generateEmbedding;
      const searchFn: VectorStorage["search"] = backend.search;

      // Load reconciliation config for freshness + authority + conflict detection
      let reconciliationConfig:
        | {
            staleness?: { agingDays?: number; staleDays?: number };
            sourceAuthority?: Record<string, number>;
            epsilon?: number;
            conflictModel?: string;
          }
        | undefined;
      try {
        if (deps.getConfig) {
          const cfg = await deps.getConfig();
          reconciliationConfig = cfg.knowledgeReconciliation;
        } else {
          const { getConfiguration } = await import("@minsky/domain/configuration");
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
          // mt#4944: `sourceName` is a JSONB member of `knowledge_embeddings.metadata`,
          // NOT a column. Naming it bare rendered `WHERE sourceName = $n`, which
          // Postgres folds to `sourcename` and rejects with 42703 — and the catch
          // below turned that throw into an empty result set, so this command has
          // never returned anything when `--sources` was passed. The dotted form
          // targets the member; the array does set membership rather than being
          // bound to a scalar `=`.
          filters: params.sources ? { "metadata.sourceName": params.sources } : undefined,
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

        // Build redundancies from cluster metadata written by reconcileAfterSync
        const redundancies = buildRedundanciesFromMetadata(rawResults);

        // Run pairwise NLI conflict detection over top-K chunks (K ≤ 10).
        // The factory decides: production returns a real AnthropicNliClassifier,
        // a test returns a fake or null to disable. This replaced a `deps ===
        // undefined` check that treated the ABSENCE of the deps object as the
        // production signal — an idiom that would have silently stopped
        // producing a classifier the moment mt#4946 made deps required, with a
        // passing test suite and no error anywhere.
        const nliClassifier: NliClassifier | null = deps.createNliClassifier(
          reconciliationConfig?.conflictModel
        );

        let conflicts: import("@minsky/domain/knowledge/types").ChunkConflict[] = [];
        if (nliClassifier && chunks.length >= 2) {
          const classifiableChunks: ClassifiableChunk[] = chunks.map((c) => ({
            id: c.id,
            text: c.excerpt,
          }));
          const detected = await detectConflicts(classifiableChunks, nliClassifier);
          conflicts = detected.map((d) => ({
            chunkA: d.chunkAId,
            chunkB: d.chunkBId,
            disagreement: d.disagreement,
          }));

          if (conflicts.length > 0) {
            log.warn(
              `[knowledge.search] Detected ${conflicts.length} conflict(s) among retrieved chunks`,
              { conflictCount: conflicts.length }
            );
          }
        }

        const response: KnowledgeSearchResponse & {
          backend: string;
          degraded: boolean;
          _conflictWarning?: string;
        } = {
          chunks,
          freshness,
          authority,
          conflicts,
          redundancies,
          backend: "embeddings" as const,
          degraded: false,
          ...(conflicts.length > 0
            ? {
                _conflictWarning: `⚠️  KNOWLEDGE CONFLICTS DETECTED (${conflicts.length}): ${conflicts
                  .map((c, i) => `[${i + 1}] ${c.chunkA} ↔ ${c.chunkB}: ${c.disagreement}`)
                  .join(" | ")}`,
              }
            : {}),
        };

        return response;
      } catch (error) {
        // mt#4944: `getLoggableErrorSummary`, not `getErrorMessage`. A
        // DrizzleQueryError's `.message` is `Failed query: …` and the actual
        // Postgres error — here the 42703 that made this command return nothing
        // for its whole life — lives on `.cause`. Rendering `.message` alone
        // would satisfy "a reason reaches the caller" while carrying none of
        // the diagnosis, which is the defect this criterion exists to close.
        const degradedReason = getLoggableErrorSummary(error);
        log.error("[knowledge.search] Search failed", { error: degradedReason });
        return {
          chunks: [],
          freshness: {} as Record<ChunkId, ChunkFreshness>,
          authority: [] as ChunkId[],
          conflicts: [],
          redundancies: [],
          backend: "none" as const,
          degraded: true,
          // The reason travels WITH the payload. Without it a failed query and
          // an empty corpus are byte-identical to every consumer, and the only
          // record of which one happened is a log line the caller never reads.
          degradedReason,
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
    execute: async (params, _ctx?: CommandExecutionContext) => {
      log.debug("Executing knowledge.fetch", {
        source: params.source,
        documentId: params.documentId,
      });

      const getConfig = deps.getConfig;

      let config: { knowledgeBases: KnowledgeSourceConfig[] };
      if (getConfig) {
        config = await getConfig();
      } else {
        const { getConfiguration } = await import("@minsky/domain/configuration");
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
      const { KnowledgeService } = await import("@minsky/domain/knowledge/knowledge-service");
      const noopEmbeddingService: EmbeddingService = {
        generateEmbedding: async () => [],
        generateEmbeddings: async () => [],
      };
      const { MemoryVectorStorage } = await import(
        "@minsky/domain/storage/vector/memory-vector-storage"
      );
      const noopVectorStorage = new MemoryVectorStorage(1);

      const createKnowledgeServiceFn =
        deps.createKnowledgeService ??
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
          "@minsky/domain/knowledge/providers/notion-provider"
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
    execute: async (_params, _ctx?: CommandExecutionContext) => {
      log.debug("Executing knowledge.sources");

      const getConfig = deps.getConfig;

      let config: { knowledgeBases: KnowledgeSourceConfig[] };
      if (getConfig) {
        config = await getConfig();
      } else {
        const { getConfiguration } = await import("@minsky/domain/configuration");
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
    execute: async (params, ctx?: CommandExecutionContext) => {
      log.debug("Executing knowledge.sync", { source: params.source, force: params.force });

      const getConfig = deps.getConfig;
      const createKnowledgeServiceFn = deps.createKnowledgeService;

      let config: { knowledgeBases: KnowledgeSourceConfig[] };
      if (getConfig) {
        config = await getConfig();
      } else {
        const { getConfiguration } = await import("@minsky/domain/configuration");
        const cfg = getConfiguration();
        config = { knowledgeBases: (cfg.knowledgeBases as KnowledgeSourceConfig[]) ?? [] };
      }

      let service: KnowledgeService;

      if (createKnowledgeServiceFn) {
        // Use injected factory (test path — skip real service creation)
        const { MemoryVectorStorage } = await import(
          "@minsky/domain/storage/vector/memory-vector-storage"
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
          "@minsky/domain/ai/embedding-service-factory"
        );
        const embeddingService = await createEmbeddingServiceFromConfig();

        // Get vector storage from container if available
        const persistence = ctx?.container?.has("persistence")
          ? ctx.container.get("persistence")
          : undefined;
        let vectorStorage: VectorStorage;

        if (persistence) {
          const { createVectorStorageForDomain } = await import(
            "@minsky/domain/storage/vector/vector-storage-factory"
          );
          vectorStorage = await createVectorStorageForDomain("knowledge", 1536, persistence);
        } else {
          log.warn("[knowledge.sync] No persistence provider; using in-memory vector storage");
          const { MemoryVectorStorage } = await import(
            "@minsky/domain/storage/vector/memory-vector-storage"
          );
          vectorStorage = new MemoryVectorStorage(1536);
        }

        const { KnowledgeService: KnowledgeServiceClass } = await import(
          "@minsky/domain/knowledge/knowledge-service"
        );
        service = new KnowledgeServiceClass({ embeddingService, vectorStorage, config });
      }

      const reports: SyncReport[] = await service.sync(params.source, { force: params.force });

      return { reports };
    },
  });
}
