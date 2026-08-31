import { injectable } from "tsyringe";
import type { Task } from "../tasks";
import { log } from "@minsky/shared/logger";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage, SearchResult } from "../storage/vector/types";
import type { SimilarityItem } from "../similarity/types";
import { createHash } from "crypto";
import { SimilaritySearchService } from "../similarity/similarity-search-service";
import {
  EmbeddingsSimilarityBackend,
  EMBEDDINGS_BACKEND_NAME,
} from "../similarity/backends/embeddings-backend";
import { LexicalSimilarityBackend } from "../similarity/backends/lexical-backend";
import { first } from "@minsky/shared/array-safety";
import { ALL_PROJECTS, isAllProjects, type ProjectScope } from "../project/scope";

/**
 * The one backend whose `score` is on the SCALE `--threshold` is calibrated
 * against — cosine similarity in [0, 1] (mt#4805).
 *
 * Every backend now agrees on DIRECTION (higher is more similar), so this is no
 * longer a direction guard; see {@link TaskSimilarityService.applyThreshold}.
 * `lexical` returns a Jaccard coefficient, which shares the [0, 1] range but not
 * the distribution, and `ai` is its own thing. Kept as a named constant rather
 * than a bare string so the coupling to `EmbeddingsSimilarityBackend.name` is
 * greppable from both sides.
 */
