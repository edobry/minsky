import { describe, it, expect } from "bun:test";
import { rankByAuthority } from "./authority-ranker";
import type { ChunkResult } from "../types";

function makeChunk(
  id: string,
  source: string,
  score: number,
  extra?: Partial<ChunkResult>
): ChunkResult {
  return {
    id,
    title: `Title ${id}`,
    excerpt: "...",
    url: `https://example.com/${id}`,
    source,
    score,
    ...extra,
  };
}

describe("rankByAuthority", () => {
  describe("within-epsilon tiebreaking", () => {
    it("prefers higher-authority source when scores are within epsilon", () => {
      const chunks = [
        makeChunk("chunk-A", "low-authority", 0.82),
        makeChunk("chunk-B", "high-authority", 0.83),
      ];
      const result = rankByAuthority(chunks, {
        sourceAuthority: { "high-authority": 10, "low-authority": 2 },
        epsilon: 0.05,
      });
      // Both scores within 0.05 of each other → higher authority first
      expect(result[0]).toBe("chunk-B");
      expect(result[1]).toBe("chunk-A");
    });

    it("preserves relevance order when chunk from high-authority source has higher score too", () => {
      const chunks = [
        makeChunk("chunk-A", "low-authority", 0.7),
        makeChunk("chunk-B", "high-authority", 0.9),
      ];
      const result = rankByAuthority(chunks, {
        sourceAuthority: { "high-authority": 10, "low-authority": 2 },
        epsilon: 0.05,
      });
      // Score delta > epsilon → pure relevance
      expect(result[0]).toBe("chunk-B");
      expect(result[1]).toBe("chunk-A");
    });
  });

  describe("outside-epsilon relevance ordering", () => {
    it("uses score ordering when delta > epsilon, ignoring authority", () => {
      // high-authority source but much lower score
      const chunks = [
        makeChunk("chunk-A", "low-authority", 0.95),
        makeChunk("chunk-B", "high-authority", 0.7),
      ];
      const result = rankByAuthority(chunks, {
        sourceAuthority: { "high-authority": 100, "low-authority": 0 },
        epsilon: 0.05,
      });
      // Score delta 0.25 > 0.05 → relevance wins
      expect(result[0]).toBe("chunk-A");
      expect(result[1]).toBe("chunk-B");
    });

    it("two chunks from same source: higher score first", () => {
      const chunks = [makeChunk("chunk-A", "source-A", 0.8), makeChunk("chunk-B", "source-A", 0.9)];
      const result = rankByAuthority(chunks, { sourceAuthority: {}, epsilon: 0.05 });
      expect(result[0]).toBe("chunk-B");
      expect(result[1]).toBe("chunk-A");
    });
  });

  describe("unlisted source defaults to 0", () => {
    it("unlisted source treated as authority=0", () => {
      const chunks = [
        makeChunk("chunk-A", "unlisted-source", 0.82),
        makeChunk("chunk-B", "known-source", 0.83),
      ];
      const result = rankByAuthority(chunks, {
        sourceAuthority: { "known-source": 5 },
        epsilon: 0.05,
      });
      // unlisted defaults to 0; known-source=5 → chunk-B first
      expect(result[0]).toBe("chunk-B");
      expect(result[1]).toBe("chunk-A");
    });

    it("two unlisted sources sort by score", () => {
      const chunks = [
        makeChunk("chunk-A", "unlisted-1", 0.82),
        makeChunk("chunk-B", "unlisted-2", 0.83),
      ];
      const result = rankByAuthority(chunks, {
        sourceAuthority: {},
        epsilon: 0.05,
      });
      // Both authority=0, both within epsilon → fall back to score
      expect(result[0]).toBe("chunk-B");
      expect(result[1]).toBe("chunk-A");
    });
  });

  describe("empty and single-element cases", () => {
    it("returns [] for empty input", () => {
      expect(rankByAuthority([])).toEqual([]);
    });

    it("returns the single chunk ID for single-element input", () => {
      const chunks = [makeChunk("chunk-A", "source-A", 0.9)];
      expect(rankByAuthority(chunks)).toEqual(["chunk-A"]);
    });
  });

  describe("default config", () => {
    it("uses epsilon=0.05 and all-zero authority by default", () => {
      const chunks = [
        makeChunk("chunk-A", "source-A", 0.8),
        makeChunk("chunk-B", "source-B", 0.79),
      ];
      // No config → no authority map → both auth=0, within default epsilon=0.05 → fall back to score
      const result = rankByAuthority(chunks);
      expect(result[0]).toBe("chunk-A");
    });
  });

  describe("stability", () => {
    it("sorts by ID when all else is equal (deterministic output)", () => {
      const chunks = [makeChunk("chunk-Z", "source-A", 0.8), makeChunk("chunk-A", "source-A", 0.8)];
      const result = rankByAuthority(chunks, { sourceAuthority: {}, epsilon: 0.05 });
      // Same score, same authority → sort by ID ascending
      expect(result[0]).toBe("chunk-A");
      expect(result[1]).toBe("chunk-Z");
    });
  });
});
