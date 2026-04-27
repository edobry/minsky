/**
 * Unit tests for near-duplicate clustering helpers.
 *
 * All fixtures are deterministic (no real embeddings, no I/O).
 */

import { describe, it, expect } from "bun:test";
import {
  cosineSimilarity,
  clusterChunks,
  buildRedundancies,
  DEFAULT_CLUSTERING_THRESHOLD,
  type ClusterableChunk,
} from "./clustering";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeChunk(
  id: string,
  sourceName: string,
  vector: number[],
  lastModified = "2024-01-01T00:00:00.000Z"
): ClusterableChunk {
  return { id, sourceName, vector, lastModified };
}

// Normalised vectors for deterministic cosine similarity
const V_A = [1, 0, 0]; // unit x
const V_B = [0, 1, 0]; // unit y — orthogonal to V_A
const V_NEAR_A = [0.999, 0.045, 0]; // very close to V_A, sim ≈ 0.999
const V_NEAR_A2 = [0.998, 0.063, 0]; // also close to V_A, sim ≈ 0.998

// ─── cosineSimilarity ─────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(V_A, V_B)).toBeCloseTo(0, 5);
  });

  it("returns 0 for zero-length vector (degenerate)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("is commutative", () => {
    const sim1 = cosineSimilarity([1, 2], [3, 4]);
    const sim2 = cosineSimilarity([3, 4], [1, 2]);
    expect(sim1).toBeCloseTo(sim2, 10);
  });

  it("clamps to [0, 1] range", () => {
    const sim = cosineSimilarity(V_NEAR_A, V_A);
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it("near-duplicate vectors have similarity above threshold", () => {
    expect(cosineSimilarity(V_NEAR_A, V_A)).toBeGreaterThanOrEqual(DEFAULT_CLUSTERING_THRESHOLD);
  });
});

// ─── clusterChunks ────────────────────────────────────────────────────────────

