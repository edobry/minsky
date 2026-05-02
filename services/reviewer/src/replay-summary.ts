/**
 * Pure helper functions for aggregating replay-verification results.
 *
 * Extracted from `scripts/replay-structural-output.ts` to enable unit testing
 * of the summarization logic without real API calls.
 *
 * See mt#1403 for context. The replay script (scripts/replay-structural-output.ts)
 * is the consumer; this module contains only the pure aggregate helpers.
 */

import type { ReviewToolCall } from "./output-tools";
import type { SanitizeAction } from "./sanitize";

// ---------------------------------------------------------------------------
// Per-attempt result shape
// ---------------------------------------------------------------------------

export interface AttemptResult {
  attempt: number;
  toolCallCount: number;
  scratchTextLength: number;
  scratchSanitize: SanitizeAction;
  postedBodySanitize: SanitizeAction;
  blockingFindingCount: number;
  concludeEvent: string;
}

// ---------------------------------------------------------------------------
// Per-PR result shape
// ---------------------------------------------------------------------------

export interface PerPrResult {
  prNumber: number;
  attempts: AttemptResult[];
}

// ---------------------------------------------------------------------------
// Top-level summary shape
// ---------------------------------------------------------------------------

export interface ReplaySummary {
  prsTested: number;
  attemptsPerPR: number;
  totalAttempts: number;
  scratchSanitizerFires: number;
  postedBodySanitizerFires: number;
  structuralFixVerified: boolean;
}

// ---------------------------------------------------------------------------
// Full run result (written to JSON file and stdout)
// ---------------------------------------------------------------------------

