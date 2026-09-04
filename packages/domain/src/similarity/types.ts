export interface SimilarityItem {
  id: string;
  /**
   * SIMILARITY — higher is more similar. Invariant across every backend (mt#4805).
   *
   * Read that as a contract on implementers, not a description of one of them.
   * Before mt#4805 this field was whatever its producer happened to emit:
   * `lexical-backend` and `tool-keyword-backend` returned higher-is-better scores,
   * `embeddings-backend` passed through the vector store's raw L2 DISTANCE, and
   * nothing in the type said which you were holding. `SimilaritySearchService`
   * falls back between them, so the ORIENTATION of this number depended on which
   * backend happened to be available — and two consumers had guessed differently,
   * one filtering `score <= threshold` and the other `score < threshold` against
   * the same field.
   *
   * A new backend MUST return higher-is-better. If its native metric is a
   * distance, convert at the backend boundary — `l2DistanceToSimilarity` in
   * `./similarity-score` for an L2 metric over unit vectors, whose measured
   * precondition table names every namespace already checked.
   *
   * The SCALE is deliberately not pinned. The embeddings backend returns a cosine
   * similarity in [0, 1]; `lexical-backend` returns a Jaccard coefficient in
   * [0, 1]; `tool-keyword-backend` returns an unbounded keyword score. So a
   * threshold calibrated on one backend is not meaningful against another, and a
   * consumer that cares should read `SimilaritySearchResponse.backend` — which is
   * why that field is returned. Only the DIRECTION is guaranteed.
   */
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
