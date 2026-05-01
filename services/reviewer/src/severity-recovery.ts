/**
 * Severity-monotonicity structural recovery layer (mt#1496).
 *
 * Pure post-process pass over the model's `submit_finding` tool calls that
 * downgrades a BLOCKING finding to NON-BLOCKING when:
 *
 *   1. The finding's `file` matches a prior NON-BLOCKING / PRE-EXISTING
 *      finding from a previous review iteration, AND
 *   2. The diff under review does NOT introduce new lines that overlap the
 *      finding's cited file:line range.
 *
 * Rationale: mt#1465's A/B replay (2026-04-30) showed prompt-restructure
 * alone reduces severity-inflation by ~20% (80% → 64.3%) but cannot move
 * cases where the model's adversarial framing locks in on a previously-
 * flagged file. mt#1413 + mt#1471 established the pattern: prompt directives
 * are advisory at best on gpt-5 tool-use loops; structural enforcement is
 * the only mechanism that bites at scale. This module is the
 * severity-classification analogue of mt#1413's composition-side
 * severity-derived event recovery.
 *
 * Pure function — no I/O, no async, no GitHub API. All inputs are already
 * fetched/parsed by the caller.
 */

import type { ReviewToolCall, SubmitFindingArgs } from "./output-tools";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Flat representation of a single prior-review finding, suitable for the
 * monotonicity-recovery decision. Callers parse prior-review bodies (via
 * extractFindings + a flat-finding parser) into this shape.
 */
export interface FlatPriorFinding {
  /** File path the finding refers to (relative to repo root). */
  file: string;
  /** Severity classification at the time the prior review was posted. */
  severity: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING";
  /** Optional 1-based line number. */
  line?: number;
  /** Optional inclusive end of a multi-line range. */
  lineEnd?: number;
}

/**
 * Audit-log entry produced for each downgraded finding. Persisted as a
 * `reviewer.severity_downgrade` log event so operators can review whether
 * the recovery layer is firing on legitimate re-escalations vs. genuine
 * new BLOCKING findings.
 */
export interface DowngradeAuditEntry {
  file: string;
  line: number;
  lineEnd?: number;
  fromSeverity: "BLOCKING";
  toSeverity: "NON-BLOCKING";
  /**
   * Human-readable explanation of why the downgrade fired. Includes the
   * matching prior severity and a note about the diff coverage check.
   */
  reason: string;
  /**
   * The severity of the matching prior finding (the one that locked in
   * monotonicity). Useful for telemetry: NON-BLOCKING re-escalations are
   * the dominant case; PRE-EXISTING re-escalations are rarer and worth
   * inspecting.
   */
  matchingPriorSeverity: "NON-BLOCKING" | "PRE-EXISTING";
}

/** Result of running the recovery pass. */
export interface MonotonicityRecoveryResult {
  /**
   * The corrected list of tool calls. Same length and ordering as the
   * input; only the `severity` field of `submit_finding` calls may differ.
   * Non-finding tool calls (submit_inline_comment, submit_spec_verification,
   * conclude_review) pass through unchanged.
   */
  toolCalls: ReviewToolCall[];
  /** Audit log of downgrades performed, in input order. */
  downgrades: DowngradeAuditEntry[];
}

// ---------------------------------------------------------------------------
// Prior-body finding extraction
// ---------------------------------------------------------------------------

/**
 * Parse FlatPriorFinding entries out of a single prior-review body.
 *
 * Looks for severity markers in two forms:
 *   - bare:           `[BLOCKING] src/foo.ts:42 — text` (production format)
 *   - bold-wrapped:   `**[BLOCKING]** src/foo.ts:42 — text` (composer/operator)
 *
 * Captures path + optional line range (single line `:42` or range `:42-50`).
 * Returns empty array when no markers are found. Pure function; exported
 * for unit testing and reuse.
 *
 * Mirrors mt#1465's `replay-summary.ts:parseFindingsFromBody` shape; kept
 * separate here so the production-side recovery path doesn't depend on the
 * replay harness module. A future refactor can dedup if both modules land.
 */
