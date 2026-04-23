/**
 * Redundancy Reader
 *
 * Reads cluster membership metadata written by `reconcileAfterSync` from
 * vector search results and converts it into the `ChunkRedundancy[]` shape
 * expected in `KnowledgeSearchResponse.redundancies`.
 *
 * Only cross-source clusters are surfaced (crossSourceRedundancy === true).
 * Single-source clusters (same content duplicated within one source) are
 * silently skipped — they're wasteful but not misleading.
 */

import type { ChunkId, ChunkRedundancy } from "../types";
import type { SearchResult } from "../../storage/vector/types";

/**
 * Build the `redundancies` array for a `KnowledgeSearchResponse` from the
 * raw `SearchResult[]` returned by `VectorStorage.search`.
 *
 * Algorithm:
 *  1. For each result that has `crossSourceRedundancy: true` metadata, group
 *     by `representativeChunkId` (the stable cluster key written by reconciler).
 *  2. For each group, emit one `ChunkRedundancy` entry:
 *     - `cluster`:        all chunk IDs in the group (from these search results)
 *     - `representative`: the elected representative chunk ID
 *
 * NOTE: The cluster list only reflects chunks that appeared in the current
 * search result set, not the full cluster across the entire index.  This is
 * by design — at query time we surface only the redundancies that are relevant
 * to the user's query.
 */
export function buildRedundanciesFromMetadata(results: SearchResult[]): ChunkRedundancy[] {
  // Group results by representative chunk ID (cluster key)
  const clusterMap = new Map<ChunkId, ChunkId[]>();

  for (const result of results) {
    const isCrossSource = result.metadata?.["crossSourceRedundancy"];
    if (!isCrossSource) continue;

    const representative = result.metadata?.["representativeChunkId"];
    if (typeof representative !== "string") continue;

    const existing = clusterMap.get(representative);
    if (existing) {
      existing.push(result.id);
    } else {
      clusterMap.set(representative, [result.id]);
    }
  }

  // Emit only clusters with ≥2 members visible in these results
  const redundancies: ChunkRedundancy[] = [];
  for (const [representative, members] of clusterMap.entries()) {
    if (members.length < 2) continue;
    redundancies.push({ cluster: members, representative });
  }

  return redundancies;
}