describe("clusterChunks", () => {
  it("returns [] for empty input", () => {
    expect(clusterChunks([])).toEqual([]);
  });

  it("returns a single-member cluster for one chunk", () => {
    const result = clusterChunks([makeChunk("c1", "source-a", V_A)]);
    expect(result).toHaveLength(1);
    expect(result[0]?.members).toEqual(["c1"]);
    expect(result[0]?.representative).toBe("c1");
    expect(result[0]?.crossSourceRedundancy).toBe(false);
  });

  it("groups near-duplicate chunks from same source into one cluster", () => {
    const chunks = [makeChunk("c1", "source-a", V_A), makeChunk("c2", "source-a", V_NEAR_A)];
    const result = clusterChunks(chunks, { threshold: 0.92 });
    expect(result).toHaveLength(1);
    expect(result[0]?.members).toHaveLength(2);
    expect(result[0]?.crossSourceRedundancy).toBe(false);
  });

  it("keeps orthogonal chunks in separate clusters", () => {
    const chunks = [makeChunk("c1", "source-a", V_A), makeChunk("c2", "source-b", V_B)];
    const result = clusterChunks(chunks, { threshold: 0.92 });
    expect(result).toHaveLength(2);
  });

  it("sets crossSourceRedundancy=true when cluster spans ≥2 sources", () => {
    const chunks = [
      makeChunk("c1", "source-a", V_A),
      makeChunk("c2", "source-b", V_NEAR_A), // same content, different source
    ];
    const result = clusterChunks(chunks, { threshold: 0.92 });
    expect(result).toHaveLength(1);
    expect(result[0]?.crossSourceRedundancy).toBe(true);
  });

  it("merges transitively: A≈B and B≈C → {A,B,C}", () => {
    const chunks = [
      makeChunk("c1", "source-a", V_A),
      makeChunk("c2", "source-b", V_NEAR_A),
      makeChunk("c3", "source-c", V_NEAR_A2),
    ];
    const result = clusterChunks(chunks, { threshold: 0.92 });
    // All three should merge since c1≈c2, c2≈c3, and transitively c1≈c3
    const bigCluster = result.find((g) => g.members.length === 3);
    expect(bigCluster).toBeDefined();
  });

  it("respects threshold: chunks just below threshold stay separate", () => {
    const chunks = [
      makeChunk("c1", "source-a", V_A),
      makeChunk("c2", "source-b", V_B), // cosine sim = 0
    ];
    // Very high threshold — nothing should merge
    const result = clusterChunks(chunks, { threshold: 0.999 });
    expect(result).toHaveLength(2);
  });

  it("threshold=0 merges everything (degenerate)", () => {
    const chunks = [makeChunk("c1", "source-a", V_A), makeChunk("c2", "source-b", V_B)];
    const result = clusterChunks(chunks, { threshold: 0 });
    expect(result).toHaveLength(1);
  });

  describe("representative election", () => {
    it("picks the highest-authority source chunk as representative", () => {
      const chunks = [
        makeChunk("c1", "low-authority", V_A),
        makeChunk("c2", "high-authority", V_NEAR_A),
      ];
      const result = clusterChunks(chunks, {
        threshold: 0.92,
        sourceAuthority: { "high-authority": 10, "low-authority": 1 },
      });
      expect(result[0]?.representative).toBe("c2");
    });

    it("breaks authority tie with most-recent lastModified", () => {
      const older = makeChunk("c1", "source-a", V_A, "2023-01-01T00:00:00.000Z");
      const newer = makeChunk("c2", "source-a", V_NEAR_A, "2024-06-01T00:00:00.000Z");
      const result = clusterChunks([older, newer], { threshold: 0.92 });
      expect(result[0]?.representative).toBe("c2"); // newer wins
    });

    it("breaks equal-authority, equal-timestamp with ID lexicographic order", () => {
      const ts = "2024-01-01T00:00:00.000Z";
      const chunks = [
        makeChunk("z-chunk", "source-a", V_A, ts),
        makeChunk("a-chunk", "source-a", V_NEAR_A, ts),
      ];
      const result = clusterChunks(chunks, { threshold: 0.92 });
      expect(result[0]?.representative).toBe("a-chunk"); // lexicographically first
    });
  });
});

// ─── buildRedundancies ────────────────────────────────────────────────────────

describe("buildRedundancies", () => {
  it("returns [] when no cross-source duplicates", () => {
    const chunks = [
      makeChunk("c1", "source-a", V_A),
      makeChunk("c2", "source-a", V_NEAR_A), // same source — not cross-source
    ];
    const result = buildRedundancies(chunks, { threshold: 0.92 });
    expect(result).toEqual([]);
  });

  it("returns a redundancy entry for a cross-source cluster", () => {
    const chunks = [makeChunk("c1", "source-a", V_A), makeChunk("c2", "source-b", V_NEAR_A)];
    const result = buildRedundancies(chunks, { threshold: 0.92 });
    expect(result).toHaveLength(1);
    expect(result[0]?.cluster).toHaveLength(2);
    expect(result[0]?.cluster).toContain("c1");
    expect(result[0]?.cluster).toContain("c2");
    expect(result[0]?.representative).toBeDefined();
  });

  it("returns [] when chunks are empty", () => {
    expect(buildRedundancies([])).toEqual([]);
  });

  it("excludes single-member clusters from output", () => {
    const chunks = [
      makeChunk("c1", "source-a", V_A), // no near-duplicate
    ];
    const result = buildRedundancies(chunks, { threshold: 0.92 });
    expect(result).toEqual([]);
  });

  it("handles three-way cross-source redundancy", () => {
    const chunks = [
      makeChunk("c1", "source-a", V_A),
      makeChunk("c2", "source-b", V_NEAR_A),
      makeChunk("c3", "source-c", V_NEAR_A2),
    ];
    const result = buildRedundancies(chunks, { threshold: 0.92 });
    expect(result).toHaveLength(1);
    expect(result[0]?.cluster).toHaveLength(3);
  });
});
