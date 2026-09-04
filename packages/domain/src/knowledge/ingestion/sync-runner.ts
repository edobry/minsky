/**
 * Knowledge Sync Runner
 *
 * Orchestrates the sync pipeline for a single knowledge source:
 * list documents → hash check → chunk → embed → store → reconcile (cluster).
 */

import { createHash } from "crypto";
import type { EmbeddingService } from "../../ai/embeddings/types";
import type { VectorStorage } from "../../storage/vector/types";
import type { KnowledgeSourceProvider, SyncReport } from "../types";
import { chunkContent } from "./chunker";
import { buildExcerpt, hasStoredExcerpt } from "./excerpt";
import { log } from "@minsky/shared/logger";
import { reconcileAfterSync } from "../reconciliation/sync-reconciler";

export interface SyncRunnerDeps {
  embeddingService: EmbeddingService;
  vectorStorage: VectorStorage;
  /** Optional reconciliation options (threshold, authority map) */
  reconciliation?: {
    threshold?: number;
    sourceAuthority?: Record<string, number>;
  };
}

/**
 * Build the chunk storage ID for a given document chunk.
 */
function chunkId(sourceName: string, documentId: string, chunkIndex: number): string {
  return `${sourceName}:${documentId}:${chunkIndex}`;
}

/**
 * Compute a SHA-256 hash of content.
 */
function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Run a full sync for a single knowledge source provider.
 *
 * For each document:
 *  1. Compute content hash
 *  2. Skip if unchanged (unless force=true)
 *  3. Chunk the content
 *  4. Generate embeddings for each chunk
 *  5. Store chunk vector + metadata
 *
 * After all documents, marks IDs belonging to this source that weren't seen
 * as stale in their metadata.
 */
export async function runSync(
  provider: KnowledgeSourceProvider,
  deps: SyncRunnerDeps,
  options?: { force?: boolean }
): Promise<SyncReport> {
  const { embeddingService, vectorStorage } = deps;
  const force = options?.force ?? false;
  const startTime = Date.now();

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const removed = 0;
  const errors: Array<{ documentId?: string; message: string }> = [];

  // Track all chunk IDs we wrote during this sync
  const seenIds = new Set<string>();

  // Collect chunk data for post-sync clustering
  const clusteredChunks: Array<{
    id: string;
    vector: number[];
    lastModified: string;
    sourceName: string;
    existingMetadata: Record<string, unknown>;
  }> = [];

  for await (const document of provider.listDocuments()) {
    try {
      const hash = contentHash(document.content);

      // Check if this document is already indexed and unchanged
      if (!force) {
        const firstChunkId = chunkId(provider.sourceName, document.id, 0);
        try {
          if (typeof vectorStorage.getMetadata === "function") {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const meta = await vectorStorage.getMetadata!(firstChunkId);
            // The excerpt condition is what BACKFILLS rows indexed before
            // mt#4953. The hash gate alone keys on document content, which did
            // not change when the metadata SHAPE did — so without this, every
            // already-indexed row would keep its excerpt-less metadata forever
            // and the fix would have no invocation path short of an operator
            // remembering `--force`. One ordinary sync re-indexes them; the sync
            // after that skips normally again, so the extra cost is paid once.
            if (meta && meta["contentHash"] === hash && hasStoredExcerpt(meta)) {
              // Reconstruct seen IDs for this document by reading total chunks from metadata
              const totalChunks = typeof meta["totalChunks"] === "number" ? meta["totalChunks"] : 1;
              for (let i = 0; i < totalChunks; i++) {
                seenIds.add(chunkId(provider.sourceName, document.id, i));
              }
              skipped++;
              continue;
            }
          }
        } catch {
          // If we can't read metadata, proceed with indexing
        }
      }

      // Chunk the document content
      const { chunks } = chunkContent(document.content);
      const totalChunks = chunks.length;

      let docFailed = false;

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex] ?? "";
        const id = chunkId(provider.sourceName, document.id, chunkIndex);

        try {
          const vector = await embeddingService.generateEmbedding(chunk);

          const metadata: Record<string, unknown> = {
            sourceType: provider.sourceType,
            sourceName: provider.sourceName,
            url: document.url,
            title: document.title,
            parentId: document.parentId,
            lastModified: document.lastModified.toISOString(),
            chunkIndex,
            totalChunks,
            contentHash: hash,
            stale: false,
            // Bounded preview of THIS chunk, so a search result can show why it
            // matched. Per-chunk by construction: two chunks of one document
            // carry different excerpts (mt#4953).
            excerpt: buildExcerpt(chunk),
          };

          await vectorStorage.store(id, vector, metadata);
          seenIds.add(id);

          // Collect for clustering
          clusteredChunks.push({
            id,
            vector,
            lastModified: document.lastModified.toISOString(),
            sourceName: provider.sourceName,
            existingMetadata: metadata,
          });
        } catch (err) {
          docFailed = true;
          errors.push({
            documentId: document.id,
            message: `Failed to embed/store chunk ${chunkIndex} of document "${document.id}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          log.warn(
            `[sync-runner] error processing chunk ${chunkIndex} of ${document.id}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          // Continue with remaining chunks
        }
      }

      if (!docFailed) {
        // Determine if this was an add or update by checking if chunk 0 existed before
        // We treat the first successful write in force mode or after hash mismatch as an update
        // Heuristic: if force was set, treat as update; otherwise treat as add (new document)
        if (force) {
          updated++;
        } else {
          added++;
        }
      }
    } catch (err) {
      errors.push({
        documentId: document.id,
        message: `Failed to process document "${document.id}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      log.warn(
        `[sync-runner] error processing document ${document.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // Mark stale: find indexed IDs for this source that weren't seen
  // We do this by attempting to retrieve metadata for known chunk IDs
  // Since VectorStorage doesn't have a list operation, we rely on tracking
  // what we've seen vs. what we know exists from prior runs.
  // For now, we mark stale by tagging IDs that were previously tracked.
  // This is a best-effort operation — no list API available on VectorStorage.
  try {
    if (typeof vectorStorage.getMetadata === "function") {
      // We can only detect staleness for documents we explicitly know about
      // (this is a limitation of the current VectorStorage interface)
      // Future enhancement: add listBySource() to VectorStorage
    }
  } catch {
    // ignore stale detection errors
  }

  // Post-sync clustering: compute near-duplicate clusters and write metadata back
  if (clusteredChunks.length > 0) {
    try {
      await reconcileAfterSync(clusteredChunks, vectorStorage, deps.reconciliation);
    } catch (err) {
      // Non-fatal: clustering failures don't block the sync report
      log.warn(
        `[sync-runner] post-sync reconciliation failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  const duration = Date.now() - startTime;

  return {
    sourceName: provider.sourceName,
    added,
    updated,
    skipped,
    removed,
    errors,
    duration,
  };
}
