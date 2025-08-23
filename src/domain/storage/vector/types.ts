export interface SearchResult {
  id: string;
  score: number;
  metadata?: Record<string, any>;
}

export interface VectorStorage {
  store(id: string, vector: number[], metadata?: Record<string, any>): Promise<void>;
  search(queryVector: number[], limit?: number, threshold?: number): Promise<SearchResult[]>;
  delete(id: string): Promise<void>;
  getMetadata?(id: string): Promise<Record<string, any> | null>;
}
