/**
 * Conversion between the vector store's L2 DISTANCE and a cosine SIMILARITY.
 *
 * Introduced for the memory surface by mt#4787; promoted here — into the shared
 * similarity layer — by mt#4805, which made `SimilarityItem.score` mean the SAME
 * thing for every backend. See {@link ../backends/embeddings-backend.ts}.
 *
 * ---------------------------------------------------------------------------
 * Why the conversion is exact, and what it depends on
 * ---------------------------------------------------------------------------
 * `PostgresVectorStorage.search()` selects `(vector <-> $1::vector) AS score`.
 * `<->` is pgvector's **L2 (Euclidean) distance** operator, so the stored-layer
 * `score` is a DISTANCE: smaller means nearer.
 *
 * For UNIT-LENGTH vectors, `d² = |a-b|² = 2 - 2·cos(a,b)`, hence
 * `cos = 1 - d²/2`.
 *
 * That precondition is MEASURED, not assumed, and it must be re-measured for any
 * namespace newly routed through this conversion. Norms observed live
 * (`vector <-> zero`, which is the L2 norm):
 *
 * | namespace            | rows  | min norm  | max norm  | measured   |
 * | -------------------- | ----- | --------- | --------- | ---------- |
 * | `memories_embeddings`| 500   | 0.999359  | 1.000706  | 2026-08-31 |
 * | `tool_embeddings`    | 72    | 0.9999998 | 1.0000001 | 2026-08-31 |
 * | `rules_embeddings`   | 71    | 1.000000  | 1.000000  | 2026-08-31 |
 * | `tasks_embeddings`   | 4699  | 0.694512  | 1.000769  | 2026-08-31 |
 *
 * The `tasks_embeddings` minimum is NOT a counter-example to the precondition —
 * it is three corrupt rows out of 4,699 (0.06%: mt#4592, mt#4593, mt#4594, all
 * written inside one four-minute indexing run on 2026-08-25). The 1st percentile
 * is 0.9995. Those three rows already produced distorted DISTANCES and therefore
 * distorted ranking before this conversion existed; the conversion neither
 * causes nor worsens that, and {@link l2DistanceToSimilarity}'s clamp keeps them
 * in range rather than emitting a negative similarity. Tracked at mt#4831.
 *
 * Verified against pgvector's OWN cosine operator rather than trusted as algebra.
 * Top neighbours of `mem#1344`, 2026-08-31:
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
 * **This conversion is NOT valid for a namespace whose vectors are not
 * normalized.** Before routing a new namespace through the embeddings backend,
 * measure its norms and add a row to the table above.
 */

/**
 * The L2 distance at which cosine similarity crosses zero, for unit vectors:
 * `cos = 0` when `d² = 2`, i.e. `d = √2`.
 */
const L2_AT_ZERO_SIMILARITY = Math.SQRT2;

/**
 * Convert an L2 distance between unit vectors into a cosine similarity.
 *
 * Returns a value in **[0, 1]**, higher meaning more similar.
 *
 * ## On the clamp
 *
 * True cosine similarity ranges [-1, 1], and this clamps the negative half to
 * 0. That is a GUARD, not a normal path, and the distinction is measured: over
 * 1,109 live memory pairs the maximum observed L2 distance was **1.2059**, against
 * the {@link L2_AT_ZERO_SIMILARITY} threshold of 1.4142 — **zero** pairs had a
 * negative cosine. Text embeddings from this model occupy a cone well inside
 * the positive half-space, so the clamp should never fire on real data; it
 * exists so that a corpus which someday violates that assumption renders 0
 * rather than a negative similarity, which is not a meaningful thing to rank by.
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
 * Needed because `VectorStorage.search`'s own `threshold` is applied as
 * `score <= threshold` — a maximum DISTANCE — while every DOMAIN-level threshold
 * (`memory.search`, `tasks_search`, `tools_search`, rule suggestion) is a minimum
 * SIMILARITY as of mt#4805. Converting a returned score without also converting a
 * threshold pushed down into the store would leave the filter disagreeing with the
 * number displayed beside it.
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
