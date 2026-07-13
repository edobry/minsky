export interface SimilarityItem {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface SimilarityQuery {
  queryText?: string;
  /**
   * Precomputed query embedding (mt#2754). When set, the embeddings backend uses
   * it instead of calling generateEmbedding(queryText) — lets a caller embed once
   * and reuse the vector (e.g. across an over-fetch + widen) and embed concurrently
   * with other work. Backends that don't vector-search (lexical) ignore it.
   */
  queryVector?: number[];
  subjectId?: string;
  limit?: number;
  filters?: Record<string, unknown>;
}

export interface SimilarityBackend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  search(query: SimilarityQuery): Promise<SimilarityItem[]>;
}

export interface SimilaritySearchResponse {
  items: SimilarityItem[];
  backend: string;
  degraded: boolean;
  degradedReason?: string;
}
