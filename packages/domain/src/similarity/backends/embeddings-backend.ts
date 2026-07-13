import type { SimilarityBackend, SimilarityItem, SimilarityQuery } from "../types";
import type { EmbeddingService } from "../../ai/embeddings/types";
import type { VectorStorage } from "../../storage/vector/types";
import { log } from "@minsky/shared/logger";

export class EmbeddingsSimilarityBackend implements SimilarityBackend {
  readonly name = "embeddings";
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
    const vector = await this.embeddingService.generateEmbedding(text);
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

    return results.map((r) => ({ id: r.id, score: r.score, metadata: r.metadata }));
  }
}