const SIMILARITY_CALIBRATED_BACKEND = EMBEDDINGS_BACKEND_NAME;

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
    private readonly searchTasks: (query: {
      text?: string;
      /** Live-tasks-table project scope for this fetch (mt#2939, ADR-021). */
      projectScope?: ProjectScope;
    }) => Promise<Task[]>,
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
        // NOTE (mt#2939): candidate listing is intentionally UNSCOPED here — the
        // live-task cross-check applied afterwards via applyProjectScope() /
        // searchByText's `passes()` filter drops any candidate (lexical or
        // embeddings-sourced) that isn't in the caller's resolved project scope.
        // Over-generating lexical candidates just means slightly more scoring
        // work, never a correctness gap.
        listCandidateIds: async () => (await this.searchTasks({})).map((t) => t.id),
        getContent: async (id: string) => (await this.getTaskSpecContent(id)).content,
      });
      this.searchService = new SimilaritySearchService([embeddingsBackend, lexicalBackend]);
    }
    return this.searchService;
  }

  /**
   * Live cross-check against the `tasks` table's project scope (mt#2939,
   * mirroring the mt#2416 / ADR-021 default-scoped-read convention). When
   * `projectScope` is the ALL_PROJECTS sentinel this is a no-op passthrough.
   * Otherwise, fetches the live task set scoped to `projectScope` and drops
   * any vector-search result whose id is not in that set — this covers both
   * genuinely cross-project tasks AND orphaned embeddings with no live task
   * row, the same way the `hasDomainFilter` path in `searchByText` already
   * treats a missing live task as "drop."
   */
  private async applyProjectScope(
    items: SimilarityItem[],
    projectScope: ProjectScope
  ): Promise<SimilarityItem[]> {
    if (isAllProjects(projectScope)) return items;
    const liveTasks = await this.searchTasks({ projectScope });
    const liveIds = new Set(liveTasks.map((t) => t.id));
    return items.filter((i) => liveIds.has(i.id));
  }

  /** Expose service configuration for diagnostics */
  getConfig(): TaskSimilarityServiceConfig {
    return this.config;
  }

  async similarToTask(
    taskId: string,
    limit = 10,
    threshold?: number,
    projectScope: ProjectScope = ALL_PROJECTS,
    filters?: Record<string, unknown>
  ): Promise<TaskSearchResponse> {
    const task = await this.findTaskById(taskId);
    if (!task) {
      return { results: [], backend: "none", degraded: false };
    }
    const content = await this.extractTaskContent(task);
    // mt#3305: delegate to searchByText instead of calling the search service
    // directly. These were always ONE operation — this method's only distinct
    // work is turning a task into query text — but the two paths had drifted:
    // searchByText applied status/kind/backend filters and honoured the domain
    // filter surface, this one applied none; `threshold` was accepted here and
    // silently dropped. Sharing the core means a parameter cannot be live on one
    // door and dead on the other, which is how both mt#3305 defects arose.
    //
    // The DEFAULTS still differ, deliberately, and that difference lives in the
    // command layer where it is visible: `tasks_search` excludes terminal
    // statuses (it answers "what's out there?"), `tasks_similar` does not (it
    // answers "does this already exist?" — excluding shipped work defeats it).
    return this.searchByText(content, limit, threshold, filters, projectScope);
  }

  /**
   * Drop results below the caller's minimum-similarity threshold.
   *
   * `threshold` was declared on three signatures and applied by none — accepted
   * at the boundary and dropped, so `--threshold 0.1` and `--threshold 0.95`
   * returned identical result sets. mt#3305 made it live.
   *
   * ## The comparison flipped (mt#4805) — and so did the parameter's meaning
   *
   * mt#3305 wrote `score <= threshold`, correctly, because the embeddings
   * backend then returned the vector store's raw L2 DISTANCE. mt#4805 moved that
   * conversion up into `EmbeddingsSimilarityBackend`, so `SimilarityItem.score`
   * is a SIMILARITY from every backend — cosine from embeddings, Jaccard from
   * lexical; direction guaranteed, units not — and the predicate is
   * `score >= threshold`.
   *
   * That is a USER-VISIBLE contract change on `tasks_search --threshold` /
   * `tasks_similar --threshold`, whose description said "distance threshold
   * (lower is closer)" and now says "similarity threshold (higher is more
   * similar)". A caller passing 0.6 previously asked for *at most* 0.6 distance
   * (≈ 0.82 similarity) and now asks for *at least* 0.6 similarity — a strictly
   * looser filter, not an inverted one, so an existing invocation returns a
   * superset rather than nonsense. Both descriptions are updated in
   * `task-parameters.ts`; the sibling `tools_search --threshold` already
   * documented similarity and was the one whose CODE was wrong.
   *
   * ## The backend SKIP does not survive the flip
   *
   * PR #2434 R1 added it, and its stated reason was DIRECTION: applying a
   * distance-oriented predicate to `lexical-backend`'s Jaccard similarity would
   * have kept the WORST matches and dropped the best, silently, on the degraded
   * path where the caller is least likely to notice. That hazard is gone — every
   * backend now points the same way — so the threshold is applied uniformly and
   * the skip is removed.
   *
   * SCALE remains, and is deliberately not answered by skipping.
   * `SimilarityItem.score` guarantees direction, never units: a Jaccard
   * coefficient over token sets is smaller than the same pair's cosine
   * similarity, so a cosine-calibrated threshold over-filters the lexical
   * fallback. It over-filters in the RIGHT direction — a caller gets fewer
   * results, all of them the better ones — whereas skipping returns a result set
   * the caller's threshold had no effect on. Silently ignoring the parameter is
   * the exact defect mt#3305 was filed for; re-introducing it on one path is not
   * an improvement over a filter that is merely conservative there.
   *
   * The sibling services agree: `ToolSimilarityService.findRelevantTools` and
   * `RuleSimilarityService.searchByText` both apply it unconditionally, and
   * `SimilaritySearchResponse.backend` plus the degraded warning both commands
   * already surface are what tell a caller which scale they are on. The debug
   * line below records it for anyone reading logs.
   */
  private applyThreshold<T extends { score: number }>(
    items: T[],
    threshold: number | undefined,
    backend: string
  ): T[] {
    if (threshold === undefined) return items;
    if (backend !== SIMILARITY_CALIBRATED_BACKEND) {
      log.debug(
        "tasks search: threshold applied against a backend on a different score scale (mt#4805)",
        { backend, threshold }
      );
    }
    return items.filter((i) => i.score >= threshold);
  }

  async searchByText(
    query: string,
    limit = 10,
    threshold?: number,
    filters?: Record<string, unknown>,
    projectScope: ProjectScope = ALL_PROJECTS
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
    // Workflow-kind filter (mt#2762). Applied against the live task, same as
    // status/backend — kind is undefined on GHI-backed tasks today (a known
    // gap), so those tasks only match a "implementation" kind filter.
    const kindEquals = typeof filters?.kind === "string" ? (filters.kind as string) : undefined;
    // mt#2939: project scoping is itself a domain filter requiring a live cross-check —
    // a resolved (non-ALL_PROJECTS) scope forces the filtered path even with no other
    // status/backend/kind filter, closing the gap where the "fast path" previously
    // returned raw, unscoped vector-search results by default.
    const hasDomainFilter =
      Boolean(statusEquals) ||
      (statusExclude?.length ?? 0) > 0 ||
      Boolean(backendEquals) ||
      Boolean(kindEquals) ||
      !isAllProjects(projectScope);

    // mt#2744: phase timing for the full tasks search path. The backend logs the
    // embed-vs-vector split per getSearchService().search() call; this summary adds
    // the filtered-path overhead (fetch-all-tasks for live filtering + a possible
    // second "widen" vector search) that the backend-level timing cannot see.
    const searchStartTs = Date.now();

    // Fast path: no domain filter AND no project scope active (used by default when
    // the caller explicitly asked for ALL_PROJECTS) — search the full corpus directly
    // with no extra task lookups.
    if (!hasDomainFilter) {
      const response = await this.getSearchService().search({ queryText: query, limit });
      log.debug("tasks searchByText timing (mt#2744)", {
        path: "fast",
        searches: 1,
        totalMs: Math.round(Date.now() - searchStartTs),
        limit,
      });
      return {
        results: this.applyThreshold(response.items, threshold, response.backend).map((i) => ({
          id: i.id,
          score: i.score,
          metadata: i.metadata,
        })),
        backend: response.backend,
        degraded: response.degraded,
        degradedReason: response.degradedReason,
      };
    }

    // Live source of truth for every task's status/backend, embedded CONCURRENTLY
    // with this fetch (mt#2754): the embed hits OpenAI while the fetch hits Postgres,
    // so they overlap with no DB contention. The vector search below reuses the
    // precomputed vector and runs AFTER this fetch, so the two DB round-trips never
    // overlap (the mt#2744 DB-contention finding). Spec content is loaded separately.
    // mt#2939: this fetch is scoped to `projectScope` — when a real (non-ALL_PROJECTS)
    // scope is active, cross-project tasks are absent from `allTasks`/`taskById` below,
    // so `passes()`'s `!task` branch drops any cross-project vector-search match the
    // same way it already drops orphaned embeddings.
    let embedMs = 0;
    let allTasksFetchMs = 0;
    const parallelStart = Date.now();
    const [queryVector, allTasks] = await Promise.all([
      // If the pre-embed throws (e.g. embedding provider down), resolve to undefined so the
      // embeddings backend re-attempts inside getSearchService().search() and, on failure,
      // SimilaritySearchService degrades to the lexical backend exactly as before this
      // optimization — the precompute must not bypass the graceful fallback (mt#2754 review).
      this.embeddingService.generateEmbedding(query).then(
        (v) => {
          embedMs = Date.now() - parallelStart;
          return v;
        },
        (err: unknown) => {
          log.debug("tasks searchByText pre-embed failed; deferring to search-service fallback", {
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        }
      ),
      this.searchTasks({ projectScope }).then((t) => {
        allTasksFetchMs = Date.now() - parallelStart;
        return t;
      }),
    ]);
    const taskById = new Map(allTasks.map((t) => [t.id, t]));
    const passes = (task: Task | undefined): boolean => {
      if (!task) return false; // orphaned embedding (no live task) — drop
      if (backendEquals && task.backend !== backendEquals) return false;
      if (kindEquals && (task.kind ?? "implementation") !== kindEquals) return false;
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
    // mt#2939: `allTasks.length` is a reliable upper bound on the vector index's
    // useful candidate pool ONLY when it spans the full corpus (the pre-mt#2939,
    // domain-filter-only case — status/backend/kind filters still fetch ALL
    // tasks). Once a real project scope narrows `allTasks` to a subset, the
    // (unscoped) vector index can still rank many cross-project items ahead of
    // the true best in-scope match, so capping the search window at the scoped
    // count risks never reaching it. Cap on MAX_CANDIDATES alone in that case.
    const candidateCeiling = isAllProjects(projectScope)
      ? Math.min(total, MAX_CANDIDATES)
      : MAX_CANDIDATES;
    const candidateLimit = Math.min(
      candidateCeiling,
      Math.max(OVERFETCH_FLOOR, Math.ceil(limit / Math.max(passRate, 0.05)) * OVERFETCH_SAFETY)
    );

    let response = await this.getSearchService().search({
      queryText: query,
      queryVector,
      limit: candidateLimit,
    });
    let survivors = response.items.filter((i) => passes(taskById.get(i.id)));
    let vectorSearches = 1;

    // Widen-if-short: if the initial window didn't yield `limit` survivors and a larger
    // (still bounded) window is available, re-search up to the candidate ceiling.
    if (survivors.length < limit && candidateLimit < candidateCeiling) {
      response = await this.getSearchService().search({
        queryText: query,
        queryVector,
        limit: candidateCeiling,
      });
      survivors = response.items.filter((i) => passes(taskById.get(i.id)));
      vectorSearches = 2;
    }

    log.debug("tasks searchByText timing (mt#2744)", {
      path: "filtered",
      totalMs: Math.round(Date.now() - searchStartTs),
      embedMs: Math.round(embedMs),
      allTasksFetchMs: Math.round(allTasksFetchMs),
      allTasksCount: total,
      vectorSearches,
      candidateLimit,
      survivors: survivors.length,
      limit,
    });

    return {
      results: this.applyThreshold(survivors, threshold, response.backend)
        .slice(0, limit)
        .map((i) => ({
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
    threshold?: number,
    projectScope: ProjectScope = ALL_PROJECTS
  ): Promise<TaskSearchResponse> {
    if (searchTerms.length === 0) {
      return { results: [], backend: "none", degraded: false };
    }

    // Create a natural language query from the search terms
    const query = this.constructSearchQuery(searchTerms);
    const response = await this.searchByText(query, limit * 2, threshold, undefined, projectScope);

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

  /**
   * Embed and store one task's content. Returns true when a new embedding was
   * stored, false when the up-to-date check skipped the task. Under
   * `opts.force` (the `tasks index-embeddings --reindex` path, mt#2795) the
   * up-to-date check is bypassed, so the task is always re-embedded and the
   * method always returns true (absent an error).
   */
  async indexTask(taskId: string, opts?: { force?: boolean }): Promise<boolean> {
    const task = await this.findTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Get the full task content (title + spec content)
    const content = await this.extractTaskContent(task);
    const contentHash = createHash("sha256").update(content).digest("hex");

    // Skip if up-to-date — unless a forced re-embed was requested
    // (`tasks index-embeddings --reindex`, mt#2795).
    try {
      if (!opts?.force && typeof this.vectorStorage.getMetadata === "function") {
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
    // Token-cap enforcement moved to the embedding-service boundary (mt#4212).
    // The ~65 lines that used to sit here were the ONLY truncation in the
    // codebase, protecting this one call site while transcripts, memories, tools
    // and knowledge sync sent unbounded input — which is how the 2026-08-17
    // embeddings outage happened. `truncateEmbeddingInput`, applied inside the
    // OpenAI and Gemini services, now covers every consumer including this one.
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
