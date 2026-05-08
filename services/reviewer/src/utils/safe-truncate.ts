/**
 * Surrogate-pair-safe string truncation — vendored copy of `src/utils/safe-truncate.ts`.
 *
 * Vendored because the reviewer service deploys with `services/reviewer` as its
 * Docker build root; the parent `src/` is not in the build context, so a
 * cross-package relative import resolves to a path that doesn't exist at
 * runtime and crashes the service on boot. See mt#1679 for the originating
 * incident (mt#1615 surrogate-pair sweep introduced the cross-package imports
 * without accounting for the reviewer's separate deploy).
 *
 * Keep this file behaviorally identical to `src/utils/safe-truncate.ts`. A
 * future task should extract this into a shared `@minsky/shared` package.
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
