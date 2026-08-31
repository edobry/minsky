/**
 * Memory-surface re-export of the shared L2-distance ↔ cosine-similarity conversion.
 *
 * ---------------------------------------------------------------------------
 * Why this file is now a shim
 * ---------------------------------------------------------------------------
 * mt#4787 introduced these functions HERE, in the memory domain, and said so
 * explicitly: the shared vector layer could not convert, because three other
 * consumers (`task-similarity-service`, `tool-similarity-service`, and the
 * in-memory `memory-vector-storage` fake) read that layer's `score` AS a
 * distance, and converting there would have inverted all three silently. It
 * named the wider disagreement as mt#4805.
 *
 * mt#4805 resolved it, and the resolution is why the functions moved. The
 * conversion now happens once, in `EmbeddingsSimilarityBackend` — the
 * DOMAIN-SIDE boundary above the shared store, not inside it. That placement is
 * what ADR-013 requires: `PostgresVectorStorage` backs rules, tools, tasks,
 * transcripts, memory and the principal corpus, so it stays domain-agnostic and
 * keeps emitting a raw distance, and its own `score <= threshold` filter remains
 * correct distance semantics. The two consumers that read it as a similarity
 * were the ones that were wrong.
 *
 * The memory path is unaffected by that change and still converts here:
 * `MemoryService` reads `VectorStorage` DIRECTLY rather than through the
 * similarity-backend abstraction, so there is no double conversion. This file
 * stays so that `memory-service.ts`, `memory/index.ts` and the mt#4787 test
 * suite keep importing from where they always did.
 *
 * The measured unit-vector precondition, the pgvector cross-check, and the
 * per-namespace norm table live with the implementation.
 *
 * @see {@link ../similarity/similarity-score.ts}
 */

export {
  l2DistanceToSimilarity,
  similarityToL2Distance,
  COSINE_ZERO_CROSSING_L2,
} from "../similarity/similarity-score";
