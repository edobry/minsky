/**
 * PR scope classifier for scope-aware reviewer rigor (mt#1188).
 *
 * Classifies a PR as trivial, docs-only, test-only, or normal based on the
 * diff and file list. The classifier drives which prompt variant is used —
 * lower-rigor variants reserve BLOCKING severity for a narrower set of
 * findings on small / non-code changes, reducing false REQUEST_CHANGES on
 * cosmetic-but-valid findings (calibration trigger: PR #703).
 */

/**
 * Scope bucket for a pull request.
 *
 * - `docs-only`: every changed file is documentation (README, .md, .mdx,
 *   docs/ tree, CHANGELOG, LICENSE). No code files.
 * - `test-only`: every changed file is a test file (*.test.ts, *.spec.ts,
 *   tests/ tree, etc.). No non-test code.
 * - `trivial`: fewer than 10 changed lines AND fewer than 3 changed files,
 *   and it's not a pure docs or test change (those take precedence).
 * - `normal`: everything else. Default. Do not downgrade rigor for this scope.
 */
export type PRScope = "trivial" | "docs-only" | "test-only" | "normal";

/**
 * Coarser bucket used for prompt-variant selection.
 *
 * `docs-only` and `trivial` share the same lower-rigor prompt variant because
 * both represent small-surface changes where pedantic non-blocking findings
 * produce net-negative signal (see PR #703 calibration).
 */
export type ScopeBucket = "trivial-or-docs" | "test-only" | "normal";

const DOCS_FILE_PATTERN =
  /^(docs\/|.*\.md$|.*\.mdx$|README(\.[a-z]+)?$|CHANGELOG(\.[a-z]+)?$|LICENSE(\.[a-z]+)?$)/i;

const TEST_FILE_PATTERN =
  /^(tests\/|test\/|.*__tests__\/|.*\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$)/i;

/** Opt-out marker in PR body: force the result to `trivial`. */
const TRIVIAL_MARKER = "<!-- minsky:trivial -->";

/**
 * Match a unified-diff file header line.
 *
 * Real headers always have the form `+++ a/path`, `+++ b/path`, or
 * `+++ /dev/null` (and the `---` equivalents for the removed side). Anchoring
 * on the `[ab]/` or `/dev/null` suffix prevents the previous `startsWith("+++")`
 * check from accidentally skipping content lines whose payload itself begins
 * with `+++` or `---` (e.g., Hugo frontmatter, fenced metadata, ASCII rules)
 * — those would render as `++++++` / `++++…` in unified diff and undercount.
 */
const ADDED_HEADER_RE = /^\+\+\+ (?:[ab]\/|\/dev\/null)/;
const REMOVED_HEADER_RE = /^--- (?:[ab]\/|\/dev\/null)/;

/**
 * Count changed lines (additions + deletions) from a unified diff string.
 *
 * Only counts lines that start with `+` or `-` and are NOT file-header lines.
 * Header detection uses ADDED_HEADER_RE / REMOVED_HEADER_RE so synthetic
 * content lines starting with `+++`/`---` are counted correctly. Matches the
 * same set of lines `git diff --stat` counts.
 */
function countChangedLines(diff: string): number {
  let count = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !ADDED_HEADER_RE.test(line)) count++;
    else if (line.startsWith("-") && !REMOVED_HEADER_RE.test(line)) count++;
  }
  return count;
}

/**
 * Classify a pull request into a scope bucket.
 *
 * Precedence: docs-only > test-only > trivial > normal.
 * An opt-out marker in the PR body forces the result to `trivial`.
 */
export function classifyPRScope(input: {
  diff: string;
  filesChanged: string[];
  prBody?: string;
  /**
   * The PR API's `changed_files` count, surfaced from `pulls.get`. When
   * present and greater than `filesChanged.length`, the listFiles fetch was
   * truncated (cap exceeded, error fallback, or upstream pagination edge)
   * and classifying on the partial view is unsafe — we fall through to
   * `normal`. Optional so existing callers without the count remain valid.
   */
  changedFilesCount?: number;
}): PRScope {
  const { diff, filesChanged, prBody, changedFilesCount } = input;

  // Opt-out marker: override everything else.
  if (prBody && prBody.includes(TRIVIAL_MARKER)) {
    return "trivial";
  }

  // With no files, default to normal — we can't make a reliable call.
  if (filesChanged.length === 0) {
    return "normal";
  }

  // Pagination/truncation safeguard: if we received fewer files than the PR
  // API reports, the listFiles view is partial. A docs-only or test-only
  // verdict on a truncated list could mis-classify a PR whose later pages
  // contain code. Fall through to conservative `normal`.
  if (typeof changedFilesCount === "number" && filesChanged.length < changedFilesCount) {
    return "normal";
  }

  // docs-only: every file matches the docs pattern.
  if (filesChanged.every((f) => DOCS_FILE_PATTERN.test(f))) {
    return "docs-only";
  }

  // test-only: every file matches the test pattern.
  if (filesChanged.every((f) => TEST_FILE_PATTERN.test(f))) {
    return "test-only";
  }

  // trivial: <10 changed lines AND <3 changed files.
  const changedLines = countChangedLines(diff);
  if (changedLines < 10 && filesChanged.length < 3) {
    return "trivial";
  }

  return "normal";
}

/**
 * Map a fine-grained PRScope to the coarser ScopeBucket used for prompt
 * variant selection.
 *
 * `docs-only` and `trivial` share the same lower-rigor clause; callers that
 * only care about which prompt variant to apply can use this helper instead
 * of branching on the full PRScope.
 */
export function scopeBucketFor(scope: PRScope): ScopeBucket {
  switch (scope) {
    case "docs-only":
    case "trivial":
      return "trivial-or-docs";
    case "test-only":
      return "test-only";
    case "normal":
      return "normal";
  }
}
