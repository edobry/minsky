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
 *
 * The prefix strip is server-AGNOSTIC (`mcp__<server>__`), not
 * `mcp__minsky__`-only. mt#4168 needed `mcp__github__pull_request_read`, and the
 * minsky-only strip left it unnormalized so the collision join silently matched
 * nothing — caught by that guard's own test, not by review. Widening is safe for
 * the pre-existing callers because every name they test for is a minsky tool,
 * which no other server also exposes.
 */
export function normalizeToolName(raw: string): string {
  return raw
    .replace(/^mcp__.*?__/, "")
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
// Discharge: a claimed FILE-LEVEL COLLISION (mt#4168, re-homed from mt#3806)
// ---------------------------------------------------------------------------

/**
 * `pull_request_read` methods that return a PR's actual changed-file list.
 *
 * `get_files` is the cheap default — it returns filenames, which IS the
 * question — and `get_diff` returns them too, inside the hunks. Every other
 * method (`get`, `get_reviews`, `get_status`, …) returns metadata a collision
 * claim cannot rest on, which is the whole point of mt#3806: a task's title, or
 * an inference about where that kind of code lives, is not evidence about which
 * files were touched.
 */
const PR_FILE_LIST_METHODS: readonly string[] = ["get_files", "get_diff"];

/** True when this call read some PR's changed-file list. */
export function isPrFileListCall(call: ToolCallWithResult): boolean {
  if (normalizeToolName(call.toolName) !== "pull_request_read") return false;
  const method = call.input["method"];
  return typeof method === "string" && PR_FILE_LIST_METHODS.includes(method);
}

/**
 * PR numbers whose changed-file list was actually read in this session.
 *
 * Returning the SET rather than a boolean is what makes the join specific: a
 * collision claim names a PR, and reading a DIFFERENT PR's files is not
 * evidence about this one. mem#892 is precisely that failure with the read
 * missing entirely; accepting any file-read at all would rebuild it one step up.
 */
export function prNumbersWithFileListRead(calls: readonly ToolCallWithResult[]): Set<number> {
  const out = new Set<number>();
  for (const call of calls) {
    if (!isPrFileListCall(call)) continue;
    const n = call.input["pullNumber"];
    if (typeof n === "number" && Number.isInteger(n)) out.add(n);
  }
  return out;
}

/**
 * True when this call is a path- or grep-filtered `git_log` — the evidence a
 * collision claim about a MERGE rests on, per gate (g) check 1.
 *
 * Generous by the header's direction-of-error rule: an unfiltered `git_log` is
 * excluded (it says nothing about a file), but either filter counts, because an
 * author chasing a merge legitimately reaches for either.
 */
export function isPathFilteredGitLogCall(call: ToolCallWithResult): boolean {
  if (normalizeToolName(call.toolName) !== "git_log") return false;
  const path = call.input["path"];
  const grep = call.input["grep"];
  return (typeof path === "string" && path !== "") || (typeof grep === "string" && grep !== "");
}

/** True when any call in the transcript read a merge's file-level history. */
export function sessionReadMergeHistory(calls: readonly ToolCallWithResult[]): boolean {
  return calls.some(isPathFilteredGitLogCall);
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

// ---------------------------------------------------------------------------
// Discharge: a claimed CONSUMER SWEEP — which directories did it cover?
// (mt#4171, gate (h))
// ---------------------------------------------------------------------------
//
// The section above answers "did a search run?" (mt#4004). This one answers the
// strictly stronger question gate (h) turns on: "the sweep ran — did it reach
// the directories the gate prescribes?" Same substrate, one more field read.
//
// WHY THIS PARSES A COMMAND STRING, when mt#4171's spec says the directories
// arrive as structured arguments. They mostly do not. Measured over the 589
// on-disk transcripts in this project (2026-08-19), by tool name:
//
//     Bash                       27561
//     session_grep_search          339
//     repo_search                  180
//     Grep                          21
//     git_search                     9
//     Glob                           5
//
// So ~98% of this repo's search activity is a shell command, and a recognizer
// reading only structured `path` arguments would be blind to nearly all of it —
// the inert-probe shape of mem#1020, one level up from a test fixture. A
// command string is still not a paraphrase axis: it is a structured artifact
// matched against a FIXED directory list, the same matcher class as
// `block-secret-file-read`'s reader+path pairs and the chained-verification
// scanner, both of which ship denying. ADR-024's ladder does not govern it.
//
// DIRECTION OF ERROR, per this module's header, decides every judgment call
// below: a directory this MISSES becomes a false POSITIVE — the guard telling
// an author who swept `docs/` that they did not. So the recognizer is
// deliberately over-generous in every ambiguous case, and the discriminating
// weight sits on the join.

/** Tools whose invocation can constitute part of a consumer sweep. */
const SWEEP_TOOL_NAMES: readonly string[] = [
  "bash",
  "session_exec",
  "grep",
  "glob",
  "session_grep_search",
  "repo_search",
  "git_search",
  "session_search",
];

/**
 * The shell commands that SEARCH, as opposed to ones that merely name a path.
 *
 * `cat`/`sed`/`head` are excluded on purpose: reading one file is not a sweep of
 * its directory, and crediting it would discharge gate (h) on a single-file
 * read — the exact "enumerated 25+ sites and missed a class" shape (mt#1610)
 * this check exists to catch.
 */
const SWEEP_COMMAND_RE = /\b(?:grep|rg|ugrep|ag|ack|find|fd|fgrep|egrep|ls)\b/;

/**
 * The top-level directories gate (h)'s consumer table can prescribe.
 *
 * A FIXED list, which is what keeps this a lookup rather than a parse. Anything
 * outside it is not a directory the gate ever asks about, so there is nothing to
 * be wrong about.
 */
export const PRESCRIBABLE_DIRECTORIES: readonly string[] = [
  "src",
  "tests",
  "services",
  "scripts",
  "docs",
  "packages",
  ".github",
  ".claude",
  ".minsky",
  "contract",
];

/**
 * A search naming no path at all sweeps the whole tree from cwd, so it covers
 * every prescribable directory. Recognizing this is what keeps the common
 * `grep -rn "<sym>" .` and a bare `rg <sym>` from reading as zero coverage —
 * the single largest false-positive source if it were missed.
 *
 * THE FIRST VERSION OF THIS WAS A CAN'T-FAIL PROBE, and the replay is what said
 * so. It ended in `…(?:\s\.\s|\s\.$|$)/m`, and that trailing `$` matches the end
 * of any line — so EVERY grep took the whole-tree branch and credited all ten
 * directories. The measured output was the tell rather than the code: `contract`
 * came back swept in 86.4% of READY transitions, which is not a thing anyone
 * does. mem#704 — a probe returning the same result whether or not the system
 * did the work is not verification — and the same shape mem#1020 records one
 * level down at the fixture.
 *
 * `grep` is deliberately NOT in the no-operand list below. With no path operand
 * `grep` reads STDIN (it is the tail of a pipe), which sweeps nothing; `rg`,
 * `ag`, `ack` and `fd` default to the working tree. Treating them alike is what
 * produced the 86% above.
 */
const EXPLICIT_CWD_OPERAND_RE = /(?:^|\s)\.(?=\s|$)/;
const TREE_DEFAULTING_COMMAND_RE = /(?:^|[\s|(])(?:rg|ugrep|ag|ack|fd)\b/;
const PATH_OPERAND_RE = /(?:^|\s)(?:--include=)?["']?[\w@.][\w\-./]*\//;

/**
 * Split a command string into the segments a shell would run separately.
 *
 * A SINGLE `|` is deliberately NOT a separator, and this cost a real defect. A
 * grep alternation carries literal pipes — `grep -rn "A\s*=\|B\s*=" src/foo.ts`
 * is one command — so splitting on `|` tore the pattern away from its path
 * operand, leaving a segment with a search verb and no directory and another
 * with a directory and no verb. The guard's own liveness test caught it on a
 * fixture quoted verbatim from the mt#4252 session (mem#1020: assert a fixture
 * matches SOMETHING before asserting what it does not match).
 *
 * Keeping a pipeline whole is also the right reading: in `grep -rn foo src/ |
 * head`, the path belongs to the searcher, and a path introduced later in the
 * pipeline only ever over-credits, which is the safe direction here.
 */
function commandSegments(command: string): string[] {
  return command.split(/(?:\n|;|&&|\|\|)/);
}

/**
 * True when a segment searches the whole tree: either it names `.` explicitly,
 * or it runs a tree-defaulting searcher with no path operand at all.
 */
function sweepsWholeTree(segment: string): boolean {
  if (!SWEEP_COMMAND_RE.test(segment)) return false;
  if (EXPLICIT_CWD_OPERAND_RE.test(segment)) return true;
  return TREE_DEFAULTING_COMMAND_RE.test(segment) && !PATH_OPERAND_RE.test(segment);
}

/**
 * Directories this ONE call demonstrably searched.
 *
 * Token-membership against {@link PRESCRIBABLE_DIRECTORIES}, NOT argument-position
 * parsing. A pattern that merely MENTIONS `src/` (`grep -rn "src/cockpit" .`)
 * credits `src` — which is over-crediting, and over-crediting is the safe
 * direction here. Argument-position parsing would be more precise and would fail
 * in the dangerous direction on every flag spelling it did not anticipate.
 */
export function sweptDirectories(call: ToolCallWithResult): string[] {
  if (!SWEEP_TOOL_NAMES.includes(normalizeToolName(call.toolName))) return [];

  const isShell = ["bash", "session_exec"].includes(normalizeToolName(call.toolName));

  if (isShell) {
    const command = call.input["command"];
    if (typeof command !== "string" || command === "") return [];
    // PER SEGMENT, and this is the whole correctness of the shell path.
    //
    // The first version asked "does ANY segment run a search?" and then pulled
    // directory tokens from the WHOLE command string. That pairs a verb from one
    // segment with a path from another — the same defect CLAUDE.md records for a
    // `grep -E` over a test log, where the filter dropped the structure binding a
    // line to its block and the pairing read as one record.
    //
    // Measured on the mt#4252 session (2026-08-19): one `Bash` call ran
    // `grep -rn … src/cockpit/principal-channel-poller.ts` in one segment and
    // `sed -n '1,80p' docs/architecture/adr-035-….md` in another. `docs` was
    // credited as SWEPT off a single-file `sed` read that shares a command with
    // an unrelated grep — and that false credit is precisely what suppressed the
    // guard on its own originating incident.
    const covered = new Set<string>();
    for (const segment of commandSegments(command)) {
      if (!SWEEP_COMMAND_RE.test(segment)) continue;
      if (sweepsWholeTree(segment)) {
        for (const dir of PRESCRIBABLE_DIRECTORIES) covered.add(dir);
        continue;
      }
      for (const dir of directoriesNamedIn(segment)) covered.add(dir);
    }
    return [...covered];
  }

  // A structured search tool: every field it exposes is part of ONE search, so
  // there are no segments to keep apart.
  const parts: string[] = [];
  for (const field of ["path", "pattern", "include_pattern", "query", "glob"]) {
    const value = call.input[field];
    if (typeof value === "string" && value !== "") parts.push(value);
  }
  if (parts.length === 0) return [];
  return directoriesNamedIn(parts.join(" "));
}

/**
 * The prescribable directories a single search expression sweeps.
 *
 * A SUBTREE IS NOT THE DIRECTORY, and this distinction is the whole check. A
 * search naming `docs/architecture/adr-*.md` has not swept `docs/` — it has read
 * one subtree under a glob that structurally cannot reach `docs/principal-channel.md`.
 * Crediting it would be mt#4215's defect in the guard itself: a path argument
 * that names a directory is not proof the directory was searched.
 *
 * Measured (2026-08-19): this is exactly how mt#4252 escaped an earlier revision.
 * That session ran
 * `grep -rln "principal-channel\\|principal channel" docs/architecture/adr-*.md`,
 * which credited `docs` and suppressed the guard on its own originating
 * incident — while the file the change falsified sits at the `docs/` root, one
 * level above everything that grep could see.
 *
 * So a reference counts only when it addresses the directory ITSELF: `docs/`,
 * `docs/*`, `docs/**`, or a file directly inside it. `docs/<subdir>/…` does not.
 * This trades a small false-positive risk (an author who sweeps several subtrees
 * separately reads as not having swept the root) for not silently discharging the
 * claim the gate exists to check — and the guard is record-only, so that risk
 * costs a calibration record rather than a denial.
 */
function directoriesNamedIn(text: string): string[] {
  const covered: string[] = [];
  for (const dir of PRESCRIBABLE_DIRECTORIES) {
    // `dir/` preceded by a separator (so `srcfoo` does not credit `src`, and a
    // bare word `docs` in a pattern does not either — a directory reference
    // carries a slash), and NOT followed by a further `<component>/`.
    const re = new RegExp(`(?:^|[\\s"'=(])${dir.replace(".", "\\.")}/(?![\\w.-]+/)`);
    if (re.test(text)) covered.push(dir);
  }
  return covered;
}

/** Every prescribable directory the session's sweep calls reached, unioned. */
export function sessionSweptDirectories(calls: readonly ToolCallWithResult[]): Set<string> {
  const covered = new Set<string>();
  for (const call of calls) for (const dir of sweptDirectories(call)) covered.add(dir);
  return covered;
}