export function parsePriorBodyFindings(body: string): FlatPriorFinding[] {
  if (!body.trim()) return [];

  const out: FlatPriorFinding[] = [];
  // Regex matches:
  //   - Severity: balanced bold OR fully bare; one-sided wrappers rejected
  //     via negative lookbehind/lookahead on `*` (PR #922 R1 + parity with
  //     mt#1486 production-side fix and mt#1465 harness fix).
  //   - File path: any non-whitespace run that isn't `:` or em-dash. Accepts
  //     extensionless filenames (Dockerfile, Makefile, LICENSE), dotfiles
  //     (.env), multi-dot names (.eslintrc.json), scoped paths (src/@types/foo).
  //     Pre-PR-#922-R1 the regex required a literal dot-extension and silently
  //     dropped these on production review bodies, reducing recovery effectiveness.
  //   - Path is anchored on EITHER `:digit` (line citation) OR a dash
  //     boundary (em-dash, en-dash, or ASCII hyphen — PR #922 R2#3 catch).
  //     Pre-PR-#922-R2 the regex hardcoded the U+2014 em-dash, missing real
  //     bodies that used `-` (typing variation, Markdown rendering).
  //   - Line capture: explicit start + optional end so `:171-176` produces
  //     {line: 171, lineEnd: 176} (pre-fix was lossy parseInt(`171-176`)→171).
  //
  // Path char class: two alternatives.
  //   (a) Strict: `[A-Za-z0-9@._\-/\\]+` (with optional parenthesized
  //       continuation) — covers the overwhelming majority of paths.
  //   (b) Permissive: allows spaces, commas, and parens BUT requires at
  //       least one `/`, `.`, or `\` in the run so bare prose like
  //       "above are issues" — which lacks path-distinctive chars — does
  //       NOT match. Real-world examples: `src/My Component.tsx`,
  //       `examples/foo,bar.ts` (PR #922 R15#1).
  // ASCII hyphen `-` is permitted inside paths (common: `task-spec-fetch.ts`);
  // the dash-boundary alternative requires WHITESPACE around the dash to
  // disambiguate from path-internal hyphens.
  const findingRe =
    /(?:\*\*\[(BLOCKING|NON-BLOCKING|PRE-EXISTING)\]\*\*|(?<!\*)\[(BLOCKING|NON-BLOCKING|PRE-EXISTING)\](?!\*))\s+((?:[A-Za-z0-9@._\-/\\]+(?:\s*\([^)]+\)[A-Za-z0-9@._\-/\\]*)*)|(?:[A-Za-z0-9@_\-,() ]*[./\\][A-Za-z0-9@._\-/\\,() ]*))(?::?(?:(\d+)(?:-(\d+))?)?\s+[-–—]\s|:(\d+)(?:-(\d+))?)/gi;

  for (const match of body.matchAll(findingRe)) {
    // Capture groups (alternation produces parallel sets):
    //   [1] severity from bold-wrapped branch
    //   [2] severity from bare branch
    //   [3] file (always set)
    //   [4]/[5] lineStart/lineEnd from em-dash-terminated alternative
    //   [6]/[7] lineStart/lineEnd from colon-then-required-line alternative
    const rawSeverity = match[1] ?? match[2];
    const file = match[3];
    if (!rawSeverity || !file) continue;
    const severity = rawSeverity.toUpperCase() as FlatPriorFinding["severity"];
    const lineRaw = match[4] ?? match[6];
    const lineEndRaw = match[5] ?? match[7];
    const line = lineRaw ? parseInt(lineRaw, 10) : undefined;
    const lineEnd = lineEndRaw ? parseInt(lineEndRaw, 10) : undefined;
    out.push({
      file,
      severity,
      ...(line !== undefined ? { line } : {}),
      ...(lineEnd !== undefined ? { lineEnd } : {}),
    });
  }
  return out;
}

/**
 * Parse a list of prior bot review bodies into a single flat finding list.
 *
 * Convenience wrapper around `parsePriorBodyFindings` for callers that have
 * an array of bodies (oldest-first).
 */
