import type { SimilarityBackend, SimilarityItem, SimilarityQuery } from "../types";
import type { EmbeddingService } from "../../ai/embeddings/types";
import type { VectorStorage } from "../../storage/vector/types";
import { log } from "@minsky/shared/logger";
import { l2DistanceToSimilarity } from "../similarity-score";

/**
 * This backend's `SimilarityBackend.name`, as a shared constant (mt#4805).
 *
 * Consumers that special-case the embeddings backend — currently
 * `TaskSimilarityService.applyThreshold` and `ToolSimilarityService.findRelevantTools`,
 * both to decide whether a caller's threshold is on this backend's SCALE — compared
 * against their own copy of the literal `"embeddings"`. Exporting it makes the coupling
 * greppable from both ends and keeps the copies from drifting apart.
 */
export const EMBEDDINGS_BACKEND_NAME = "embeddings";

export class EmbeddingsSimilarityBackend implements SimilarityBackend {
  readonly name = EMBEDDINGS_BACKEND_NAME;
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStorage: VectorStorage
  ) {}

  getEmbeddingService(): EmbeddingService {
    return this.embeddingService;
  }

  getVectorStorage(): VectorStorage {
    return this.vectorStorage;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.embeddingService) && Boolean(this.vectorStorage);
  }

  async search(query: SimilarityQuery): Promise<SimilarityItem[]> {
    const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : 10;
    const text = query.queryText ?? "";

    // mt#2744: phase timing to attribute embeddings-search latency between the
    // remote query-embedding call and the (HNSW-indexed) vector query — the only
    // two per-call costs in this shared path. Debug-level; near-zero overhead.
    const embedStart = Date.now();
    // mt#2754: reuse a precomputed query vector when the caller provides one
    // (embedded once, concurrently with other work) instead of re-embedding.
    const vector = query.queryVector ?? (await this.embeddingService.generateEmbedding(text));
    const embedMs = Date.now() - embedStart;

    const searchStart = Date.now();
    const results = await this.vectorStorage.search(vector, {
      limit,
      filters: query.filters,
    });
    const vectorSearchMs = Date.now() - searchStart;

    log.debug("embeddings-search phase timing (mt#2744)", {
      embedMs: Math.round(embedMs),
      vectorSearchMs: Math.round(vectorSearchMs),
      textLen: text.length,
      limit,
      resultCount: results.length,
    });

    // mt#4805: convert the store's L2 DISTANCE into a cosine SIMILARITY here, so
    // that `SimilarityItem.score` means the same thing whichever backend answered.
    //
    // This is the one place in the fallback chain that produced a lower-is-better
    // number. `lexical-backend` returns Jaccard similarity and `tool-keyword-backend`
    // a keyword score, both higher-is-better and both sorted descending — so before
    // this line, two of three backends disagreed with the third and no consumer could
    // tell which one had answered. `SimilaritySearchService` picks the first AVAILABLE
    // backend, so the orientation of the number a caller holds depended on whether the
    // embeddings path happened to be up.
    //
    // The conversion belongs at THIS boundary rather than inside `VectorStorage`:
    // ADR-013 keeps the shared store domain-agnostic (it backs rules, tools, tasks,
    // transcripts, memory and the principal corpus), and its own
    // `score <= threshold` filter is correct distance semantics for a store that
    // deals in distances. Same placement mt#4787 chose for the memory surface, and
    // for the same reason.
    //
    // Precondition — unit-length vectors — is measured per namespace; see the norm
    // table in `../similarity-score.ts` before routing a new namespace through here.
    // Ordering is unaffected: the conversion is strictly decreasing in `distance`,
    // so the store's nearest-first ORDER BY still holds after it.
    return results.map((r) => ({
      id: r.id,
      score: l2DistanceToSimilarity(r.score),
      metadata: r.metadata,
    }));
  }
}
