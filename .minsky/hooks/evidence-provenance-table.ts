// The shared "which tool calls discharge which claim" table (mt#4044).
//
// An EVIDENCE RECORD is a line whose function is to be proof that the author
// performed a check: `Duplicate check: searched …`, `Negative control — …`,
// `Execution evidence:`. mem#966 states the rule the class violates — the record
// is a claim about the author's OWN SESSION, and the author is its only witness,
// so a reader has no way to check it.
//
// What makes the class mechanizable, where the rest of `assertion-without-
// verification` (anchor mt#2544) is not, is stated in
// `duplicate-check-search-provenance.ts`'s header: the claim's target is the
// session, and the corresponding call either appears in the transcript's tool
// list or it does not. That property is a property of the CLAIM'S TARGET, not of
// the record type carrying it — which is why this table exists rather than a
// second copy of that guard per record type.
//
// DIRECTION OF ERROR IS NOT UNIFORM ACROSS THE TWO HALVES, and conflating them
// is the way to build a detector nobody trusts:
//
//   - RECOGNIZING a record (does this text claim something?). A phrase missed
//     here is a false NEGATIVE — a fabricated record goes unflagged. Safe.
//     Recall is bounded by the record's own sanctioned labels, which the corpus
//     enumerates, so this is not ADR-024's regex arms race.
//   - DISCHARGING a claim (did the corresponding call run?). A call shape missed
//     HERE is a false POSITIVE — the guard fires at an author who did the work.
//     Dangerous. So every discharge recognizer below is deliberately GENEROUS,
//     and the discriminating weight is carried by the join, not by the recognizer.
//
// @see .minsky/hooks/evidence-record-provenance.ts — the commit/PR-seam guard
// @see .minsky/hooks/duplicate-check-search-provenance.ts — the tasks_create guard
// @see mem#966 — the incident and the general rule

import type { ToolCallWithResult } from "./transcript";

// ---------------------------------------------------------------------------
// Tool-name normalization
// ---------------------------------------------------------------------------

/**
 * Transcripts carry both the MCP-prefixed and bare forms, and the dotted
 * canonical name and the underscore alias are both registered spellings of one
 * tool. Normalize before any membership test.
 */
