import type { VectorStorage, SearchResult } from "./types";

export class MemoryVectorStorage implements VectorStorage {
  private readonly dimension: number;
  private readonly storeMap = new Map<string, { vector: number[]; metadata?: Record<string, any> }>();

  constructor(dimension: number) {
    this.dimension = dimension;
  }

  async store(id: string, vector: number[], metadata?: Record<string, any>): Promise<void> {
    if (vector.length !== this.dimension) {
      throw new Error(`Vector dimension mismatch: expected ${this.dimension}, got ${vector.length}`);
    }
    this.storeMap.set(id, { vector, metadata });
  }

  async search(queryVector: number[], limit = 10, threshold = Number.POSITIVE_INFINITY): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    for (const [id, { vector }] of this.storeMap.entries()) {
      const score = this.l2(queryVector, vector);
      results.push({ id, score });
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
