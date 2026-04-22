/**
 * Authority-Based Ranking
 *
 * Re-sorts a chunk list by (sourceAuthority desc, score desc) using an epsilon
 * tiebreak: only when two chunks' scores are within epsilon does source authority
 * become the deciding factor.
 *
 * This produces the `authority` field in `KnowledgeSearchResponse` without
 * touching `chunks` (which stays in pure relevance order).
 */

import type { ChunkId, ChunkResult } from "../types";

export interface AuthorityRankerConfig {
  /**
   * Map from source name to authority score.
   * Higher number = higher authority.
   * Sources not listed default to 0.
   */
  sourceAuthority: Record<string, number>;
  /**
   * Maximum relevance score delta within which authority tiebreaking applies.
   * Default 0.05.
   */
  epsilon: number;
}

export const DEFAULT_AUTHORITY_RANKER_CONFIG: AuthorityRankerConfig = {
  sourceAuthority: {},
  epsilon: 0.05,
};

/**
 * Return the authority score for a given source name.
 * Unlisted sources default to 0.
 */
function getAuthority(sourceName: string, authorityMap: Record<string, number>): number {
  return authorityMap[sourceName] ?? 0;
}

/**
 * Re-sort `chunks` by (sourceAuthority desc, score desc) using epsilon tiebreaking.
 *
 * Algorithm:
 *   For each pair (a, b), compare scores first:
 *     - If |a.score - b.score| > epsilon → the higher-scoring chunk wins (pure relevance)
 *     - If |a.score - b.score| <= epsilon → the higher-authority source wins
 *       (ties in authority are broken by score, then by chunk ID for stability)
 *
 * @param chunks - Chunks in relevance order (highest score first)
 * @param config - Authority map + epsilon; defaults are applied per field
 * @returns A new array of `ChunkId`s in authority-first order
 */
export function rankByAuthority(
  chunks: ChunkResult[],
  config?: Partial<AuthorityRankerConfig>
): ChunkId[] {
  const authorityMap = config?.sourceAuthority ?? DEFAULT_AUTHORITY_RANKER_CONFIG.sourceAuthority;
  const epsilon = config?.epsilon ?? DEFAULT_AUTHORITY_RANKER_CONFIG.epsilon;

  const sorted = [...chunks].sort((a, b) => {
    const scoreDelta = Math.abs(a.score - b.score);
    if (scoreDelta > epsilon) {
      // Outside epsilon: pure relevance ordering (higher score first)
      return b.score - a.score;
    }
    // Within epsilon: authority tiebreak
    const authorityDelta =
      getAuthority(b.source, authorityMap) - getAuthority(a.source, authorityMap);
    if (authorityDelta !== 0) {
      return authorityDelta;
    }
    // Same authority: fall back to score, then ID for stability
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return sorted.map((c) => c.id);
}