export function normalizeToolName(raw: string): string {
  return raw
    .replace(/^mcp__minsky__/, "")
    .replace(/\./g, "_")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Discharge: a claimed SEARCH (the duplicate-check record, mt#4004)
// ---------------------------------------------------------------------------

/**
 * Tools whose invocation discharges a claimed duplicate search.
 *
 * `refs_status` is included because a record may legitimately say it
 * cross-referenced specific candidate ids rather than running a similarity
 * query — that is a search of the task graph by another route, and refusing to
 * count it would manufacture false positives on a correct process.
 */
export const SEARCH_TOOL_NAMES: readonly string[] = [
  "tasks_search",
  "tasks_similar",
  "refs_status",
];

/** True when any search tool was invoked in the transcript given. */
export function sessionRanASearch(toolNames: readonly string[]): boolean {
  return toolNames.some((raw) => SEARCH_TOOL_NAMES.includes(normalizeToolName(raw)));
}

// ---------------------------------------------------------------------------
// Discharge: a claimed TEST RUN (the execution-evidence and negative-control
// records, mt#4044)
// ---------------------------------------------------------------------------

/** The two tools through which this repo runs anything. */
const COMMAND_TOOL_NAMES: readonly string[] = ["bash", "session_exec"];

/**
 * A command that RUNS tests, as opposed to one that merely mentions them.
 *
 * Generous by design, per the direction-of-error note in this module's header:
 * an unrecognized runner spelling fires the guard at an author who ran their
 * tests. The `\b(?:bun|npm|…)\s` prefix requirement is the one narrowing kept,
 * because without it `grep -n "test:components" package.json` — a real call from
 * the originating session — reads as a test run.
 */
const TEST_RUN_COMMAND_RE =
  /\b(?:bun|bunx|npm|pnpm|yarn|npx|deno)\s+(?:run\s+)?(?:test\b|test:[\w-]+|vitest\b|jest\b|scripts\/run-tests[\w-]*)|\b(?:vitest|jest|pytest|mocha|ava)\b|\bgo\s+test\b|\bcargo\s+test\b/i;

/**
 * A test run that FAILED, read off the run's own output.
 *
 * Also generous: a failure spelling missed here is the dangerous direction. The
 * bun-test shapes (`(fail) <name>`, ` 1 fail`) are what this repo actually emits;
 * the rest cover the runners above. ` 0 fail` must NOT match, which is what the
 * leading non-zero digit class enforces — a green summary line literally contains
 * the word "fail".
 */
const FAILURE_MARKER_RE =
  /\(fail\)|\b[1-9]\d*\s+fail(?:ed|ing|ures?)?\b|\bFAIL\b|\bAssertionError\b|error:\s*expect\(/;

/** True when this call ran tests, whatever it returned. */
export function isTestRunningCall(call: ToolCallWithResult): boolean {
  if (!COMMAND_TOOL_NAMES.includes(normalizeToolName(call.toolName))) return false;
  const command = typeof call.input["command"] === "string" ? call.input["command"] : "";
  return TEST_RUN_COMMAND_RE.test(command);
}

/** True when any call in the transcript ran tests. */
export function sessionRanTests(calls: readonly ToolCallWithResult[]): boolean {
  return calls.some(isTestRunningCall);
}

/** Test runs whose OUTPUT reports at least one failure. */
export function failingTestRuns(calls: readonly ToolCallWithResult[]): ToolCallWithResult[] {
  return calls.filter((c) => isTestRunningCall(c) && FAILURE_MARKER_RE.test(c.resultText));
}

// ---------------------------------------------------------------------------
// The subject join
// ---------------------------------------------------------------------------

/**
 * Below this a token collides by accident. Mirrors `duplicate-signature-tokens`'
 * `MIN_TOKEN_LENGTH` — same problem, same corpus, same answer.
 */
export const MIN_SUBJECT_TOKEN_LENGTH = 8;

/** Cap on tokens carried into the join, so a long record cannot dominate. */
export const MAX_SUBJECT_TOKENS = 10;

/** A source or test path: `src/cockpit/web/pages/SharedConversationPage.test.tsx`. */
const PATH_RE = /\b[\w@][\w\-./]*\/[\w\-.]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|sh|py|go|rs)\b/g;

/** Content of a backticked span, which is where this corpus puts its subjects. */
const BACKTICK_RE = /`([^`\n]{1,160})`/g;

/**
 * Split a backticked span on the test-name separator.
 *
 * A negative control names its subject the way the runner prints it —
 * `SharedConversationPage > reads ONLY the public share endpoint`. The whole span
 * is NOT a usable token: bun prints the same test as
 * `SharedConversationPage (mt#4024) > reads ONLY …`, so an exact match on the
 * span fails against the very output that would discharge it. Both halves DO
 * appear verbatim, which is why the split is what makes the join work.
 */
function splitSubjectSpan(span: string): string[] {
  return span
    .split(/\s+[>›»]\s+/)
    .map((part) =>
      part
        .trim()
        .replace(/\([^)]*\)$/, "")
        .trim()
    )
    .filter((part) => part.length > 0);
}

/**
 * Unwrap soft line breaks before pairing backticks.
 *
 * FOUND BY REPLAY, not by review. A commit message wraps at ~80 columns, so a
 * backticked test name routinely straddles a newline:
 *
 *     Negative control — `SharedConversationPage > reads ONLY the public share
 *     endpoint`: swapping `NO_ENTITY_INDEX` for `useEntityIndex()` …
 *
 * `BACKTICK_RE` refuses to cross a newline (deliberately — an unterminated
 * backtick must not swallow a paragraph), so on the raw text the FIRST backtick
 * it sees on line two is the span's CLOSING one, and every pair after that is
 * off by one: the extracted "subject" of the real mt#4024 record came out as
 * `: swapping`. That token is junk, and junk is not a harmless miss here — it
 * joins against nothing, so the guard fires on a correctly-run control too.
 *
 * Fenced blocks are dropped first: their delimiters are backticks and would
 * re-introduce the same off-by-one this fixes.
 */
function unwrapForSpanScan(record: string): string {
  return record
    .replace(/^ {0,3}(?:```|~~~)[\s\S]*?^ {0,3}(?:```|~~~)[^\n]*$/gm, " ")
    .replace(/\s*\n\s*/g, " ");
}

