/**
 * Surrogate-pair-safe string truncation.
 *
 * JavaScript strings are UTF-16 code-unit sequences. A naive `str.slice(-N)` or
 * `str.slice(0, N)` can sever a surrogate pair (e.g., a 4-byte emoji like 🔍),
 * leaving an unpaired low or high surrogate. `JSON.stringify` will emit that
 * unpaired surrogate, but a downstream re-parser rejects the result with
 * "invalid high surrogate" / "no low surrogate" — which has been observed
 * bricking Claude Code sessions (mt#1598).
 *
 * `safeTruncate` keeps at most `maxLen` UTF-16 code units while shrinking the
 * window by one unit if doing so would otherwise leave a lone surrogate at the
 * truncation boundary.
 *
 * - `tail`: if the first kept code unit is a low surrogate (0xDC00–0xDFFF),
 *   advance the window start by one to drop it.
 * - `head`: if the last kept code unit is a high surrogate (0xD800–0xDBFF),
 *   pull the window end back by one to drop it.
 *
 * Result length is at most `maxLen`.
 *
 * Originating ticket: mt#1615 (canonical impl in src/utils/safe-truncate.ts).
 * Promoted to shared workspace package: mt#1681.
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

  if (maxLen === 0) return "";

  let end = maxLen;
  const lastCode = str.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  // eslint-disable-next-line custom/no-unsafe-string-truncation -- implementation: `end` is already surrogate-pair-safe (adjusted above)
  return str.slice(0, end);
}
