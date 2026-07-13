import { injectable } from "tsyringe";
import type { Task } from "../tasks";
import { log } from "@minsky/shared/logger";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage, SearchResult } from "../storage/vector/types";
import { createHash } from "crypto";
import { SimilaritySearchService } from "../similarity/similarity-search-service";
import { EmbeddingsSimilarityBackend } from "../similarity/backends/embeddings-backend";
import { LexicalSimilarityBackend } from "../similarity/backends/lexical-backend";
import { first } from "@minsky/shared/array-safety";
import { safeTruncate } from "@minsky/shared/safe-truncate";

export interface TaskSimilarityServiceConfig {
  similarityThreshold?: number;
  vectorLimit?: number;
  model?: string;
  dimension?: number;
}

export interface TaskSearchResponse {
  results: SearchResult[];
  backend: string;
  degraded: boolean;
  degradedReason?: string;
}

@injectable()
export class TaskSimilarityService {
  private searchService: SimilaritySearchService | null = null;

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStorage: VectorStorage,
    private readonly findTaskById: (id: string) => Promise<Task | null>,
    private readonly searchTasks: (query: { text?: string }) => Promise<Task[]>,
    private readonly getTaskSpecContent: (
      id: string
    ) => Promise<{ content: string; specPath: string; task: Task }>,
    private readonly config: TaskSimilarityServiceConfig = {}
  ) {}

  /** Build or return the cached SimilaritySearchService from injected deps */
  private getSearchService(): SimilaritySearchService {
    if (!this.searchService) {
      const embeddingsBackend = new EmbeddingsSimilarityBackend(
        this.embeddingService,
        this.vectorStorage
      );
      const lexicalBackend = new LexicalSimilarityBackend({
        getById: this.findTaskById,
        listCandidateIds: async () => (await this.searchTasks({})).map((t) => t.id),
        getContent: async (id: string) => (await this.getTaskSpecContent(id)).content,
      });
      this.searchService = new SimilaritySearchService([embeddingsBackend, lexicalBackend]);
    }
    return this.searchService;
  }

  /** Expose service configuration for diagnostics */
  getConfig(): TaskSimilarityServiceConfig {
    return this.config;
  }

  async similarToTask(taskId: string, limit = 10, threshold?: number): Promise<TaskSearchResponse> {
    const task = await this.findTaskById(taskId);
    if (!task) {
      return { results: [], backend: "none", degraded: false };
    }
    const content = await this.extractTaskContent(task);
    const response = await this.getSearchService().search({ queryText: content, limit });
    return {
      results: response.items.map((i) => ({
        id: i.id,
        score: i.score,
        metadata: i.metadata,
      })),
      backend: response.backend,
      degraded: response.degraded,
      degradedReason: response.degradedReason,
    };
  }

  async searchByText(
    query: string,
    limit = 10,
    threshold?: number,
    filters?: Record<string, unknown>
  ): Promise<TaskSearchResponse> {
    // Domain-specific filters (status / statusExclude / backend) are applied here,
    // at READ TIME against the live `tasks` table (the source of truth) — NOT pushed
    // down into the generic vector store as a denormalized column filter. See
    // docs/architecture/adr-013-filtered-vector-search.md and memory 70b595dc:
    // `tasks.status` is a mutable lifecycle field; denormalizing it onto
    // `tasks_embeddings` and filtering server-side is an unmanaged dual write that
    // drifts the moment a writer forgets (the mt#2220 bug — 1739 rows had NULL status
    // and `NULL NOT IN ('DONE','CLOSED')` silently excluded every recent task).
    //
    // Approach: post-filtering with adaptive over-fetch. We fetch more candidates than
    // `limit` from the vector index (no status filter), drop the ones failing the live
    // predicate, and widen to the full corpus if too few survive. This is the
    // application-layer equivalent of pgvector 0.8's iterative scan. It is correct at
    // any selectivity and cheap at per-org scale (thousands of tasks). At ~100x scale
    // the escape hatch is denormalize + consistent derivation (trigger/CDC) or a
    // partial index — see the ADR.
    const statusEquals =
      typeof filters?.status === "string" ? (filters.status as string) : undefined;
    const statusExclude = Array.isArray(filters?.statusExclude)
      ? (filters.statusExclude as string[])
      : undefined;
    const backendEquals =
      typeof filters?.backend === "string" ? (filters.backend as string) : undefined;
    const hasDomainFilter =
      Boolean(statusEquals) || (statusExclude?.length ?? 0) > 0 || Boolean(backendEquals);

    // mt#2744: phase timing for the full tasks search path. The backend logs the
    // embed-vs-vector split per getSearchService().search() call; this summary adds
    // the filtered-path overhead (fetch-all-tasks for live filtering + a possible
    // second "widen" vector search) that the backend-level timing cannot see.
    const searchStartTs = performance.now();

    // Fast path: no domain filter (used by similarToTask / searchSimilarTasks) — search
    // the full corpus directly with no extra task lookups.
    if (!hasDomainFilter) {
      const response = await this.getSearchService().search({ queryText: query, limit });
      log.debug("tasks searchByText timing (mt#2744)", {
        path: "fast",
        searches: 1,
        totalMs: Math.round(performance.now() - searchStartTs),
        limit,
      });
      return {
        results: response.items.map((i) => ({ id: i.id, score: i.score, metadata: i.metadata })),
        backend: response.backend,
        degraded: response.degraded,
        degradedReason: response.degradedReason,
      };
    }

    // Live source of truth for every task's status/backend (one query, lightweight
    // metadata — spec content is loaded separately and not included here).
    const allTasksFetchStart = performance.now();
    const allTasks = await this.searchTasks({});
    const allTasksFetchMs = performance.now() - allTasksFetchStart;
    const taskById = new Map(allTasks.map((t) => [t.id, t]));
    const passes = (task: Task | undefined): boolean => {
      if (!task) return false; // orphaned embedding (no live task) — drop
      if (backendEquals && task.backend !== backendEquals) return false;
      if (statusEquals) return task.status === statusEquals;
      if (statusExclude && statusExclude.includes(task.status)) return false;
      return true;
    };

    // Adaptive over-fetch: size the candidate window from the observed pass-rate so we
    // pull enough that ~`limit` survive the filter, with a safety multiplier and a floor.
    // Both the initial window AND the widen are hard-capped at MAX_CANDIDATES so a large
    // corpus or an extreme-selectivity query can never trigger an unbounded full-index
    // vector scan (`limit = total` would be slow and is mismatched against the actual
    // embeddings count). At per-org scale this cap sits far above what any query needs;
    // beyond it the right answer is the ADR-013 escape hatch (partial index /
    // denormalize+trigger), not a bigger scan. If the cap is still too selective to fill
    // `limit`, returning fewer results is acceptable and far better than the prior bug.
    const OVERFETCH_SAFETY = 2;
    const OVERFETCH_FLOOR = 50;
    const MAX_CANDIDATES = 1000;
    const total = allTasks.length;
    const passing = allTasks.filter(passes).length;
    const passRate = passing > 0 ? passing / total : 0;
    const candidateCeiling = Math.min(total, MAX_CANDIDATES);
    const candidateLimit = Math.min(
      candidateCeiling,
      Math.max(OVERFETCH_FLOOR, Math.ceil(limit / Math.max(passRate, 0.05)) * OVERFETCH_SAFETY)
    );

    let response = await this.getSearchService().search({
      queryText: query,
      limit: candidateLimit,
    });
    let survivors = response.items.filter((i) => passes(taskById.get(i.id)));
    let vectorSearches = 1;

    // Widen-if-short: if the initial window didn't yield `limit` survivors and a larger
    // (still bounded) window is available, re-search up to the candidate ceiling.
    if (survivors.length < limit && candidateLimit < candidateCeiling) {
      response = await this.getSearchService().search({
        queryText: query,
        limit: candidateCeiling,
      });
      survivors = response.items.filter((i) => passes(taskById.get(i.id)));
      vectorSearches = 2;
    }

    log.debug("tasks searchByText timing (mt#2744)", {
      path: "filtered",
      totalMs: Math.round(performance.now() - searchStartTs),
      allTasksFetchMs: Math.round(allTasksFetchMs),
      allTasksCount: total,
      vectorSearches,
      candidateLimit,
      survivors: survivors.length,
      limit,
    });

    return {
      results: survivors.slice(0, limit).map((i) => ({
        id: i.id,
        score: i.score,
        metadata: i.metadata,
      })),
      backend: response.backend,
      degraded: response.degraded,
      degradedReason: response.degradedReason,
    };
  }

  async searchSimilarTasks(
    searchTerms: string[],
    excludeTaskIds: string[] = [],
    limit = 10,
    threshold?: number
  ): Promise<TaskSearchResponse> {
    if (searchTerms.length === 0) {
      return { results: [], backend: "none", degraded: false };
    }

    // Create a natural language query from the search terms
    const query = this.constructSearchQuery(searchTerms);
    const response = await this.searchByText(query, limit * 2, threshold);

    // Filter out excluded task IDs
    const filtered = response.results
      .filter((result) => !excludeTaskIds.includes(result.id))
      .slice(0, limit);

    return {
      results: filtered,
      backend: response.backend,
      degraded: response.degraded,
      degradedReason: response.degradedReason,
    };
  }

  /**
   * Construct natural search query from terms
   * This logic will move to the generic similarity service in md#447
   */
  private constructSearchQuery(terms: string[]): string {
    // Create a natural language query that works well with embeddings
    const uniqueTerms = Array.from(new Set(terms.map((t) => t.toLowerCase())));

    if (uniqueTerms.length === 1) {
      return first(uniqueTerms, "search query terms");
    }

    // For multiple terms, create a coherent query
    return `Find tasks related to: ${uniqueTerms.join(", ")}`;
  }

  async indexTask(taskId: string): Promise<boolean> {
    const task = await this.findTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Get the full task content (title + spec content)
    let content = await this.extractTaskContent(task);
    const contentHash = createHash("sha256").update(content).digest("hex");

    // Skip if up-to-date
    try {
      if (typeof this.vectorStorage.getMetadata === "function") {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const meta = await this.vectorStorage.getMetadata!(taskId);
        const storedHash = meta?.content_hash || meta?.contentHash;
        const storedModel = meta?.model;
        const currentModel = this.config.model;
        if (
          storedHash &&
          storedHash === contentHash &&
          (!storedModel || storedModel === currentModel)
        ) {
          try {
            log.debug(`[index] skip up-to-date ${taskId}`);
          } catch {
            void 0; // ignore debug logging errors
          }
          return false;
        }
      }
    } catch {
      // ignore metadata read errors
    }
    // Apply model-aware token cap if configured
    try {
      const { getConfiguration } = await import("../configuration");
      const cfg = (await getConfiguration()) as Record<string, unknown>;
      const embeddings = cfg?.["embeddings"] as Record<string, unknown> | undefined;
      const model =
        this.config.model || (embeddings?.["model"] as string) || "text-embedding-3-small";
      const ai = cfg?.["ai"] as Record<string, unknown> | undefined;
      const provider =
        (embeddings?.["provider"] as string) || (ai?.["defaultProvider"] as string) || "openai";
      const embeddingModels = embeddings?.["models"] as
        | Record<string, Record<string, unknown>>
        | undefined;
      const caps = (embeddingModels && embeddingModels[model]) || {};
      // Built-in defaults by model pattern; can be overridden by config
      const defaultMaxByModel: Record<string, number> = {
        "text-embedding-3-small": 8192,
        "text-embedding-3-large": 8192,
      };
      const maxTokens: number | undefined =
        typeof caps.maxTokens === "number"
          ? caps.maxTokens
          : defaultMaxByModel[model] || (model.includes("embedding") ? 8192 : undefined);
      const buffer: number = typeof caps.buffer === "number" ? caps.buffer : 192;
      if (typeof maxTokens === "number" && maxTokens > 0) {
        const effective = Math.max(1, maxTokens - buffer);
        const { DefaultTokenizerService } = await import("../ai/tokenizer-service");
        const tokenizerService = new DefaultTokenizerService();
        const tokens = await tokenizerService.tokenize(content, model, provider);
        if (tokens.length > effective) {
          const trimmed = tokens.slice(0, effective);
          content = await tokenizerService.detokenize(trimmed, model, provider);
        }
      }
    } catch {
      // If tokenization or config fails, apply a conservative char-based trim fallback
      try {
        const { getConfiguration } = await import("../configuration");
        const cfg = (await getConfiguration()) as Record<string, unknown>;
        const embeddingsCfg = cfg?.["embeddings"] as Record<string, unknown> | undefined;
        const model =
          this.config.model || (embeddingsCfg?.["model"] as string) || "text-embedding-3-small";
        const embeddingModelsCfg = embeddingsCfg?.["models"] as
          | Record<string, Record<string, unknown>>
          | undefined;
        const caps = (embeddingModelsCfg && embeddingModelsCfg[model]) || {};
        const defaultMaxByModel: Record<string, number> = {
          "text-embedding-3-small": 8192,
          "text-embedding-3-large": 8192,
        };
        const maxTokens: number | undefined =
          typeof caps.maxTokens === "number"
            ? caps.maxTokens
            : defaultMaxByModel[model] || (model.includes("embedding") ? 8192 : undefined);
        const buffer: number = typeof caps.buffer === "number" ? caps.buffer : 192;
        if (typeof maxTokens === "number" && maxTokens > 0) {
          const effective = Math.max(1, maxTokens - buffer);
          // Heuristic: ~4 chars per token
          const maxChars = effective * 4;
          if (content.length > maxChars) {
            content = safeTruncate(content, maxChars, "head");
          }
        }
      } catch {
        // ignore and keep original content
      }
    }
    const vector = await this.embeddingService.generateEmbedding(content);
    const metadata: Record<string, unknown> = {
      taskId,
      model: this.config.model,
      dimension: this.config.dimension,
      contentHash,
      updatedAt: new Date().toISOString(),
    };

    await this.vectorStorage.store(taskId, vector, metadata);
    return true;
  }

  /**
   * Extract content for embedding generation
   * Simple approach: title + full spec content (as requested)
   * This prepares for the generic similarity service in md#447
   */
  private async extractTaskContent(task: Task): Promise<string> {
    const parts: string[] = [];

    // Always include the task title
    if (task.title) {
      parts.push(task.title);
    }

    try {
      // Get the full spec content for embedding
      const specData = await this.getTaskSpecContent(task.id);
      if (specData.content) {
        parts.push(specData.content);
      }
    } catch (error) {
      // If we can't get spec content, fall back to basic task info
      log.debug(
        `Failed to get spec content for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`
      );
      if (task.spec) {
        parts.push(task.spec);
      }
    }

    return parts.join("\n\n");
  }
}
