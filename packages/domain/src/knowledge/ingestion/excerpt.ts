/**
 * Chunk Excerpt
 *
 * Builds the bounded preview text stored on each knowledge chunk's metadata, so
 * a `knowledge search` result can show WHY the chunk matched rather than only
 * which document it came from.
 *
 * mt#4953: the indexer wrote no chunk text at all, so the adapter's
 * `metadata?.excerpt ?? metadata?.content ?? ""` fallback returned `""` on every
 * row, always. Three shapes were considered; the measurements that chose this
 * one (2026-09-04, over the live corpus):
 *
 *   - Storing the FULL chunk text costs ~14.7x the current per-row JSONB — mean
 *     chunk 10,141 chars (p50 8,548 / max 31,078) against a 740-byte metadata
 *     object — and **155 of 159 documents produce exactly one chunk**, so it
 *     stores the whole corpus a second time to show a reader a few lines.
 *   - Hydrating at read time has nothing to hydrate FROM: the corpus is external
 *     (Notion) and `knowledge_embeddings` is the only knowledge table, so it
 *     means a network fetch per search result.
 *   - A bounded excerpt is what the reader actually needs, costs ~1.7x at the
 *     default cap, and matches the one in-repo precedent with the same table
 *     shape and an external corpus — `principal_corpus_embeddings` stores its
 *     228-char text straight in the JSONB.
 */

/**
 * Cap, in characters, on a stored chunk excerpt — an inclusive bound on the
 * returned string, ellipsis included.
 *
 * 500 chars is a few sentences: enough to judge a match without turning the
 * index into a second copy of the corpus. Measured cost at this cap is 493
 * bytes/row mean (740 -> ~1,233, 1.7x); 200 and 1000 would cost 199 and 964.
 */
export const EXCERPT_MAX_CHARS = 500;

const ELLIPSIS = "…";

/**
 * How far back from the cap a word boundary may sit and still be preferred over
 * a hard cut. Beyond this the text is a single long token (a URL, a hash, a
 * minified blob) and backing off would discard most of the excerpt.
 */
const WORD_BOUNDARY_TOLERANCE = 0.2;

/**
 * Build the excerpt stored for one chunk.
 *
 * Whitespace runs collapse to single spaces: an excerpt is a one-line preview,
 * and markdown chunks carry heading and paragraph breaks that render as blank
 * space in a search result. Truncation prefers the last word boundary and marks
 * itself with an ellipsis.
 *
 * The result never exceeds `maxChars` characters.
 */
export function buildExcerpt(chunkText: string, maxChars: number = EXCERPT_MAX_CHARS): string {
  if (maxChars <= 0) return "";

  const normalized = chunkText.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;

  // Reserve one character for the ellipsis so `maxChars` bounds the whole string.
  const budget = maxChars - ELLIPSIS.length;
  const hardCut = normalized.slice(0, budget);
  const lastSpace = hardCut.lastIndexOf(" ");
  const keepAtLeast = budget * (1 - WORD_BOUNDARY_TOLERANCE);

  const body = lastSpace >= keepAtLeast ? hardCut.slice(0, lastSpace) : hardCut;
  return `${body.trimEnd()}${ELLIPSIS}`;
}

/**
 * Whether a stored metadata object was written by an indexer that knew about
 * excerpts.
 *
 * Keyed on PRESENCE, not on a non-empty value: an empty document chunks to a
 * single empty chunk, whose excerpt is legitimately `""`. Testing for truthiness
 * would classify that row as never-written and re-index it on every sync,
 * forever. The distinction this draws is "no indexer ever wrote this key" versus
 * "one did, and the chunk had nothing to preview".
 */
export function hasStoredExcerpt(metadata: Record<string, unknown>): boolean {
  return "excerpt" in metadata && typeof metadata["excerpt"] === "string";
}
