/**
 * Post-Sync Reconciliation
 *
 * Runs near-duplicate clustering over chunks collected during a sync pass
 * and writes cluster membership metadata back to each chunk in VectorStorage.
 *
 * This populates three metadata fields on each chunk:
 *   - `clusterId`            — opaque string identifying the cluster
 *   - `clusterSize`          — total members in the cluster
 *   - `representativeChunkId`— the elected best chunk for this cluster
 *
 * Cross-source clusters (two or more distinct sourceName values) also get:
 *   - `crossSourceRedundancy: true`
 *
 * Chunks not in any multi-member cross-source cluster receive:
 *   - `crossSourceRedundancy: false`
 *
 * These fields are consumed by `knowledge.search` to populate the
 * `redundancies` slot in `KnowledgeSearchResponse`.
 */

import type { VectorStorage } from "../../storage/vector/types";
import { clusterChunks, type ClusterableChunk, DEFAULT_CLUSTERING_THRESHOLD } from "./clustering";
import { log } from "../../../utils/logger";

export interface ReconcileAfterSyncOptions {
  /**
   * Cosine similarity threshold for near-duplicate detection.
   * Default 0.92.
   */
  threshold?: number;
  /**
   * Source authority scores (source name → number).
   * Used for representative election.
   */
  sourceAuthority?: Record<string, number>;
}

/**
 * Run clustering on the chunks collected during a sync pass and write cluster
 * metadata back to each chunk via `vectorStorage.store`.
 *
 * @param chunks   — The chunks embedded during this sync pass (id + vector + metadata).
 *                   Typically collected by `runSync` immediately after embedding.
 * @param storage  — Vector storage, used to write updated metadata.
 * @param opts     — Optional tuning (threshold, authority map).
 */
export async function reconcileAfterSync(
  chunks: Array<ClusterableChunk & { vector: number[]; existingMetadata: Record<string, unknown> }>,
  storage: VectorStorage,
  opts?: ReconcileAfterSyncOptions
): Promise<void> {
  if (chunks.length === 0) return;

  const threshold = opts?.threshold ?? DEFAULT_CLUSTERING_THRESHOLD;
  const sourceAuthority = opts?.sourceAuthority ?? {};

  log.debug(`[reconcileAfterSync] Clustering ${chunks.length} chunks (threshold=${threshold})`);

  const groups = clusterChunks(chunks, { threshold, sourceAuthority });

  // Build a lookup: chunkId → cluster group index
  const idToGroup = new Map<string, (typeof groups)[number]>();
  for (const group of groups) {
    for (const memberId of group.members) {
      idToGroup.set(memberId, group);
    }
  }

  // Write updated metadata back
  let updated = 0;
  for (const chunk of chunks) {
    const group = idToGroup.get(chunk.id);
    if (!group) continue; // should not happen

    const clusterId = group.representative; // use representative ID as stable cluster key
    const clusterMetadata: Record<string, unknown> = {
      clusterId,
      clusterSize: group.members.length,
      representativeChunkId: group.representative,
      crossSourceRedundancy: group.crossSourceRedundancy,
    };

    const updatedMetadata = { ...chunk.existingMetadata, ...clusterMetadata };

    try {
      await storage.store(chunk.id, chunk.vector, updatedMetadata);
      updated++;
    } catch (err) {
      log.warn(
        `[reconcileAfterSync] Failed to update cluster metadata for chunk "${chunk.id}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  log.debug(`[reconcileAfterSync] Updated cluster metadata for ${updated}/${chunks.length} chunks`);
}
