import type { VectorStorage, SearchResult, SearchOptions } from "./types";

export class MemoryVectorStorage implements VectorStorage {
  private readonly dimension: number;
  private readonly storeMap = new Map<
    string,
    { vector: number[]; metadata?: Record<string, any> }
  >();

  constructor(dimension: number) {
    this.dimension = dimension;
  }

  async store(id: string, vector: number[], metadata?: Record<string, any>): Promise<void> {
    if (vector.length !== this.dimension) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimension}, got ${vector.length}`
      );
    }
    this.storeMap.set(id, { vector, metadata });
  }

  async search(queryVector: number[], options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 10, threshold = Number.POSITIVE_INFINITY, filters } = options;

    const results: SearchResult[] = [];
    for (const [id, { vector, metadata }] of this.storeMap.entries()) {
      // Apply filters if provided (post-filter fallback for memory backend)
      if (filters && Object.keys(filters).length > 0) {
        let shouldInclude = true;
        for (const [key, value] of Object.entries(filters)) {
          if (value !== undefined && value !== null) {
            // Handle exclusion filters (e.g., statusExclude: ['DONE', 'CLOSED'])
            if (key.endsWith('Exclude') && Array.isArray(value) && value.length > 0) {
              const columnName = key.replace('Exclude', '');
              if (metadata && value.includes(metadata[columnName])) {
                shouldInclude = false;
                break;
              }
            } else {
              // Handle regular equality filters (e.g., status: 'TODO')
              if (!metadata || metadata[key] !== value) {
                shouldInclude = false;
                break;
              }
            }
          }
        }
        if (!shouldInclude) continue;
      }

      const score = this.l2(queryVector, vector);
      results.push({ id, score, metadata });
    }
    results.sort((a, b) => a.score - b.score);
    return results.filter((r) => r.score <= threshold).slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    this.storeMap.delete(id);
  }

  private l2(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const d = a[i] - b[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }
}