/**
 * A span that starts with punctuation is a pairing artifact, not a subject.
 *
 * Second line of defence behind {@link unwrapForSpanScan}: the wrap shapes that
 * function does not anticipate produce spans like `: swapping` or `, then`, and
 * a token that cannot be a code identifier or a test name should never reach the
 * join.
 */
function looksLikeSubject(span: string): boolean {
  return /^[\w@/.]/.test(span);
}

/**
 * The literal strings whose appearance in a tool call is evidence that call was
 * about this record's subject.
 *
 * Paths first — the strongest and the commonest shape — then backticked spans.
 * Matching is EXACT substring: no stemming, no similarity, no metric. A record
 * with no extractable subject yields `[]`, which callers must treat as
 * "cannot adjudicate", never as "no evidence".
 */
export function extractSubjectTokens(record: string): string[] {
  const paths: string[] = [];
  const spans: string[] = [];
  const seen = new Set<string>();
  const push = (into: string[], text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length < MIN_SUBJECT_TOKEN_LENGTH || seen.has(trimmed)) return;
    if (into === spans && !looksLikeSubject(trimmed)) return;
    seen.add(trimmed);
    into.push(trimmed);
  };

  // Paths are scanned on the RAW text: they never wrap, and scanning the
  // unwrapped copy would join a line-final word to a line-initial path.
  for (const m of record.matchAll(PATH_RE)) {
    push(paths, (m[0] ?? "").replace(/:\d+(?::\d+)?$/, ""));
  }
  for (const m of unwrapForSpanScan(record).matchAll(BACKTICK_RE)) {
    for (const part of splitSubjectSpan(m[1] ?? "")) push(spans, part);
  }
  return [...paths, ...spans].slice(0, MAX_SUBJECT_TOKENS);
}

/** True when the call's command or its output names one of `tokens`. */
export function callNamesSubject(call: ToolCallWithResult, tokens: readonly string[]): boolean {
  const command = typeof call.input["command"] === "string" ? call.input["command"] : "";
  return tokens.some((t) => command.includes(t) || call.resultText.includes(t));
}

// ---------------------------------------------------------------------------
// The quoted-output join
// ---------------------------------------------------------------------------

/**
 * A failing-test line as the runner prints it: `(fail) <suite> > <case> [1.2ms]`.
 *
 * MEASURED, not anticipated. The subject join above assumes a record names the
 * TEST it ran; swept over 30 real sessions it fired on 31 of 84 negative-control
 * records, and a 4-of-4 sample of those fires were genuine, correctly-run
 * controls. The reason is uniform: a record names what the author REVERTED —
 * `closeTab`, `segment.includes`, `TURN_START_TAG_MATCHERS` — while the run's
 * output names the test that went red. The two vocabularies barely intersect, so
 * the join was measuring the wrong thing 37% of the time.
 *
 * What those records DO carry is the failing output itself, pasted. That is a far
 * better join key than any subject: it is long, distinctive, and — the point —
 * it cannot be produced without the run. A fabricated paste matches nothing and
 * still fires, which is the case this guard exists for.
 */
const QUOTED_FAILURE_LINE_RE = /^.*\(fail\).+$/gm;

/**
 * Below this a quoted line is too short to be evidence of anything. A bare
 * `(fail)` with a two-word test name could plausibly be typed from memory; a
 * full suite-plus-case line could not.
 */
const MIN_QUOTED_LINE_LENGTH = 30;

/** Failing-run lines the record quotes, as literal strings to look for. */
export function extractQuotedFailures(record: string): string[] {
  const out: string[] = [];
  for (const raw of record.match(QUOTED_FAILURE_LINE_RE) ?? []) {
    // Drop the runner's per-test duration: the paste and the live result agree
    // on the name but a re-run's timing differs, and the timing is the tail of
    // the line, so keeping it would defeat every comparison.
    const line = raw
      .trim()
      .replace(/\s*\[[\d.]+m?s\]\s*$/, "")
      .trim();
    if (line.length >= MIN_QUOTED_LINE_LENGTH && !out.includes(line)) out.push(line);
  }
  return out;
}

/** True when the call's output contains one of the record's quoted failure lines. */
export function callContainsQuotedFailure(
  call: ToolCallWithResult,
  quoted: readonly string[]
): boolean {
  return quoted.some((line) => call.resultText.includes(line));
}
