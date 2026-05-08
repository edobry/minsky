/**
 * Surrogate-pair-safe string truncation for content that will be JSON-serialized
 * and replayed by downstream consumers (e.g., MCP error payloads, conversation
 * history).
 *
 * JavaScript strings are UTF-16 code-unit sequences. A naive `str.slice(-N)` or
 * `str.slice(0, N)` can sever a surrogate pair (e.g., a 4-byte emoji like 🔍
 * `🔍`), leaving an unpaired low or high surrogate. `JSON.stringify`
 * will emit that unpaired surrogate, but a re-parser further downstream rejects
 * the result with "invalid high surrogate" / "no low surrogate" — which has
 * been observed bricking Claude Code sessions (mt#1598 originating incident).
 *
 * `safeTruncate` keeps at most `maxLen` UTF-16 code units while shrinking the
 * window by one unit if doing so would otherwise leave a lone surrogate at the
 * truncation boundary.
 */

/**
 * Truncate `str` to at most `maxLen` UTF-16 code units, taking from `side`
 * ("tail" keeps the last N — the typical pattern for log/output tails;
 * "head" keeps the first N), without producing an unpaired surrogate at the
 * boundary.
 *
 * - `tail`: if the first kept code unit is a low surrogate (0xDC00–0xDFFF),
 *   advance the window start by one to drop it.
 * - `head`: if the last kept code unit is a high surrogate (0xD800–0xDBFF),
 *   pull the window end back by one to drop it.
 *
 * Result length is at most `maxLen`.
 */
export function safeTruncate(str: string, maxLen: number, side: "tail" | "head" = "tail"): string {
  if (!Number.isInteger(maxLen) || maxLen < 0) {
    throw new RangeError(`safeTruncate: maxLen must be a non-negative integer, got ${maxLen}`);
  }
  if (str.length <= maxLen) return str;

  if (side === "tail") {
    let start = str.length - maxLen;
    const firstCode = str.charCodeAt(start);
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
      start += 1;
    }
    return str.slice(start);
  }

  // Head mode: explicit guard for maxLen === 0 — without it `charCodeAt(-1)`
  // returns NaN, which the surrogate range check below would handle correctly
  // (NaN comparisons are false), but the explicit early return is clearer and
  // avoids relying on NaN semantics. PR #962 R1 reviewer note.
  if (maxLen === 0) return "";

  let end = maxLen;
  const lastCode = str.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  // eslint-disable-next-line custom/no-unsafe-string-truncation -- implementation: `end` is already surrogate-pair-safe (adjusted above)
  return str.slice(0, end);
}