export interface ReplayRunResult {
  runStartedAt: string;
  model: string;
  summary: ReplaySummary;
  perPR: PerPrResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build one `AttemptResult` from raw per-attempt data.
 *
 * @param attemptIndex - 1-based attempt number
 * @param toolCalls - accumulated tool calls from the model response
 * @param scratchText - the free-text output.text (scratch channel)
 * @param scratchSanitize - result of running sanitizeReviewBody on output.text
 * @param postedBodySanitize - result of running sanitizeReviewBody on the composed body
 */
export function buildAttemptResult(
  attemptIndex: number,
  toolCalls: ReviewToolCall[],
  scratchText: string,
  scratchSanitize: SanitizeAction,
  postedBodySanitize: SanitizeAction
): AttemptResult {
  const blockingFindingCount = toolCalls.filter(
    (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
  ).length;

  const concludeCall = toolCalls.filter((tc) => tc.name === "conclude_review").at(-1);

  const concludeEvent = concludeCall ? concludeCall.args.event : "NONE";

  return {
    attempt: attemptIndex,
    toolCallCount: toolCalls.length,
    scratchTextLength: scratchText.length,
    scratchSanitize,
    postedBodySanitize,
    blockingFindingCount,
    concludeEvent,
  };
}

/**
 * Aggregate per-PR results into a summary.
 *
 * @param perPR - list of per-PR results (each with an attempts array)
 * @param attemptsPerPR - expected number of attempts per PR (for summary fields)
 */
export function aggregateSummary(perPR: PerPrResult[], attemptsPerPR: number): ReplaySummary {
  const prsTested = perPR.length;
  const totalAttempts = perPR.reduce((sum, pr) => sum + pr.attempts.length, 0);

  let scratchSanitizerFires = 0;
  let postedBodySanitizerFires = 0;

  for (const pr of perPR) {
    for (const attempt of pr.attempts) {
      if (attempt.scratchSanitize !== "passthrough") {
        scratchSanitizerFires += 1;
      }
      if (attempt.postedBodySanitize !== "passthrough") {
        postedBodySanitizerFires += 1;
      }
    }
  }

  return {
    prsTested,
    attemptsPerPR,
    totalAttempts,
    scratchSanitizerFires,
    postedBodySanitizerFires,
    structuralFixVerified: postedBodySanitizerFires === 0,
  };
}

// ---------------------------------------------------------------------------
// Severity inflation detection (mt#1465)
// ---------------------------------------------------------------------------

/**
 * A flat representation of a single finding with file + severity, suitable
 * for cross-iteration comparison. Used both for current-attempt findings
 * (parsed from `submit_finding` tool calls) and for prior-review findings
 * (extracted via regex from prior review markdown bodies).
 */
export interface FlatFinding {
  /** File path the finding refers to (relative to repo root). */
  file: string;
  /** Severity classification. */
  severity: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING";
  /**
   * Optional 1-based line number. For range citations like `:171-176`,
   * this is the start of the range. The end is in `lineEnd`. Pre-PR-#920-R1
   * this field was set to the start of the range with no preservation of the
   * end, which produced misleading false-precision data when downstream
   * consumers treated `line` as authoritative. Now: `line` is always paired
   * with `lineEnd` when a range is parsed, so consumers can choose between
   * range semantics and start-only semantics deliberately.
   */
  line?: number;
  /**
   * Optional 1-based inclusive end of a multi-line range. Set only when
   * the source citation included an explicit range (e.g., `src/foo.ts:171-176`
   * -> `{ line: 171, lineEnd: 176 }`). Single-line citations omit this field;
   * downstream consumers should treat absence-of-lineEnd as a single-line
   * finding and use `line` as both start and end.
   */
  lineEnd?: number;
}

/**
 * Parse prior-review findings from a rendered review body.
 *
 * Looks for lines matching the conventional `**[SEVERITY]** path:line - text`
 * pattern emitted by both the pre-mt#1395 prose-output reviewer and the
 * mt#1395 structured-output composer. Falls back to `**[SEVERITY]** path:line`
 * (no em-dash) for variant formats.
 *
 * Pure function - no I/O. Returns empty array when no findings are detected.
 *
 * Exported for unit testing.
 */
export function parseFindingsFromBody(body: string): FlatFinding[] {
  if (!body.trim()) return [];

  const out: FlatFinding[] = [];
  // Match `[SEVERITY]` markers followed by a path. Production reviewer bodies
  // use `[BLOCKING]` (bare); mt#1395-era and operator-composed bodies use
  // `**[BLOCKING]**` (bold-wrapped). Both forms must match; one-sided
  // wrappers are rejected via negative lookbehind/lookahead on the bare
  // branch (PR #920 R1 catch - same shape as mt#1486 production-side fix).
  //
  // Path regex: any non-whitespace run that isn't a colon (path separator)
  // or em-dash (description separator). This accepts extensionless filenames
  // like `Dockerfile`, `Makefile`, `LICENSE`, dotfiles like `.env`,
  // `.gitignore`, multi-dot names like `.eslintrc.json`, scoped paths like
  // `src/@types/foo.d.ts`, etc. Pre-PR-#920-R1 the regex required a literal
  // dot-extension (`[\w./_-]+\.\w+`) which silently dropped these on real
  // calibration corpus PRs.
  //
  // Anchoring: the path is REQUIRED to be followed by either `:digit` (line
  // citation) OR `\s*-` (dash boundary terminating the description-less
  // form `[BLOCKING] LICENSE - text`). Without this anchor, a body like
  // "Conclusion: [BLOCKING] above are the issues" would match `above` as a
  // file path. The dash boundary is the canonical separator the reviewer-
  // bot emits between location and description; matching prose without it
  // is the over-permissive failure mode.
  //
  // Line capture: explicit start + optional end captures so range citations
  // like `:171-176` produce {line: 171, lineEnd: 176} instead of the
  // pre-PR-#920-R1 lossy parseInt-of-"171-176" -> 171 with no end recorded.
  // PR #920 R2 rewrite: lookbehind-free + start-of-line anchored + multi
  // dash variant. Pattern is multiline so `^` matches start of each line.
  // The bare-branch `(?:[^*]|$)` is a lookahead-free balance check (next
  // char must not be `*`); for matchAll, this consumes one extra char,
  // which is harmless for severity detection. Path char class is tightened
  // to common path chars only (rejects backticks, parens, em-dashes).
  const findingRe =
    /^\s*(?:[-*•]\s+)?(?:\*\*\[(BLOCKING|NON-BLOCKING|PRE-EXISTING)\]\*\*|\[(BLOCKING|NON-BLOCKING|PRE-EXISTING)\](?:[^*]|$))\s*([A-Za-z0-9@._\-/]+)(?:(?::(\d+)(?:-(\d+))?)?\s+[-–—]\s|:(\d+)(?:-(\d+))?)/gim;

  for (const match of body.matchAll(findingRe)) {
    // Capture groups (alternation produces two parallel sets):
    //   [1] severity from bold-wrapped branch
    //   [2] severity from bare branch
    //   [3] file (always set)
    //   [4]/[5] lineStart/lineEnd from the dash-terminated alternative
    //   [6]/[7] lineStart/lineEnd from the colon-then-required-line alternative
    // Only one severity branch fires per match; only one of (4,5) or (6,7) fires.
    const rawSeverity = match[1] ?? match[2];
    const file = match[3];
    if (!rawSeverity || !file) continue;
    const severity = rawSeverity.toUpperCase() as FlatFinding["severity"];
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
 * Result of a severity-inflation check on a single attempt.
 */
export interface SeverityInflationResult {
  /** Total BLOCKING findings in the current attempt. */
  currentBlockingCount: number;
  /**
   * Subset of current BLOCKING findings whose `file` was previously classified
   * as NON-BLOCKING or PRE-EXISTING in any prior review. These are the
   * re-escalation candidates the mt#1189 sticky-classification rule targets.
   */
  inflatedFindings: FlatFinding[];
  /** Convenience: inflatedFindings.length / currentBlockingCount, or 0 if no current blockers. */
  inflationRate: number;
}

/**
 * Detect severity inflation: count BLOCKING findings in the current attempt
 * whose file matches a prior NON-BLOCKING or PRE-EXISTING finding.
 *
 * Heuristic: matches on `file` only, not `file:line`. The model commonly
 * reframes the same concern with slightly different line citations across
 * rounds; the file boundary is the most stable identifier of "same area of
 * code." This produces a conservative count - false positives are possible
 * when the diff genuinely introduces new BLOCKING-worthy code on a file that
 * also had a prior NON-BLOCKING finding, so the metric measures *candidates*
 * rather than confirmed re-escalations. Operator review of `inflatedFindings`
 * is the second-pass disambiguator.
 *
 * Pure function. Exported for unit testing.
 */
export function detectSeverityInflation(
  currentFindings: FlatFinding[],
  priorFindings: FlatFinding[]
): SeverityInflationResult {
  const priorNonBlockingFiles = new Set(
    priorFindings.filter((f) => f.severity !== "BLOCKING").map((f) => f.file)
  );
  const currentBlocking = currentFindings.filter((f) => f.severity === "BLOCKING");
  const inflatedFindings = currentBlocking.filter((f) => priorNonBlockingFiles.has(f.file));
  return {
    currentBlockingCount: currentBlocking.length,
    inflatedFindings,
    inflationRate:
      currentBlocking.length === 0 ? 0 : inflatedFindings.length / currentBlocking.length,
  };
}
