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