export function parsePriorReviewFindings(bodies: ReadonlyArray<string>): FlatPriorFinding[] {
  const out: FlatPriorFinding[] = [];
  for (const body of bodies) {
    out.push(...parsePriorBodyFindings(body));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Result of parsing a unified diff: per-file added/removed line ranges plus
 * rename mappings. PR #922 R2 catch: pre-fix this returned only added ranges,
 * which made it impossible for applyMonotonicityRecovery to handle deletion
 * findings (no added overlap by construction) or rename pairs (additions
 * attributed only to the new path).
 */
export interface ParsedDiff {
  /**
   * Map of file path → ranges of added lines in the NEW file (1-based,
   * inclusive). Used for RIGHT-side / unspecified-side overlap checks.
   */
  added: Map<string, Array<[number, number]>>;
  /**
   * Map of file path → ranges of removed lines in the OLD file (1-based,
   * inclusive). Used for LEFT-side checks and as a conservative guard for
   * unspecified-side findings on deletions. Pre-PR-#922-R2 this dimension
   * wasn't tracked at all.
   */
  removed: Map<string, Array<[number, number]>>;
  /**
   * Rename mapping: oldPath → newPath. One-directional — the only consumer
   * (applyMonotonicityRecovery) looks up by old path to resolve to the new
   * path's added ranges. PR #922 R3 doc-correction: pre-fix the comment
   * said "Bidirectional" but the implementation only populates oldPath →
   * newPath. If a future caller needs new → old, it can build the inverse
   * map at the call site.
   *
   * Pre-PR-#922-R2 the parser ignored `rename from`/`rename to` headers
   * entirely, so a finding citing the OLD path saw zero added-line
   * overlap on a renamed file and was incorrectly downgraded. Now:
   * applyMonotonicityRecovery uses this map to resolve old-path lookups
   * to the new-path added ranges, AND treats renamed files as
   * conservative-preserve regardless of overlap.
   */
  renames: Map<string, string>;
}

/**
 * Parse a unified-diff string into a per-file map of added line ranges in
 * the new file. Used to determine whether a finding's cited range overlaps
 * any new lines the iteration introduced.
 *
 * Returns an empty map if the diff is empty or unparseable. Lines added
 * across multiple hunks for the same file are coalesced when contiguous,
 * preserved as separate ranges otherwise.
 *
 * **Backwards-compat shim** — returns ONLY the added ranges. Prefer
 * `parseUnifiedDiff` which exposes added + removed + renames in a single
 * result struct (PR #922 R2#1+R2#2 catch). Existing callers and tests
 * remain on this shape; new callers should migrate.
 *
 * Exported for unit testing.
 */
export function parseDiffAddedRanges(diff: string): Map<string, Array<[number, number]>> {
  return parseUnifiedDiff(diff).added;
}

/**
 * Parse a unified-diff string into added/removed line ranges per file plus
 * rename mappings. PR #922 R2 successor to parseDiffAddedRanges.
 *
 * Exported for unit testing.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const added = new Map<string, Array<[number, number]>>();
  const removed = new Map<string, Array<[number, number]>>();
  const renames = new Map<string, string>();
  if (!diff) return { added, removed, renames };

  const lines = diff.split("\n");
  let currentFile: string | null = null;
  let currentNewLine = 0;
  // Old-file line counter — advances on context and `-` lines, used to
  // record removed-line ranges. PR #922 R2#1 addition.
  let currentOldLine = 0;
  let inHunk = false;
  // Pending rename pair captured from `rename from X` / `rename to Y` headers.
  // The pair completes when both lines have been seen; the mapping is
  // recorded on the second one. PR #922 R2#2 addition.
  let pendingRenameFrom: string | null = null;
  // Track the old-file path captured from `--- a/...` headers. Used to key
  // removed ranges on the OLD path when `+++ /dev/null` arrives (full file
  // deletion) — pre-PR-#922-R3 the parser set currentFile=null on
  // `+++ /dev/null` and dropped the entire deletion's removed lines, which
  // caused unspecified-side findings on deleted files to be over-eagerly
  // downgraded.
  let oldFilePath: string | null = null;

  /** Coalesce or append a range on the appropriate map. */
  function pushRange(map: Map<string, Array<[number, number]>>, file: string, line: number): void {
    if (!map.has(file)) map.set(file, []);
    const ranges = map.get(file);
    if (!ranges) return;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === line - 1) {
      last[1] = line;
    } else {
      ranges.push([line, line]);
    }
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      oldFilePath = null;
      inHunk = false;
      pendingRenameFrom = null;
      continue;
    }

    // Capture rename pairs. PR #922 R2#2 catch: pre-fix these were skipped
    // as metadata; now we record the mapping so applyMonotonicityRecovery
    // can resolve old-path findings against new-path added ranges.
    if (line.startsWith("rename from ")) {
      pendingRenameFrom = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      const renameTo = line.slice("rename to ".length);
      if (pendingRenameFrom) {
        renames.set(pendingRenameFrom, renameTo);
        pendingRenameFrom = null;
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      // Capture the old-file path so we can key removed ranges on it when
      // `+++ /dev/null` arrives (full file deletion). PR #922 R3 catch.
      const path = line.slice(4);
      if (path === "/dev/null") {
        oldFilePath = null;
      } else if (path.startsWith("a/")) {
        oldFilePath = path.slice(2);
      } else {
        oldFilePath = null;
      }
      currentFile = null;
      inHunk = false;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path === "/dev/null") {
        // File fully deleted. Use the old-file path as currentFile so the
        // subsequent hunk's `-` lines are recorded under the old path. The
        // file will have ZERO added lines (no `+` lines in a deleted-file
        // hunk), but recording the removed ranges lets unspecified-side
        // findings preserve BLOCKING when their cited range overlaps the
        // deletion.
        currentFile = oldFilePath;
        if (currentFile !== null) {
          if (!added.has(currentFile)) added.set(currentFile, []);
          if (!removed.has(currentFile)) removed.set(currentFile, []);
        }
      } else if (path.startsWith("b/")) {
        currentFile = path.slice(2);
        if (!added.has(currentFile)) added.set(currentFile, []);
        if (!removed.has(currentFile)) removed.set(currentFile, []);
      } else {
        currentFile = null;
      }
      inHunk = false;
      continue;
    }

    // Hunk header captures BOTH old-file and new-file starts. PR #922 R2#1
    // addition: pre-fix only the new-file start was captured.
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      const oldStart = hunkMatch[1];
      const newStart = hunkMatch[2];
      currentOldLine = oldStart ? parseInt(oldStart, 10) : 0;
      currentNewLine = newStart ? parseInt(newStart, 10) : 0;
      inHunk = true;
      continue;
    }

    if (
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("copy from") ||
      line.startsWith("copy to") ||
      line.startsWith("similarity index") ||
      line.startsWith("dissimilarity index") ||
      line.startsWith("Binary files ") ||
      line.startsWith("\\ No newline at end of file")
    ) {
      continue;
    }

    if (!inHunk || currentFile === null) continue;

    if (line.startsWith("+")) {
      pushRange(added, currentFile, currentNewLine);
      currentNewLine++;
    } else if (line.startsWith("-")) {
      // Record removed lines under the OLD path when available, so LEFT-side
      // and unspecified-side overlap checks against old-path findings work
      // correctly on renames. Pre-PR-#922-R4 this used currentFile (the new
      // path on renames), which broke deletion-preservation for findings
      // that cited the old path. Falls back to currentFile when no old-path
      // header was seen (defensive).
      const removedKey = oldFilePath ?? currentFile;
      pushRange(removed, removedKey, currentOldLine);
      currentOldLine++;
    } else {
      // Context line — advances both old and new file counters.
      currentOldLine++;
      currentNewLine++;
    }
  }

  return { added, removed, renames };
}

