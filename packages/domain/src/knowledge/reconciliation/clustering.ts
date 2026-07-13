/**
 * Near-Duplicate Clustering
 *
 * Agglomerative cosine-similarity clustering for knowledge chunks.
 * Groups near-duplicate chunks together so redundancies can be surfaced
 * in `KnowledgeSearchResponse.redundancies`.
 *
 * Algorithm:
 *  1. Compute pairwise cosine similarity for all chunk vectors.
 *  2. Merge any two chunks whose similarity ≥ threshold into the same cluster
 *     (single-linkage: a chunk joins a cluster if it's similar to any member).
 *  3. For each cluster, elect a representative: the chunk with the most-recent
 *     `lastModified` timestamp from the highest-authority source.
 *
 * No external deps — all math is inline (~40 LoC of helpers).
 */

import type { ChunkId, ChunkRedundancy } from "../types";

// ─── Vector math helpers ──────────────────────────────────────────────────────

/**
 * Dot product of two equal-length vectors.
 */
function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    s += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return s;
}

/**
 * Euclidean magnitude of a vector.
 */
function magnitude(v: number[]): number {
  return Math.sqrt(dot(v, v));
}

/**
 * Cosine similarity in [0, 1].
 * Returns 0 for zero-length vectors (degenerate case).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const ma = magnitude(a);
  const mb = magnitude(b);
  if (ma === 0 || mb === 0) return 0;
  return Math.max(0, Math.min(1, dot(a, b) / (ma * mb)));
}

// ─── Union-Find (disjoint-set) ────────────────────────────────────────────────

class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x] as number);
    }
    return this.parent[x] as number;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    const rankX = this.rank[rx] ?? 0;
    const rankY = this.rank[ry] ?? 0;
    if (rankX < rankY) {
      this.parent[rx] = ry;
    } else if (rankX > rankY) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx] = rankX + 1;
    }
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ClusteringOptions {
  /**
   * Cosine similarity threshold above which two chunks are considered near-duplicates.
   * Default 0.92.
   */
  threshold?: number;
  /**
   * Source authority map (source name → score). Used for representative election.
   * Higher score wins. Sources absent from the map default to 0.
   */
  sourceAuthority?: Record<string, number>;
}

export const DEFAULT_CLUSTERING_THRESHOLD = 0.92;

/** Metadata needed per chunk for clustering + representative election */
export interface ClusterableChunk {
  id: ChunkId;
  vector: number[];
  /** ISO 8601 timestamp — used to pick the freshest representative */
  lastModified: string;
  /** Source name — used for authority tiebreaking */
  sourceName: string;
}

/** Internal cluster result before filtering to cross-source only */
export interface ClusterGroup {
  /** Elected representative chunk ID */
  representative: ChunkId;
  /** All member IDs (including the representative) */
  members: ChunkId[];
  /** True when members come from ≥2 distinct sources */
  crossSourceRedundancy: boolean;
}

// ─── Core clustering algorithm ────────────────────────────────────────────────

/**
 * Cluster a list of chunks by near-duplicate cosine similarity.
 *
 * Returns ALL clusters (including single-member ones). Callers that only want
 * cross-source redundancies should filter on `crossSourceRedundancy === true`.
 *
 * Time complexity: O(n²) — acceptable for n ≤ a few thousand at sync time.
 */
export function clusterChunks(
  chunks: ClusterableChunk[],
  options?: ClusteringOptions
): ClusterGroup[] {
  const threshold = options?.threshold ?? DEFAULT_CLUSTERING_THRESHOLD;
  const authorityMap = options?.sourceAuthority ?? {};

  const n = chunks.length;
  if (n === 0) return [];

  // Build clusters with Union-Find
  const uf = new UnionFind(n);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const chunkI = chunks[i];
      const chunkJ = chunks[j];
      if (!chunkI || !chunkJ) continue;
      const sim = cosineSimilarity(chunkI.vector, chunkJ.vector);
      if (sim >= threshold) {
        uf.union(i, j);
      }
    }
  }

  // Group chunk indices by root
  const rootToIndices = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const existing = rootToIndices.get(root);
    if (existing) {
      existing.push(i);
    } else {
      rootToIndices.set(root, [i]);
    }
  }

  // Convert to ClusterGroup[]
  const groups: ClusterGroup[] = [];
  for (const indices of rootToIndices.values()) {
    const members = indices.map((i) => (chunks[i] as ClusterableChunk).id);
    const sources = new Set(indices.map((i) => (chunks[i] as ClusterableChunk).sourceName));
    const crossSourceRedundancy = sources.size >= 2;
    const representative = electRepresentative(indices, chunks, authorityMap);
    groups.push({ representative, members, crossSourceRedundancy });
  }

  return groups;
}

/**
 * Build `ChunkRedundancy[]` (the `redundancies` slot in `KnowledgeSearchResponse`)
 * from a set of chunks. Only cross-source clusters are included.
 */
export function buildRedundancies(
  chunks: ClusterableChunk[],
  options?: ClusteringOptions
): ChunkRedundancy[] {
  const groups = clusterChunks(chunks, options);
  return groups
    .filter((g) => g.crossSourceRedundancy && g.members.length > 1)
    .map((g) => ({ cluster: g.members, representative: g.representative }));
}

// ─── Representative election ──────────────────────────────────────────────────

/**
 * Pick the best representative from a cluster:
 *  1. Prefer the chunk from the highest-authority source.
 *  2. Break ties by most-recent `lastModified`.
 *  3. Break further ties by chunk ID (lexicographic, ascending) for determinism.
 */
function electRepresentative(
  indices: number[],
  chunks: ClusterableChunk[],
  authorityMap: Record<string, number>
): ChunkId {
  let bestIdx = indices[0] ?? 0;

  for (const idx of indices) {
    const current = chunks[idx];
    const best = chunks[bestIdx];
    if (!current || !best) continue;

    const currentAuth = authorityMap[current.sourceName] ?? 0;
    const bestAuth = authorityMap[best.sourceName] ?? 0;

    if (currentAuth > bestAuth) {
      bestIdx = idx;
      continue;
    }
    if (currentAuth < bestAuth) {
      continue;
    }

    // Same authority — pick freshest
    const currentTs = new Date(current.lastModified).getTime();
    const bestTs = new Date(best.lastModified).getTime();
    if (currentTs > bestTs) {
      bestIdx = idx;
      continue;
    }
    if (currentTs < bestTs) {
      continue;
    }

    // Same authority, same timestamp — stable sort by ID
    if (current.id < best.id) {
      bestIdx = idx;
    }
  }

  return (chunks[bestIdx] as ClusterableChunk).id;
}
