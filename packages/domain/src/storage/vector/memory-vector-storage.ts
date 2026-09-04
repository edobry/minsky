import type { VectorStorage, SearchResult, SearchOptions } from "./types";
import { elementAt } from "@minsky/shared/array-safety";

/**
 * The in-memory `VectorStorage`. ADR-018 §Shape 2 designates this the faithful
 * counterpart of `PostgresVectorStorage`, and makes that argument about the
 * DISTANCE metric — its L2 matches Postgres's default `<->`.
 *
 * **`search()` returning `metadata` is a second fidelity property, and it was
 * unilateral for four months (mt#4948).** This class has always populated the
 * field; `PostgresVectorStorage` never selected the column, so a unit test
 * written against this fake asserted a metadata round-trip, passed, and said
 * nothing about production. That is how the defect survived from mt#1930 —
 * which fixed the WRITE side of the same column — until `knowledge search`
 * became the first consumer to read the field and rendered blank results.
 *
 * So: if you change whether or how this returns `metadata`, change
 * `PostgresVectorStorage` in the same commit. `postgres-vector-storage.test.ts`
 * asserts the two agree on a stored object, and that test exists precisely
 * because a divergence here is invisible to every test that uses only one of
 * them.
 */
export class MemoryVectorStorage implements VectorStorage {
  private readonly dimension: number;
  private readonly storeMap = new Map<
    string,
    { vector: number[]; metadata?: Record<string, unknown> }
  >();

  constructor(dimension: number) {
    this.dimension = dimension;
  }

  async store(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
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
            if (key.endsWith("Exclude") && Array.isArray(value) && value.length > 0) {
              const columnName = key.replace("Exclude", "");
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
      const d =
        elementAt(a, i, "memory-vector-storage l2 a") -
        elementAt(b, i, "memory-vector-storage l2 b");
      s += d * d;
    }
    return Math.sqrt(s);
  }
}