/**
 * Check whether a [start, end] range overlaps any range in the list.
 * Both bounds inclusive.
 */
function rangeOverlapsAny(
  start: number,
  end: number,
  ranges: ReadonlyArray<readonly [number, number]>
): boolean {
  for (const [rs, re] of ranges) {
    if (rs <= end && re >= start) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply severity-monotonicity recovery to a list of model tool calls.
 *
 * For each `submit_finding` with severity BLOCKING:
 *   - If the file matches a prior NON-BLOCKING / PRE-EXISTING finding AND
 *   - The diff under review does NOT introduce new lines overlapping the
 *     finding's cited file:line range
 * then downgrade severity to NON-BLOCKING and emit an audit-log entry.
 *
 * Other tool calls (submit_inline_comment, submit_spec_verification,
 * conclude_review) pass through unchanged.
 *
 * Findings without a citable line range default to {line, lineEnd} =
 * {line, line}; these are checked against per-file overlap (any added line
 * in the same file). This is the conservative case — if any new code lands
 * in the file, the BLOCKING is preserved.
 */
export function applyMonotonicityRecovery(
  toolCalls: ReadonlyArray<ReviewToolCall>,
  priorFindings: ReadonlyArray<FlatPriorFinding>,
  diffText: string
): MonotonicityRecoveryResult {
  const parsedDiff = parseUnifiedDiff(diffText);

  // Build a map: file -> highest sticky severity seen in priors. We only
  // care whether the file had a NON-BLOCKING or PRE-EXISTING finding; the
  // map records WHICH for telemetry purposes.
  //
  // PR #922 R4#1 catch: alias entries via the rename map so a prior finding
  // on the OLD path also gates a current finding on the NEW path (and
  // vice versa via the inverse). Pre-fix the lookup was strictly by
  // tc.args.file; renames silently bypassed monotonicity gating.
  //
  // PR #922 R10 catch: normalize backslash → forward-slash before map
  // insert/lookup. Pre-fix priors parsed as `packages\app\Foo.ts` would
  // not match a current finding citing `packages/app/Foo.ts`, silently
  // bypassing gating on cross-platform path representations. Both prior
  // and current paths are normalized to a canonical POSIX form.
  const normalizePath = (p: string): string => p.replace(/\\/g, "/");

  const stickyByFile = new Map<string, "NON-BLOCKING" | "PRE-EXISTING">();
  // Build inverse rename map (new → old) once for cross-direction aliasing.
  const inverseRenames = new Map<string, string>();
  for (const [oldPath, newPath] of parsedDiff.renames.entries()) {
    inverseRenames.set(normalizePath(newPath), normalizePath(oldPath));
  }
  function setSticky(file: string, severity: "NON-BLOCKING" | "PRE-EXISTING"): void {
    const key = normalizePath(file);
    const existing = stickyByFile.get(key);
    if (existing === "NON-BLOCKING") return; // NON-BLOCKING wins (see comment below)
    stickyByFile.set(key, severity);
  }
  for (const f of priorFindings) {
    if (f.severity === "BLOCKING") continue;
    // PRE-EXISTING and NON-BLOCKING both gate; if both appear on the same
    // file, prefer NON-BLOCKING (the more common case; PRE-EXISTING signals
    // "not this PR's fault" which is a stronger don't-escalate signal but
    // rarer in calibration data).
    setSticky(f.file, f.severity);
    // Alias under the rename counterpart so old↔new lookups both succeed.
    // Use normalized-key lookups since the rename map was built with
    // normalized keys above.
    const normalizedFile = normalizePath(f.file);
    const renamedTo = parsedDiff.renames.get(normalizedFile);
    if (renamedTo) setSticky(renamedTo, f.severity);
    const renamedFrom = inverseRenames.get(normalizedFile);
    if (renamedFrom) setSticky(renamedFrom, f.severity);
  }

  const corrected: ReviewToolCall[] = [];
  const downgrades: DowngradeAuditEntry[] = [];

  for (const tc of toolCalls) {
    if (tc.name !== "submit_finding" || tc.args.severity !== "BLOCKING") {
      corrected.push(tc);
      continue;
    }

    // Normalize the current finding's file path to match the canonical form
    // used in stickyByFile (PR #922 R10 catch).
    const normalizedCurrentFile = normalizePath(tc.args.file);
    const matchingPrior = stickyByFile.get(normalizedCurrentFile);
    if (!matchingPrior) {
      // File wasn't in any prior NON-BLOCKING / PRE-EXISTING — keep BLOCKING.
      corrected.push(tc);
      continue;
    }

    // LEFT-side findings (anchored on the old/base file, e.g. deletions)
    // cite line numbers in the OLD file. PR #922 R1#3 catch + R2#1
    // refinement: never downgrade LEFT-side. Trust the model's deletion call.
    if (tc.args.side === "LEFT") {
      corrected.push(tc);
      continue;
    }

    // Resolve added-range lookups via the rename map. PR #922 R2#2 catch +
    // R4#1 inverse-direction + R10/R11 normalization: all three map lookups
    // (renames, inverseRenames, added, removed) must use the normalized
    // current-file key. parsedDiff.renames is keyed by normalized old path
    // (we normalized when populating); added/removed are keyed by file as
    // it appears in the diff — which is always POSIX for `diff --git` output,
    // but normalize defensively to handle any caller-supplied diff variants.
    const renamedTo = parsedDiff.renames.get(normalizedCurrentFile);
    const renamedFromCheck = inverseRenames.get(normalizedCurrentFile);
    const lookupFile = renamedTo ?? normalizedCurrentFile;
    const fileWasRenamed = renamedTo !== undefined || renamedFromCheck !== undefined;

    const addedRanges = parsedDiff.added.get(lookupFile) ?? [];
    // PR #922 R12 catch: removed lines on renames are recorded under the
    // OLD path (parseUnifiedDiff uses oldFilePath as the key for `-` lines
    // so LEFT-side and unspecified-side overlap checks work correctly on
    // old-path findings). Pre-fix we looked up removed ranges only by
    // lookupFile (which resolves to newPath via the rename map), so a
    // current finding citing the NEW path with side undefined would see
    // empty removed-ranges and wrongly downgrade. Now: union the removed
    // ranges from BOTH the new path lookup AND the old path lookup
    // (resolved via renamedFromCheck or normalizedCurrentFile, depending
    // on direction).
    const oldPathForRemoved = renamedFromCheck ?? normalizedCurrentFile;
    const removedRanges = [
      ...(parsedDiff.removed.get(lookupFile) ?? []),
      ...(parsedDiff.removed.get(oldPathForRemoved) ?? []),
    ];
    const findingStart = tc.args.line;
    const findingEnd = tc.args.lineEnd ?? tc.args.line;
    const overlapsNewCode = rangeOverlapsAny(findingStart, findingEnd, addedRanges);

    if (overlapsNewCode) {
      // Diff genuinely introduces new code on the cited range — preserve
      // BLOCKING. The model is allowed to escalate when the diff itself
      // adds the basis for the concern.
      corrected.push(tc);
      continue;
    }

    // PR #922 R2#1 catch: when `side` is undefined, we cannot tell whether
    // the finding refers to the new file (additions) or the old file
    // (deletions). Conservative policy: if the cited range overlaps any
    // REMOVED lines on the file, treat as a deletion finding and preserve
    // BLOCKING. Pre-fix this was checked only against added lines, so an
    // unspecified-side finding on removed code was always downgraded.
    if (tc.args.side === undefined) {
      const overlapsRemovedCode = rangeOverlapsAny(findingStart, findingEnd, removedRanges);
      if (overlapsRemovedCode) {
        corrected.push(tc);
        continue;
      }
    }

    // PR #922 R2#2 catch: rename pairs are also a conservative-preserve
    // case. If the file was renamed AND the finding cites the old path,
    // even with no added-line overlap on the new path, the model may be
    // referring to original-file context. Preserve BLOCKING.
    if (fileWasRenamed) {
      corrected.push(tc);
      continue;
    }

    // No new code on the cited range, no removed code on the cited range
    // (when side unspecified), no rename — this is a re-escalation without
    // diff-level evidence. Downgrade.
    const downgradedArgs: SubmitFindingArgs = {
      ...tc.args,
      severity: "NON-BLOCKING",
    };
    corrected.push({ name: "submit_finding", args: downgradedArgs });
    downgrades.push({
      file: tc.args.file,
      line: tc.args.line,
      ...(tc.args.lineEnd !== undefined ? { lineEnd: tc.args.lineEnd } : {}),
      fromSeverity: "BLOCKING",
      toSeverity: "NON-BLOCKING",
      reason: `monotonicity-recovery: file "${tc.args.file}" had a prior ${matchingPrior} finding and the diff under review does not introduce new lines on the cited range (${findingStart}${findingEnd !== findingStart ? `-${findingEnd}` : ""})`,
      matchingPriorSeverity: matchingPrior,
    });
  }

  return { toolCalls: corrected, downgrades };
}
