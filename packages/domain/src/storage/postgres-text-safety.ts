/**
 * Makes user-originated content safe to store in Postgres text-derived columns.
 *
 * Postgres cannot represent U+0000 in `text`, and therefore not in `jsonb`
 * either — the backend uses nul-terminated C strings throughout, so a NUL can
 * never be a legal member of a string value. This is deliberate and has no
 * server-side setting that relaxes it; the documented remedy is to clean the
 * data before it reaches the database. (Tom Lane, pgsql-general
 * `368156.1677514339@sss.pgh.pa.us`: the jsonb type rejects the U+0000 escape
 * "because that cannot be represented in PostgreSQL's text type".)
 *
 * The failure surfaces as two different errors depending on the column type,
 * which is why a single choke point covers both:
 *
 * - **jsonb** — `22P05 unsupported Unicode escape sequence`. The driver
 *   serializes the JS string back to JSON, re-emitting the six-character
 *   `U+0000` escape, and jsonb's parser rejects it. Syntactically valid JSON,
 *   unrepresentable value.
 * - **text** — `22021 invalid byte sequence for encoding "UTF8": 0x00`, raised
 *   at the wire layer on the parameter itself.
 *
 * Neither is retryable: the same input fails identically forever. Before
 * mt#3278 that turned seven local conversations into permanently-frozen
 * transcripts, each re-attempted on every 30-minute sweep.
 *
 * ## Sanitize the PARSED value, never the source bytes
 *
 * The transcripts that triggered this contain **zero** raw 0x00 bytes on disk.
 * They contain the well-formed JSON escape for U+0000 inside string values —
 * legal JSON that `JSON.parse` turns into a real U+0000 in a JS string. A
 * byte-level scan of the file finds nothing. Sanitization has to run on the
 * parsed value, on the way to the database.
 *
 * ## The replacement is lossy, deliberately visibly so
 *
 * U+0000 is replaced with U+FFFD REPLACEMENT CHARACTER rather than deleted.
 * Both are lossy — the original character is unrecoverable either way — but
 * replacement leaves a mark in the stored value instead of silently closing the
 * gap between the two characters that surrounded it, so the loss stays
 * auditable. Callers that need to know whether anything was lost read the
 * returned `replaced` count.
 *
 * @see mt#3278 — the incident this exists to close
 * @see mt#1821 / mt#1824 — the sibling on-disk-file class, guarded at commit time
 */

/**
 * U+0000. Built at runtime rather than written as an escape: source files
 * carrying a literal NUL are blocked by the pre-commit guard (mt#1824), and an
 * escape written through a JSON-parameterized tool becomes a literal NUL on
 * disk (mem#401). Constructing it here sidesteps both hazards.
 */
const NUL = String.fromCharCode(0);

/**
 * The codepoint Postgres cannot store, exported so callers can locate it in
 * their own content (e.g. to point an author at the offending line) without
 * each one re-deriving it and risking a literal NUL in their source.
 */
export const POSTGRES_UNSAFE_SOURCE_CHAR = NUL;

/** U+FFFD REPLACEMENT CHARACTER — the standard marker for an unrepresentable character. */
export const POSTGRES_UNSAFE_REPLACEMENT = String.fromCharCode(0xfffd);

const NUL_PATTERN = new RegExp(NUL, "g");

/** True when `value` contains a codepoint Postgres cannot store in a text-derived column. */
export function hasPostgresUnsafeCodepoint(value: string): boolean {
  return value.includes(NUL);
}

/**
 * Replace every Postgres-unrepresentable codepoint in `value`.
 *
 * Returns the original string reference untouched when there is nothing to
 * replace, so the overwhelmingly common clean case allocates nothing.
 */
export function sanitizeForPostgres(value: string): string {
  return value.includes(NUL) ? value.replace(NUL_PATTERN, POSTGRES_UNSAFE_REPLACEMENT) : value;
}

/** Outcome of a deep sanitization pass. */
export interface DeepSanitizeResult<T> {
  /** The sanitized value. Structurally identical to the input. */
  value: T;
  /** How many individual codepoints were replaced across the whole structure. */
  replaced: number;
  /**
   * Object keys that collided after sanitization, dropping a value.
   *
   * Sanitizing keys can map two distinct keys onto one — `{"a<NUL>": 1,
   * "a<FFFD>": 2}` both become `a<FFFD>` — and the later entry would silently
   * overwrite the earlier. Vanishingly unlikely in transcript data, but silent
   * overwrite is the exact failure shape this module exists to remove, so it is
   * counted and reported rather than absorbed. The FIRST value wins, so the
   * dropped entry is the later one. (PR #2373 R1.)
   */
  keyCollisions: number;
}

/**
 * Recursively sanitize every string in a JSON-shaped value — object values,
 * array elements, and object KEYS alike (a key carrying a NUL fails the insert
 * exactly like a value does).
 *
 * Structure, key order, and non-string leaves are preserved. Cycles are not
 * handled because the inputs are `JSON.parse` results, which cannot contain
 * them; a cyclic input would recurse until the stack gives out, the same as
 * `JSON.stringify` would throw.
 */
export function sanitizeForPostgresDeep<T>(value: T): DeepSanitizeResult<T> {
  let replaced = 0;
  let keyCollisions = 0;

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (!node.includes(NUL)) return node;
      let count = 0;
      const out = node.replace(NUL_PATTERN, () => {
        count++;
        return POSTGRES_UNSAFE_REPLACEMENT;
      });
      replaced += count;
      return out;
    }

    if (Array.isArray(node)) {
      let changed = false;
      const next = node.map((element) => {
        const walked = walk(element);
        if (walked !== element) changed = true;
        return walked;
      });
      return changed ? next : node;
    }

    if (node !== null && typeof node === "object") {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, element] of Object.entries(node as Record<string, unknown>)) {
        const walkedKey = walk(key) as string;
        const walkedValue = walk(element);
        if (walkedKey !== key || walkedValue !== element) changed = true;
        // First write wins. Overwriting silently would lose a value with no
        // signal anywhere — see `keyCollisions` on the result type.
        if (Object.prototype.hasOwnProperty.call(next, walkedKey)) {
          keyCollisions++;
          continue;
        }
        next[walkedKey] = walkedValue;
      }
      return changed ? next : node;
    }

    return node;
  };

  return { value: walk(value) as T, replaced, keyCollisions };
}
