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
  //   - Path is anchored on EITHER `:digit` (line citation) OR `\s*—`
  //     (em-dash boundary terminating the description-less form). Without
  //     this anchor, prose like "Conclusion: [BLOCKING] above are issues"
  //     would match `above` as a file.
  //   - Line capture: explicit start + optional end so `:171-176` produces
  //     {line: 171, lineEnd: 176} (pre-fix was lossy parseInt(`171-176`)→171).
  const findingRe =
    /(?:\*\*\[(BLOCKING|NON-BLOCKING|PRE-EXISTING)\]\*\*|(?<!\*)\[(BLOCKING|NON-BLOCKING|PRE-EXISTING)\](?!\*))\s+([^\s:—]+)(?:(?::(\d+)(?:-(\d+))?)?\s*—|:(\d+)(?:-(\d+))?)/gi;

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
 * Parse a unified-diff string into a per-file map of added line ranges in
 * the new file. Used to determine whether a finding's cited range overlaps
 * any new lines the iteration introduced.
 *
 * Returns an empty map if the diff is empty or unparseable. Lines added
 * across multiple hunks for the same file are coalesced when contiguous,
 * preserved as separate ranges otherwise.
 *
 * Exported for unit testing.
 */
export function parseDiffAddedRanges(diff: string): Map<string, Array<[number, number]>> {
  const result = new Map<string, Array<[number, number]>>();
  if (!diff) return result;

  const lines = diff.split("\n");
  let currentFile: string | null = null;
  let currentNewLine = 0;
  // Track whether we're inside an active hunk. Set true on `@@` header, set
  // false on every file-boundary marker (`diff --git`, `--- a/...`, `+++ ...`,
  // and in/out-of-file metadata). PR #922 R1 catch: pre-fix, non-hunk lines
  // between hunks (`diff --git`, `index`, `new file mode`, `\ No newline at
  // end of file`, `rename from/to`) were treated as context lines and
  // advanced `currentNewLine`, corrupting added-line ranges and producing
  // false-positive overlap decisions in applyMonotonicityRecovery.
  let inHunk = false;

  for (const line of lines) {
    // Per-file boundary markers: `diff --git a/x b/y` starts a new file
    // section. Reset state — currentFile is set when the `+++ b/...` line
    // arrives a few lines later.
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      inHunk = false;
      continue;
    }

    // Old-file path header: `--- a/...` or `--- /dev/null`. Reset currentFile
    // until the matching `+++ b/...` line arrives. PR #922 R2 catch: pre-fix,
    // a malformed/truncated diff with `--- a/X` followed by `@@` (no `+++`
    // header) would accumulate added lines under a stale currentFile from
    // the previous file section.
    if (line.startsWith("--- ")) {
      currentFile = null;
      inHunk = false;
      continue;
    }

    // New-file path header: `+++ b/path/to/file` or `+++ /dev/null`.
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path === "/dev/null") {
        currentFile = null;
      } else if (path.startsWith("b/")) {
        currentFile = path.slice(2);
        if (!result.has(currentFile)) result.set(currentFile, []);
      } else {
        // Defensive: treat as no current file rather than mis-parse.
        currentFile = null;
      }
      inHunk = false;
      continue;
    }

    // Hunk header: `@@ -oldStart,oldLen +newStart,newLen @@` (newLen optional).
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      const newStart = hunkMatch[1];
      currentNewLine = newStart ? parseInt(newStart, 10) : 0;
      inHunk = true;
      continue;
    }

    // Skip known non-hunk metadata lines unconditionally. These appear
    // between file sections / between hunks and must not advance the
    // new-file line counter.
    if (
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("copy from") ||
      line.startsWith("copy to") ||
      line.startsWith("similarity index") ||
      line.startsWith("dissimilarity index") ||
      line.startsWith("Binary files ") ||
      line.startsWith("\\ No newline at end of file")
    ) {
      continue;
    }

    // From here on, only hunk content advances counters. If we're not in a
    // hunk OR have no current file, skip the line entirely. Pre-PR-#922-R1
    // the absence of an `inHunk` gate let stray text between hunks bleed
    // into the new-line counter.
    if (!inHunk || currentFile === null) continue;

    if (line.startsWith("+")) {
      const ranges = result.get(currentFile);
      if (!ranges) continue;
      const last = ranges[ranges.length - 1];
      if (last && last[1] === currentNewLine - 1) {
        last[1] = currentNewLine;
      } else {
        ranges.push([currentNewLine, currentNewLine]);
      }
      currentNewLine++;
    } else if (line.startsWith("-")) {
      // Removed line — doesn't advance the new-file line counter.
    } else {
      // Context line — advances new-file line counter.
      currentNewLine++;
    }
  }

  return result;
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
  // Build a map: file -> highest sticky severity seen in priors. We only
  // care whether the file had a NON-BLOCKING or PRE-EXISTING finding; the
  // map records WHICH for telemetry purposes.
  const stickyByFile = new Map<string, "NON-BLOCKING" | "PRE-EXISTING">();
  for (const f of priorFindings) {
    if (f.severity === "BLOCKING") continue;
    // PRE-EXISTING and NON-BLOCKING both gate; if both appear, prefer
    // NON-BLOCKING (the more common case; PRE-EXISTING signals "not this
    // PR's fault" which is a stronger don't-escalate signal but rarer).
    const existing = stickyByFile.get(f.file);
    if (existing === "NON-BLOCKING") continue;
    stickyByFile.set(f.file, f.severity);
  }

  const addedRangesByFile = parseDiffAddedRanges(diffText);

  const corrected: ReviewToolCall[] = [];
  const downgrades: DowngradeAuditEntry[] = [];

  for (const tc of toolCalls) {
    if (tc.name !== "submit_finding" || tc.args.severity !== "BLOCKING") {
      corrected.push(tc);
      continue;
    }

    const matchingPrior = stickyByFile.get(tc.args.file);
    if (!matchingPrior) {
      // File wasn't in any prior NON-BLOCKING / PRE-EXISTING — keep BLOCKING.
      corrected.push(tc);
      continue;
    }

    // LEFT-side findings (anchored on the old/base file, e.g. deletions)
    // cite line numbers in the OLD file. parseDiffAddedRanges only models
    // NEW-file added lines, so a LEFT-side finding's range can never overlap
    // — overlapsNewCode would always be false, and we'd over-eagerly downgrade
    // legitimate re-escalations on removed code. PR #922 R1#3 catch.
    //
    // Conservative policy: NEVER downgrade LEFT-side findings. The recovery
    // layer only operates on RIGHT-side (or unspecified, which defaults to
    // RIGHT semantics in the diff/composer). If the model decides a deletion
    // is BLOCKING, we trust that decision.
    if (tc.args.side === "LEFT") {
      corrected.push(tc);
      continue;
    }

    // File matches a prior sticky finding. Check whether the diff under
    // review introduces new lines on the finding's cited range.
    const addedRanges = addedRangesByFile.get(tc.args.file) ?? [];
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

    // No new code on the cited range — this is a re-escalation without
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
      reason: `mt#1496 monotonicity-recovery: file "${tc.args.file}" had a prior ${matchingPrior} finding and the diff under review does not introduce new lines on the cited range (${findingStart}${findingEnd !== findingStart ? `-${findingEnd}` : ""})`,
      matchingPriorSeverity: matchingPrior,
    });
  }

  return { toolCalls: corrected, downgrades };
}
