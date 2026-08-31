/**
 * Conversion between the vector store's L2 DISTANCE and a cosine SIMILARITY
 * (mt#4787).
 *
 * ---------------------------------------------------------------------------
 * The defect this exists to close
 * ---------------------------------------------------------------------------
 * `PostgresVectorStorage.search()` selects `(vector <-> $1::vector) AS score`.
 * `<->` is pgvector's **L2 (Euclidean) distance** operator, so `score` is a
 * DISTANCE: smaller means nearer, and the accompanying `ORDER BY` makes the
 * result nearest-first. Every layer above it, however, was written as though
 * the number were a similarity:
 *
 * - `MemoryDetail.tsx` and `MemorySearch.tsx` render `(score * 100).toFixed(0)%`
 * - `memory-enrichment.ts` builds `— score 0.62` into the block agents read
 * - the `memory.search` command describes itself as returning "ranked results
 *   with similarity scores", and its `threshold` param as a "Minimum similarity
 *   score threshold"
 *
 * So the DOCUMENTED contract was already similarity; the implementation had
 * diverged from it. Converting here makes the code match what it already
 * claimed, rather than changing a contract. Observed live before the fix: the
 * closest neighbour of `mem#1344` displayed **62%** where its true cosine
 * similarity is **81%** — the best match showing the smallest number.
 *
 * ---------------------------------------------------------------------------
 * Why the conversion is exact, and what it depends on
 * ---------------------------------------------------------------------------
 * For UNIT-LENGTH vectors, `d² = |a-b|² = 2 - 2·cos(a,b)`, hence
 * `cos = 1 - d²/2`. That precondition holds here and was measured, not assumed:
 * over 500 live rows of `memories_embeddings`, vector norms ran 0.999359 to
 * 1.000706 (mean 1.000029) — unit length to within float32 rounding, which is
 * what the embedding model produces.
 *
 * Verified against pgvector's OWN cosine operator rather than trusted as
 * algebra. Top neighbours of `mem#1344`, 2026-08-31:
 *
 * | L2 `score` | `1 - (a <=> b)` | `1 - d²/2` |
 * | ---------- | --------------- | ---------- |
 * | 0.6159     | 0.8104          | 0.8103     |
 * | 0.6707     | 0.7751          | 0.7751     |
 * | 0.6833     | 0.7665          | 0.7666     |
 * | 0.6898     | 0.7620          | 0.7621     |
 *
 * Agreement to four decimals; the residual is float32 rounding.
 *
 * **This conversion is therefore NOT valid for a namespace whose vectors are
 * not normalized.** It lives in the memory domain, not in the shared vector
 * layer, for that reason and for a second one: three other consumers
 * (`task-similarity-service`, `tool-similarity-service`, and the in-memory
 * `memory-vector-storage` fake) read the shared layer's `score` AS a distance,
 * and converting there would invert all three silently. The wider disagreement
 * between those consumers is mt#4805.
 */

/**
 * The L2 distance at which cosine similarity crosses zero, for unit vectors:
 * `cos = 0` when `d² = 2`, i.e. `d = √2`.
 */
const L2_AT_ZERO_SIMILARITY = Math.SQRT2;

/**
 * Convert an L2 distance between unit vectors into a cosine similarity.
 *
 * Returns a value in **[0, 1]**, higher meaning more similar — the direction
 * every display site already assumed.
 *
 * ## On the clamp
 *
 * True cosine similarity ranges [-1, 1], and this clamps the negative half to
 * 0. That is a GUARD, not a normal path, and the distinction is measured: over
 * 1,109 live pairs the maximum observed L2 distance was **1.2059**, against the
 * {@link L2_AT_ZERO_SIMILARITY} threshold of 1.4142 — **zero** pairs had a
 * negative cosine. Text embeddings from this model occupy a cone well inside
 * the positive half-space, so the clamp should never fire on real data; it
 * exists so that a corpus which someday violates that assumption renders 0%
 * rather than a negative percentage, which is not a meaningful thing to show.
 *
 * A caller that needs the true signed cosine should not use this function.
 */
export function l2DistanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance) || distance < 0) return 0;
  const cosine = 1 - (distance * distance) / 2;
  if (cosine <= 0) return 0;
  return cosine >= 1 ? 1 : cosine;
}

/**
 * The inverse: convert a minimum-similarity threshold into the maximum L2
 * distance that satisfies it.
 *
 * Needed because `VectorStorage.search`'s `threshold` is applied as
 * `score <= threshold` — a maximum DISTANCE — while `MemorySearchOptions.threshold`
 * is documented (and described on the `memory.search` command) as a minimum
 * SIMILARITY. Converting the returned score without also converting the
 * threshold would leave the filter disagreeing with the number displayed
 * beside it.
 *
 * `s = 1 - d²/2`  ⇒  `d = √(2 - 2s)`.
 *
 * A similarity at or below 0 admits everything, so it maps to the maximum
 * distance two unit vectors can be apart (2). A similarity at or above 1 admits
 * only exact matches, so it maps to 0.
 */
export function similarityToL2Distance(similarity: number): number {
  if (!Number.isFinite(similarity)) return 2;
  if (similarity <= 0) return 2;
  if (similarity >= 1) return 0;
  return Math.sqrt(2 - 2 * similarity);
}

/** Exported for the test that pins the zero-crossing the clamp is defined by. */
export const COSINE_ZERO_CROSSING_L2 = L2_AT_ZERO_SIMILARITY;
