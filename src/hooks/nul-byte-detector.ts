/**
 * Detector for NUL bytes (0x00) in staged text files.
 *
 * Closes the gate-gap exposed by mt#1821 / PR #1107 R1: a JSON-escaped
 * U+0000 in a `session_write_file` content parameter landed as a literal
 * NUL byte inside a TypeScript template literal, slipped past tsc, eslint,
 * prettier, bun test, CI build, and CI bundle-boot-smoke — and was only
 * flagged by git's binary-file detection at reviewer-bot review time.
 *
 * Tracking task: mt#1824. Originating memory:
 * feedback_json_tool_writes_interpret_unicode_escapes (id b7e2f8ef).
 */

/**
 * File extensions whose contents legitimately contain NUL bytes.
 *
 * These are skipped from the NUL-byte check because the entire point of
 * a binary format (PNG, font, archive, native lib, etc.) is to embed
 * non-printable bytes including 0x00.
 */
export const KNOWN_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".icns",
  ".bmp",
  ".tiff",
  // Documents / archives
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  // Fonts
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // Media
  ".mp4",
  ".mov",
  ".webm",
  ".wav",
  ".mp3",
  ".ogg",
  ".m4a",
  // Native binaries
  ".so",
  ".dylib",
  ".dll",
  ".bin",
  ".exe",
  ".class",
  ".jar",
  // Sourcemaps may not embed nuls but byte-streams in some build outputs do.
  // Intentionally NOT allowlisted — keeping the surface tight.
]);

/**
 * Path prefixes whose contents may legitimately contain NUL bytes for
 * regression-test purposes.
 *
 * `tests/fixtures/` exists exactly so test fixtures (including the regression
 * fixture for THIS detector, `tests/fixtures/nul-byte-source.ts`) can carry
 * control characters without tripping the hook on their own staging.
 */
export const FIXTURE_PATH_PREFIXES: readonly string[] = ["tests/fixtures/"];

/**
 * Env var that, when truthy (`1`, `true`, `yes`), skips the NUL-byte check.
 * Follows the override-with-audit pattern of `MINSKY_FORCE_PARALLEL`,
 * `MINSKY_SKIP_FRESHNESS`, `MINSKY_SKIP_BUNDLE_SMOKE`, etc.
 *
 * Registered in `HOOK_ONLY_ENV_VARS` at
 * `src/domain/configuration/sources/environment.ts` per the mt#1788 ESLint
 * rule contract.
 */
export const NUL_BYTE_CHECK_OVERRIDE_ENV = "MINSKY_SKIP_NUL_CHECK";

/**
 * True when the given env-var value should be interpreted as enabling
 * the override. Matches the same casing rules other hook overrides use.
 */
export function isOverrideTruthy(envValue: string | undefined): boolean {
  if (!envValue) return false;
  const v = envValue.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Returns the offset of the first NUL byte in `buffer`, or `null` if none.
 *
 * Implementation note: `Buffer.indexOf(0)` is a single O(n) memchr-style
 * scan. For typical staged TS source files (~10-50 KB) this completes in
 * well under a millisecond, comfortably inside the 200ms budget for 20
 * staged files (AT6).
 */
export function findFirstNulByteOffset(buffer: Buffer): number | null {
  const idx = buffer.indexOf(0);
  return idx === -1 ? null : idx;
}

/**
 * True when `path` should be SKIPPED from the NUL-byte check.
 *
 * Two skip reasons:
 *   1. Known-binary file extension (PNG / WOFF / etc. — NULs are expected).
 *   2. Under a fixture-path prefix (NUL-containing test fixtures).
 *
 * Path comparison uses POSIX separators throughout; staged file paths from
 * `git diff --cached --name-only` are always POSIX, so no conversion needed.
 */
export function isPathAllowlisted(path: string): boolean {
  for (const prefix of FIXTURE_PATH_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = path.slice(lastDot).toLowerCase();
  return KNOWN_BINARY_EXTENSIONS.has(ext);
}

export interface NulByteViolation {
  path: string;
  offset: number;
}

/**
 * Scan a map of `path -> staged-blob` for NUL-byte violations.
 *
 * The check filters out allowlisted paths first, then scans each remaining
 * blob for a NUL byte. Each violation reports the file path and the byte
 * offset of the FIRST NUL byte (AT2 / success criterion 2).
 *
 * Pure function — accepts content via parameter so unit tests can construct
 * synthetic blobs (`Buffer.concat`) without touching the filesystem.
 */
export function detectNulByteViolations(
  stagedContent: ReadonlyMap<string, Buffer>
): NulByteViolation[] {
  const violations: NulByteViolation[] = [];
  for (const [path, buffer] of stagedContent) {
    if (isPathAllowlisted(path)) continue;
    const offset = findFirstNulByteOffset(buffer);
    if (offset !== null) {
      violations.push({ path, offset });
    }
  }
  return violations;
}
