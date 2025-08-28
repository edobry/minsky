export interface SimilarityItem {
  id: string;
  score: number;
  metadata?: Record<string, any>;
}

export interface SimilarityQuery {
  queryText?: string;
  subjectId?: string;
  limit?: number;
  filters?: Record<string, any>;
}

export interface SimilarityBackend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  search(query: SimilarityQuery): Promise<SimilarityItem[]>;
}
