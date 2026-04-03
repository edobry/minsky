export interface SearchResult {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
  filters?: Record<string, unknown>;
}

export interface VectorStorage {
  store(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>;
  search(queryVector: number[], options?: SearchOptions): Promise<SearchResult[]>;
  delete(id: string): Promise<void>;
  getMetadata?(id: string): Promise<Record<string, unknown> | null>;
}
