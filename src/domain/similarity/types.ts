export interface SimilarityItem {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface SimilarityQuery {
  queryText?: string;
  subjectId?: string;
  limit?: number;
  filters?: Record<string, unknown>;
}

export interface SimilarityBackend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  search(query: SimilarityQuery): Promise<SimilarityItem[]>;
}

/** Result of a similarity search with backend metadata and degradation info */
export interface SimilaritySearchResponse {
  items: SimilarityItem[];
  /** Which backend produced the results ("embeddings" | "lexical") */
  backend: string;
  /** True if a higher-priority backend failed and we fell back */
  degraded: boolean;
  /** Human-readable reason for the fallback, if degraded */
  degradedReason?: string;
}
