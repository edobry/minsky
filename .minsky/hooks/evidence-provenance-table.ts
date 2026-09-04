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

import type { ToolCallWithResult, TranscriptLine } from "./transcript";
import { findToolUseInputsMatching } from "./transcript";
import { nonFlagOperands, suppliesPattern } from "./command-shape";

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
// Discharge: the claimed search's QUERY, not merely its occurrence (mt#4975)
// ---------------------------------------------------------------------------

/**
 * The subset of {@link SEARCH_TOOL_NAMES} that carries a natural-language
 * `query` argument.
 *
 * `refs_status` is deliberately absent: it takes `refs` (an id array), not a
 * query, so there is nothing for a query comparison to read. A record whose
 * claim is a cross-reference rather than a query names no quoted query either,
 * and therefore takes the presence branch — which is exactly today's behavior
 * for it, preserved on purpose. See {@link namedQueryWasRun}.
 */
export const QUERY_BEARING_SEARCH_TOOLS: readonly string[] = ["tasks_search", "tasks_similar"];

/**
 * Verbs that introduce a claimed query, and the window after one in which a
 * quoted span is read AS that query.
 *
 * The window is what makes this a query extractor rather than a quote
 * extractor, and it is load-bearing. Duplicate-check records quote plenty of
 * things that are not queries — task titles, verdict prose, criteria. Measured
 * over the live log (2026-09-04), taking EVERY quoted span misread a record
 * whose only quote was the prose `"a Class B guarantee trade owned by mt#2718 /
 * mt#3526, needing a measured before/after and principal sign-off"` as a query
 * that had never been run, i.e. it manufactured the exact false positive this
 * guard's stated direction of error forbids.
 */
const NAMED_QUERY_VERB_RE =
  /\b(?:searched|queried|grepped|cross-referenced|ran\s+(?:a\s+)?(?:`?tasks[_.]s(?:earch|imilar)`?|search))\b/gi;
const QUOTED_SPAN_RE = /"([^"]{10,300})"|“([^”]{10,300})”|`([^`]{10,300})`/g;
const NAMED_QUERY_WINDOW = 250;

/** Words carrying no discriminating power in a task-search query. */
const QUERY_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "is",
  "it",
  "that",
  "this",
  "with",
  "as",
  "at",
  "by",
  "from",
  "not",
]);

/**
 * The record's claimed queries: quoted spans of 3+ words that a search verb
 * introduces within {@link NAMED_QUERY_WINDOW} characters.
 *
 * Returns empty when the record claims a search without quoting one — a common
 * and legitimate form ("Searched for calibration/telemetry migration
 * coverage."). An empty result means "nothing to compare", never "no search
 * was claimed"; the caller falls back to presence rather than flagging.
 */
export function extractNamedQueries(record: string): string[] {
  const out: string[] = [];
  NAMED_QUERY_VERB_RE.lastIndex = 0;
  let verb: RegExpExecArray | null;
  while ((verb = NAMED_QUERY_VERB_RE.exec(record)) !== null) {
    const window = record.slice(verb.index, verb.index + NAMED_QUERY_WINDOW);
    QUOTED_SPAN_RE.lastIndex = 0;
    let quoted: RegExpExecArray | null;
    while ((quoted = QUOTED_SPAN_RE.exec(window)) !== null) {
      const span = (quoted[1] ?? quoted[2] ?? quoted[3] ?? "").replace(/\s+/g, " ").trim();
      // A 1-2 word span is the tool name itself (`tasks_search`), not a query.
      if (span.split(/\s+/).length >= 3 && !out.includes(span)) out.push(span);
    }
  }
  return out;
}

/** Normalize a query to its discriminating tokens (case, punctuation, stopwords). */
function queryTokens(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .replace(/[^a-z0-9\s#_-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !QUERY_STOPWORDS.has(t))
  );
}

/**
 * Fraction of the NAMED query's tokens present in an actual one.
 *
 * Deliberately asymmetric — it asks whether the claim is COVERED by a real
 * call, so an author who refined a query by ADDING terms still discharges at
 * 1.0. That is the direction that matters: a missed match fires at someone who
 * did the work.
 */
export function queryTokenCoverage(named: string, actual: string): number {
  const a = queryTokens(named);
  if (a.size === 0) return 0;
  const b = queryTokens(actual);
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size;
}

/**
 * Coverage at or above which a named query counts as having been run.
 *
 * **Measured, not chosen round** (`decision-defaults.mdc §Thresholds`). Replaying
 * all 30 `search claim matched a call` records in the live log on 2026-09-04,
 * 23 named a query and their best-coverage scores were strongly bimodal:
 *
 *   21 records at 1.00 — the author quoted the query verbatim
 *    1 record  at 0.67 — the 19:02:20 incident (queries composed, never run)
 *    1 record  at 0.33 — a second, independently verified fabrication
 *
 * Nothing landed between 0.67 and 1.00, so every threshold in that open band
 * yields the identical split (2 flagged / 21 cleared) and the value is not
 * knife-edge. 0.75 is taken at the PERMISSIVE end of the empty band rather than
 * its midpoint, so that dropping one token from a four-token query still
 * discharges — again the safe direction.
 */
export const NAMED_QUERY_COVERAGE_THRESHOLD = 0.75;

/** Every `query` argument passed to a query-bearing search tool this session. */
export function sessionSearchQueries(lines: readonly TranscriptLine[]): string[] {
  const inputs = findToolUseInputsMatching(lines as TranscriptLine[], (raw) =>
    QUERY_BEARING_SEARCH_TOOLS.includes(normalizeToolName(raw))
  );
  return inputs
    .map((input) => input["query"])
    .filter((q): q is string => typeof q === "string" && q.trim() !== "");
}

/**
 * True when at least one claimed query is covered by at least one actual one.
 *
 * A record naming several queries discharges on ANY of them matching: partial
 * provenance is a record-quality issue, not the fabrication this guard exists
 * to catch, and flagging it would fire at authors who ran most of what they
 * wrote.
 */
export function namedQueryWasRun(
  namedQueries: readonly string[],
  actualQueries: readonly string[]
): boolean {
  return namedQueries.some((named) =>
    actualQueries.some(
      (actual) => queryTokenCoverage(named, actual) >= NAMED_QUERY_COVERAGE_THRESHOLD
    )
  );
}

// ---------------------------------------------------------------------------
// Discharge: a claimed REMAINING-WORK assertion about another task (mt#4299)
// ---------------------------------------------------------------------------

/**
 * Tools whose invocation reads a task's CURRENT state.
 *
 * GENEROUS on purpose, per this module's header: a status read missed here
 * fires the guard at an author who looked the task up. All four are ordinary
 * ways to answer "what state is that task in?", and refusing any of them would
 * flag correct process.
 *
 * `refs_status` sits in BOTH this set and {@link SEARCH_TOOL_NAMES}, and that is
 * not a conflict. It is already there because a duplicate-check record may
 * legitimately say it cross-referenced specific candidate ids; it is equally a
 * BULK status read, which is what makes it the most efficient correct form when
 * a claim names several tasks. Omitting it here would fire hardest at the author
 * who used one call instead of four.
 *
 * `tasks_list` is deliberately ABSENT. It returns many tasks and would discharge
 * any claim about any of them from a call the author may never have read for
 * that purpose — presence-only discharge, which is the weakness mt#4190 measured
 * on the ownership half (25 claims, 25 discharged, subject-blind).
 *
 * The CLI spelling (`minsky tasks status get …` through `Bash`/`session_exec`) is
 * also absent, and unlike `tasks_list` that is a recall gap rather than a design
 * choice. It is left out because it is UNMEASURED here: the PR-read fallback in
 * `prNumbersFromCommandFileListRead` was added only after mt#4190's replay
 * produced verbatim misses to point at. Add this one the same way — on measured
 * fires, not on anticipation.
 */
export const STATUS_READ_TOOL_NAMES: readonly string[] = [
  "tasks_status_get",
  "tasks_get",
  "tasks_spec_get",
  "refs_status",
];

/**
 * One canonical spelling for a task id, so the join is not defeated by
 * punctuation.
 *
 * `mt#4299`, `mt4299` and `MT#4299` are one id — the substrate itself stores the
 * unpunctuated form (`presence_claims.subject_id` is `mt4299`), so both spellings
 * are in live circulation and a literal comparison would miss across them.
 */
export function normalizeTaskId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Task ids whose CURRENT state was actually read in this session.
 *
 * Returning the SET rather than a boolean is what makes this join specific, and
 * the specificity is the whole point of the class it serves: a remaining-work
 * claim is about ONE task, and reading a DIFFERENT task's status is not evidence
 * about it. That is strictly stronger than {@link sessionRanASearch}, which is
 * presence-only — mt#4190 measured what presence-only discharge costs, and the
 * answer was a half that discharged 25 of 25 and therefore never fired.
 *
 * `refs_status` takes an ARRAY, so the match looks INSIDE it rather than at a
 * scalar field. Its refs may also be PR numbers or `mem#N` / `ask#N` short ids;
 * those normalize to strings that no task id can equal, so they are inert here
 * rather than needing to be filtered out.
 */
export function taskIdsWithStatusRead(calls: readonly ToolCallWithResult[]): Set<string> {
  const out = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const id = normalizeTaskId(value);
    if (id !== "") out.add(id);
  };
  for (const call of calls) {
    const name = normalizeToolName(call.toolName);
    if (!STATUS_READ_TOOL_NAMES.includes(name)) continue;
    if (name === "refs_status") {
      const refs = call.input["refs"];
      for (const ref of Array.isArray(refs) ? refs : [refs]) add(ref);
      continue;
    }
    add(call.input["taskId"]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discharge: a claim about what another task's RECORD SAYS (mt#4876)
// ---------------------------------------------------------------------------

/**
 * Tool spellings that surface a task's SPEC BODY.
 *
 * Deliberately a STRICT SUBSET of {@link STATUS_READ_TOOL_NAMES}, and the
 * difference is the entire point of the class this serves. That set answers
 * "was this task's current STATE read?" and correctly counts `tasks_status_get`
 * and `refs_status`, both of which return a lifecycle position and no prose. A
 * claim about what a task's record SAYS cannot rest on either.
 *
 * The originating incident is exactly this gap, not a hypothetical: on
 * 2026-09-01 an agent wrote *"consistent with mt#4753 being BLOCKED"* into
 * mt#4864's spec, sourced from mt#4753's TITLE — whose own text carries the
 * disclaimer *"(not the same-account case this was filed for)"*. mt#4753's BODY
 * records the opposite: its premise was falsified 2026-08-29 and its §Experiment
 * concludes *"No code change is needed for a same-account repo."* A title plus a
 * status is what `tasks_get` returns without `includeSpec`, and `tasks_get` is in
 * the status set — so the wider join would have DISCHARGED the claim it exists to
 * catch. This is `check-task-spec-read.ts`'s own principle applied to a join:
 * *"A status field says where a task sits in the lifecycle. Only its BODY says
 * whether it is still worth doing."*
 *
 * `tasks_get` appears here too, but conditionally — see {@link taskIdsWithSpecRead}.
 */
export const SPEC_CONTENT_READ_TOOL_NAMES: readonly string[] = ["tasks_spec_get", "tasks_get"];

/**
 * Tool spellings whose call AUTHORS a task's spec body, keyed by the input field
 * whose presence makes the call a spec write.
 *
 * Authorship counts as content engagement for the same reason `specWasAuthored`
 * credits it in `check-task-spec-read.ts` (mt#2814): writing a spec addressed to a
 * task id requires having its content in hand, and is at least as strong a signal
 * as reading it. Without this, a session that amends mt#X's spec and then explains
 * something by reference to mt#X fires — at an author who demonstrably engaged the
 * record.
 *
 * `tasks_edit` is gated on a spec-writing field rather than counted outright: a
 * metadata-only edit (`--kind`, `--title`, `--tag`) touches no prose, which mirrors
 * `editHasSpecContent` in the spec-read guard. `tasks_create` is absent because a
 * task being born carries no id anyone could have engaged with.
 */
const SPEC_AUTHOR_FIELD_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  tasks_spec_patch: ["content"],
  tasks_spec_search_replace: ["replace"],
  tasks_edit: ["specContent", "spec", "specFile"],
};

/**
 * An affirmative flag value, accepting the spellings a flag actually arrives in.
 *
 * NOT bare truthiness (PR #3554 R1, BLOCKING). `!input["includeSpec"]` credits any
 * non-empty string, so `includeSpec: "false"` and `includeSpec: "0"` would both
 * count as a spec read. The error direction is what makes this worth a helper
 * rather than a cast: an over-credited read FALSELY DISCHARGES a claim, silencing
 * the guard on exactly the case it exists to catch, and it does so silently.
 *
 * `tasks_edit`'s `--spec` is a boolean flag on the CLI, and a shell-shaped caller
 * spells booleans as strings, so the string forms are accepted deliberately rather
 * than defensively — but only the affirmative ones.
 */
function isAffirmative(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/**
 * A spec-writing field that actually carries a spec.
 *
 * `!== undefined` is not enough (PR #3554 R1, BLOCKING): `specContent: null` and
 * `specContent: ""` both pass a presence test while writing no prose, and would
 * grant content-read credit for a call that engaged nothing. `spec` is the one
 * boolean member of the set — it opens the spec for an interactive edit — so it is
 * judged by {@link isAffirmative} rather than by length.
 */
function carriesAuthoredSpec(field: string, value: unknown): boolean {
  if (field === "spec") return isAffirmative(value);
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Task ids whose spec BODY was read or authored in this session.
 *
 * Returning a SET, per {@link taskIdsWithStatusRead}'s reasoning: the claim is
 * about ONE task, and engaging a DIFFERENT task's body is not evidence about it.
 *
 * `tasks_get` counts ONLY with a truthy `includeSpec`. That is not defensive
 * coding — a bare `tasks_get` returns title, status, kind and tags, which is
 * precisely the surface the originating incident mistook for the record. The MCP
 * gate and the CLI's `--include-spec` are the same gate, and
 * `check-task-spec-read.ts` already draws the line in the same place.
 *
 * KNOWN RECALL GAP, named rather than guessed at: the CLI spellings
 * (`minsky tasks spec get …` / `minsky tasks get --include-spec` through `Bash` or
 * `session_exec`) are NOT matched here. This module's own note on
 * `STATUS_READ_TOOL_NAMES` sets the discipline for that omission — the CLI channel
 * is left out because it is UNMEASURED, and should be added "on measured fires, not
 * on anticipation." The direction of error is a FALSE FIRE at an author who read
 * the spec through the CLI, which is the dangerous direction, so this gap is the
 * first thing to check when classifying calibration records. Recovering it needs
 * the command-manifest resolution `check-task-spec-read.ts` performs
 * (`cliSpecEngagements`), which is why it is not a one-line addition.
 */
export function taskIdsWithSpecRead(calls: readonly ToolCallWithResult[]): Set<string> {
  const out = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const id = normalizeTaskId(value);
    if (id !== "") out.add(id);
  };

  for (const call of calls) {
    const name = normalizeToolName(call.toolName);

    if (SPEC_CONTENT_READ_TOOL_NAMES.includes(name)) {
      if (name === "tasks_get" && !isAffirmative(call.input["includeSpec"])) continue;
      add(call.input["taskId"]);
      continue;
    }

    const authorFields = SPEC_AUTHOR_FIELD_BY_TOOL[name];
    if (authorFields && authorFields.some((f) => carriesAuthoredSpec(f, call.input[f]))) {
      add(call.input["taskId"]);
    }
  }

  return out;
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
 * The SAME read, performed through the shell (mt#4190).
 *
 * `isPrFileListCall` recognizes exactly one spelling — the `pull_request_read`
 * MCP tool — and the corpus demonstrably does not always use it. Two verbatim
 * examples from fired specs, both gate-(g) work done correctly:
 *
 *   "Open PRs read via `gh api .../files`: #3070 … #3068 … #2945 …"
 *   "PR #3098 via `get_files`, the other 11 via `git diff --name-only …`"
 *
 * The fallback is not a stylistic preference. mt#3779 records the standing
 * cause: the github MCP server dies when the Docker daemon is down and
 * `pull_request_read` answers "No such tool available", so the shell is what is
 * left. A guard blind to it fires hardest at the authors doing the most careful
 * parallel-work checking — the dangerous direction this module's header names,
 * and the reason every discharge recognizer here is deliberately generous.
 *
 * The PR NUMBER is extracted rather than the call merely counted, so the join
 * stays PR-specific. A read that cannot be tied to a number does not belong
 * here; it discharges the merge-shaped claim below instead.
 */
/**
 * Held as SOURCE STRINGS, and compiled fresh on each call (PR #3139 R1).
 *
 * A module-level `g`-flagged literal carries mutable `lastIndex` state shared by
 * every caller. Today nothing here advances it — `matchAll` clones the regex
 * rather than stepping the original, so repeated calls return identical results,
 * and the reported skip does not reproduce. But that safety is a property of
 * WHICH METHOD the call site happens to use: swap one `matchAll` for `.test()`
 * or `.exec()` later and the shared state starts stepping, silently, in a
 * discharge recognizer whose failure direction is firing at an author who did
 * the work.
 *
 * Compiling per call removes the class instead of documenting it. The cost is a
 * regex construction on a path that runs once per tool call in a transcript
 * scan; the benefit is that no future edit to this function can reintroduce it.
 */
const CLI_PR_FILE_LIST_SOURCES: readonly string[] = [
  // `gh api repos/<owner>/<repo>/pulls/<N>/files`, quoted or not, with or
  // without a query string.
  String.raw`\bgh\s+api\s+\S*?\bpulls\/(\d+)\/files`,
  // `gh pr diff <N> --name-only` / `gh pr view <N> --json files`.
  String.raw`\bgh\s+pr\s+(?:diff|view)\s+(\d+)\b[^\n]*?(?:--name-only|--json\s+[\w,]*files)`,
];

export function prNumbersFromCommandFileListRead(call: ToolCallWithResult): number[] {
  if (!COMMAND_TOOL_NAMES.includes(normalizeToolName(call.toolName))) return [];
  const command = typeof call.input["command"] === "string" ? call.input["command"] : "";
  const out: number[] = [];
  for (const source of CLI_PR_FILE_LIST_SOURCES) {
    for (const m of command.matchAll(new RegExp(source, "gi"))) {
      const n = Number.parseInt(m[1] ?? "", 10);
      if (Number.isInteger(n)) out.push(n);
    }
  }
  return out;
}

/**
 * PR numbers whose changed-file list was actually read in this session, through
 * the MCP tool OR the shell.
 *
 * Returning the SET rather than a boolean is what makes the join specific: a
 * collision claim names a PR, and reading a DIFFERENT PR's files is not
 * evidence about this one. mem#892 is precisely that failure with the read
 * missing entirely; accepting any file-read at all would rebuild it one step up.
 */
export function prNumbersWithFileListRead(calls: readonly ToolCallWithResult[]): Set<number> {
  const out = new Set<number>();
  for (const call of calls) {
    if (isPrFileListCall(call)) {
      const n = call.input["pullNumber"];
      if (typeof n === "number" && Number.isInteger(n)) out.add(n);
      continue;
    }
    for (const n of prNumbersFromCommandFileListRead(call)) out.add(n);
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

/**
 * A branch-range file listing: `git diff --name-only <ref>...<ref>`.
 *
 * The same evidence class as the path-filtered `git_log` above — a file-level
 * read of what some other work touched — reached through the shell. It names no
 * PR, so it cannot discharge a claim ABOUT a numbered PR; it discharges the
 * merge-shaped claim, which is exactly what `git_log --path` already does.
 *
 * The `--name-only` (or `--name-status`) flag is required. A plain `git diff`
 * prints hunks and is used for a hundred unrelated reasons; the name-listing
 * flags are what make the call a changed-file enumeration.
 */
const BRANCH_RANGE_FILE_DIFF_RE = /\bgit\s+diff\b[^\n]*--name-(?:only|status)\b/i;

export function isBranchRangeFileDiffCall(call: ToolCallWithResult): boolean {
  if (!COMMAND_TOOL_NAMES.includes(normalizeToolName(call.toolName))) return false;
  const command = typeof call.input["command"] === "string" ? call.input["command"] : "";
  return BRANCH_RANGE_FILE_DIFF_RE.test(command);
}

/** True when any call in the transcript read a merge's file-level history. */
export function sessionReadMergeHistory(calls: readonly ToolCallWithResult[]): boolean {
  return calls.some((c) => isPathFilteredGitLogCall(c) || isBranchRangeFileDiffCall(c));
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
// Discharge, part 2: WHICH check, and did it observe the tree being shipped?
// (mt#4236)
// ---------------------------------------------------------------------------
//
// Everything above answers "did a run happen". This section answers the two
// questions that come apart from it. Their ORDER is a correction mt#4236's
// planning pass made after reading the source, not the order its spec was
// originally written in:
//
//   1. GRANULARITY comes first. `Execution evidence:` names a BLOCK, and a block
//      routinely asserts a test run, a typecheck, a lint pass and a format check
//      at once. {@link sessionRanTests} collapses all of them into one boolean
//      about tests, so a typecheck result pasted into that block is not
//      adjudicated AT ALL — fresh, stale or fabricated alike. mt#4236's own
//      originating instance is of this class: PR #3082 pasted
//      `validate_typecheck … errorCount: 0` and CI then failed to compile a file
//      that same run HAD covered.
//   2. ORDERING second, and it applies to every kind including the test one: a
//      run that really happened, before the last edit to the files it describes,
//      discharges a record exactly as a fresh one does.
//
// DIRECTION OF ERROR SPLITS ACROSS THE TWO RECOGNIZERS HERE, and conflating them
// would rebuild the failure this module's header warns about one level up:
//
//   - CLAIMING a kind (does this block assert a typecheck?) creates an
//     OBLIGATION to find one, so recognizing a kind the block does not actually
//     assert is a false POSITIVE — the guard telling an author who never claimed
//     a typecheck that their typecheck is missing. The claim recognizers are
//     therefore CONSERVATIVE: they key on invocation and result spellings a block
//     can only carry by having PASTED a run, never on the English word. Prose
//     reading "typecheck is clean" is deliberately invisible to them; that miss
//     is a false negative, which is the safe direction.
//   - RUNNING a kind (did this call run a typecheck?) is an ordinary discharge
//     recognizer, so it follows the header's rule and is GENEROUS.
//
// The header states this asymmetry across RECORD TYPES; this is the same
// asymmetry within ONE record, and it points the opposite way for the first half.

/** A check whose result an `Execution evidence:` block can assert. */
export type CheckKind = "test" | "typecheck" | "lint" | "format";

/** Every kind, in the order a block's claims are judged. */
export const CHECK_KINDS: readonly CheckKind[] = ["test", "typecheck", "lint", "format"];

interface CheckKindSpec {
  /** MCP tools whose invocation IS a run of this kind. */
  toolNames: readonly string[];
  /** Shell command shapes that run this kind. Generous — a miss fires the guard. */
  commandRe: RegExp;
  /** What a block must carry to be ASSERTING this kind. Conservative — see above. */
  claimRe: RegExp;
  /**
   * Files a run of this kind reads, as a test on the written path.
   *
   * `null` means the kind's file set is NOT derivable from a path, so ordering
   * against it records `not-comparable` rather than a guess. `format` is the
   * real instance rather than a hypothetical one: prettier's file set is decided
   * by `.prettierrc` and `.prettierignore`, spans nearly every extension in the
   * tree, and this module does not read either — so any answer it gave would be
   * invented.
   *
   * The included sets are deliberately NARROW, because this is the one place in
   * this module where over-inclusion is the DANGEROUS direction: an extension
   * wrongly listed turns an unrelated edit into a `stale-evidence` fire. A
   * `tsconfig*.json` edit genuinely does invalidate a typecheck and is genuinely
   * absent below for that reason — it is a known false negative, taken on
   * purpose.
   *
   * None of these carry the `g` flag: a `g`-flagged literal shared across calls
   * carries mutable `lastIndex` state, which PR #3139 R1 removed from this
   * module's other recognizers for exactly the reason it would bite here.
   */
  coverageRe: RegExp | null;
}

const TS_ONLY_RE = /\.(?:ts|tsx|mts|cts)$/i;
const TS_OR_JS_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/**
 * A package-runner invocation — what makes a token a PASTED COMMAND rather than
 * an English noun (PR #3165 R1).
 *
 * The first cut of the claim recognizers listed bare tool nouns: `\btsc\b`,
 * `\beslint\b`, `\bprettier\b`, plus a bare `\berrorCount\b`. Every one of them
 * matches ordinary prose — "eslint is clean", "tsc passed locally" — which is the
 * exact opposite of what the comment three paragraphs above promises ("Prose
 * reading 'typecheck is clean' is deliberately invisible"). A claim recognizer
 * that fires on prose manufactures an obligation the author never took on, and
 * the guard then reports a missing typecheck to someone who never claimed one.
 *
 * `\berrorCount\b` was worse than merely loose, because it is not even
 * kind-specific: `validate_lint` reports `errorCount` too, so a lint-only block
 * was read as claiming a TYPECHECK. This PR's own body is the proof — it pastes
 * `errorCount: 0  warningCount: 0  fileCount: 3820` under `validate_lint`. It is
 * removed rather than narrowed; `validate_typecheck` and `error TS<n>` are
 * kind-specific and cover the same records.
 *
 * So a claim now needs a RUNNER PREFIX (`bun run lint`, `bunx eslint`), a
 * flag-bearing invocation (`tsc --noEmit`, `eslint --fix`), a script-name shape
 * (`format:check`), a tool name that is not an English word (`validate_lint`),
 * or a distinctive output token (`error TS2353`). Each of those is something a
 * block can only carry by having pasted a run.
 *
 * `commandRe` above is deliberately NOT narrowed the same way: it reads a tool
 * call's `command` field, where a bare `tsc` IS the invocation, and it is a
 * DISCHARGE recognizer, where a miss fires the guard at an author who did the
 * work. The two fields point opposite ways on purpose — that is this section's
 * whole thesis, and the first cut simply failed to apply it to itself.
 */
const RUNNER_PREFIX = String.raw`\b(?:bun|bunx|npm|pnpm|yarn|npx|deno)\s+(?:run\s+)?`;

const CHECK_KIND_SPECS: Readonly<Record<CheckKind, CheckKindSpec>> = {
  // `commandRe` IS `TEST_RUN_COMMAND_RE`, the same object {@link isTestRunningCall}
  // uses — not a copy of it. That is what makes "these two agree" a structural
  // property rather than a claim two literals could quietly stop honouring.
  //
  // `claimRe` can NOT be that same object, and the first cut's mistake was
  // assuming it could (PR #3165 R1 flagged the sibling kinds; this one is the
  // same class, unflagged). `TEST_RUN_COMMAND_RE` carries a bare-runner arm
  // (`\b(?:vitest|jest|pytest|mocha|ava)\b`) which is correct for reading a
  // command field and wrong for reading prose — "we use jest here" would assert
  // a test claim. It is tempting to wave this through on the grounds that an
  // over-recognized `test` matches the default kind anyway, and that is FALSE in
  // the case that matters: a block pasting only a typecheck claims
  // `[typecheck]`, and one mentioning jest in prose claims `[test, typecheck]` —
  // a spurious claim that exists nowhere in the default path.
  //
  // So the bare runners require a flag here, and the output shapes carry the
  // recall. `claimRe-vs-commandRe agreement on real invocations` in the test
  // file replaces the shared-object guarantee with a checked one.
  test: {
    toolNames: [],
    commandRe: TEST_RUN_COMMAND_RE,
    claimRe: new RegExp(
      `${RUNNER_PREFIX}(?:test\\b|test:[\\w-]+|vitest\\b|jest\\b|scripts\\/run-tests[\\w-]*)` +
        `|\\b(?:vitest|jest|pytest|mocha|ava)\\s+--?\\w` +
        `|\\bgo\\s+test\\b|\\bcargo\\s+test\\b` +
        `|\\bRan\\s+\\d+\\s+tests?\\b|\\b\\d+\\s+pass(?:ed|ing)?\\b`,
      "i"
    ),
    coverageRe: TS_OR_JS_RE,
  },
  typecheck: {
    toolNames: ["validate_typecheck"],
    commandRe:
      /\b(?:bun|bunx|npm|pnpm|yarn|npx)\s+(?:run\s+)?typecheck(?::[\w-]+)?\b|\btsgo\b|\btsc\b/i,
    claimRe: new RegExp(
      `\\bvalidate_typecheck\\b|\\berror TS\\d+\\b|${RUNNER_PREFIX}(?:typecheck(?::[\\w-]+)?|tsc|tsgo)\\b|\\b(?:tsc|tsgo)\\s+--?\\w`,
      "i"
    ),
    coverageRe: TS_ONLY_RE,
  },
  lint: {
    toolNames: ["validate_lint"],
    commandRe: /\b(?:bun|bunx|npm|pnpm|yarn|npx)\s+(?:run\s+)?lint(?::[\w-]+)?\b|\beslint\b/i,
    claimRe: new RegExp(
      `\\bvalidate_lint\\b|${RUNNER_PREFIX}(?:lint(?::[\\w-]+)?|eslint)\\b|\\beslint\\s+--?\\w`,
      "i"
    ),
    coverageRe: TS_OR_JS_RE,
  },
  format: {
    toolNames: [],
    commandRe: /\b(?:bun|bunx|npm|pnpm|yarn|npx)\s+(?:run\s+)?format(?::[\w-]+)?\b|\bprettier\b/i,
    claimRe: new RegExp(
      `\\bformat:check\\b|${RUNNER_PREFIX}(?:format(?::[\\w-]+)?|prettier)\\b|\\bprettier\\s+--?\\w`,
      "i"
    ),
    coverageRe: null,
  },
};

/**
 * The check kinds this record ASSERTS a result for.
 *
 * Empty when the block pastes nothing this module recognizes — which callers
 * must NOT read as "claims nothing". See the default in the guard: an
 * unrecognized block keeps mt#1459's own semantics (it claims a test run), so
 * this change leaves such a block's verdict byte-identical to the pre-mt#4236
 * one and stays off the recall axis mt#4067 owns.
 */
export function claimedCheckKinds(record: string): CheckKind[] {
  return CHECK_KINDS.filter((kind) => CHECK_KIND_SPECS[kind].claimRe.test(record));
}

/** True when this call ran a check of `kind`, whatever it returned. */
export function isCheckRunningCall(call: ToolCallWithResult, kind: CheckKind): boolean {
  const spec = CHECK_KIND_SPECS[kind];
  const name = normalizeToolName(call.toolName);
  if (spec.toolNames.includes(name)) return true;
  if (!COMMAND_TOOL_NAMES.includes(name)) return false;
  const command = typeof call.input["command"] === "string" ? call.input["command"] : "";
  return spec.commandRe.test(command);
}

/**
 * The transcript index of the LAST run of `kind`, or null when none ran.
 *
 * The LAST, not the first: an author who re-runs a check after editing has a
 * fresh run, and judging them on their earliest one would fire at exactly the
 * careful behavior this check exists to encourage.
 */
export function lastRunIndexOfKind(
  calls: readonly ToolCallWithResult[],
  kind: CheckKind
): number | null {
  let last: number | null = null;
  for (const call of calls) if (isCheckRunningCall(call, kind)) last = call.index;
  return last;
}

// ---------------------------------------------------------------------------
// The write side of the ordering join
// ---------------------------------------------------------------------------

/**
 * Tools that WRITE a file, and the input fields naming what they wrote.
 *
 * SHELL WRITES ARE DELIBERATELY ABSENT — a `sed -i`, a heredoc redirect, a
 * `cp`. Recognizing them means parsing a command string for an effect rather
 * than for a verb, and getting it wrong invents a write that did not happen,
 * which fires `stale-evidence` at an author whose evidence was fine. Missing
 * one instead loses a staleness detection: a false negative, and the safe
 * direction this module's header prescribes. The same reasoning excludes writes
 * made by any process other than this conversation — they are not in the
 * transcript at all, and no amount of recognizer widening would find them.
 *
 * Both `session_edit_file` and `session_edit-file` are listed because both are
 * registered spellings and {@link normalizeToolName} does not fold `-` to `_`.
 *
 * ONLY DESTINATIONS (PR #3165 R1). A move and a rename each name two paths, and
 * the first cut listed both — but the SOURCE is not written, it is vacated, so
 * modelling it as a write says a file was modified when it was not.
 *
 * Dropping it costs no detection, which is why it is the right call rather than
 * merely the conservative one: a `.ts` → `.ts` move still registers through
 * `targetPath` and still reports stale, so the reviewer's own worked example
 * (`src/a.ts` → `src/b.ts`) reaches the same verdict either way. The single case
 * that changes is a move OUT of a covered extension (`.ts` → `.txt`), where the
 * old path was the only thing making it look like a code write.
 *
 * `session_delete_file` DOES keep its path, and the distinction is not
 * arbitrary: a deletion has no destination, and the removal itself changes the
 * tree a run observed — the run typechecked a file that is no longer there.
 */
const WRITE_TOOL_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  write: ["file_path"],
  edit: ["file_path"],
  notebookedit: ["notebook_path"],
  session_write_file: ["path"],
  session_search_replace: ["path"],
  session_edit_file: ["path"],
  "session_edit-file": ["path"],
  session_move_file: ["targetPath"],
  session_rename_file: ["newPath"],
  session_delete_file: ["path"],
};

/** One file write, at the transcript index where it happened. */
export interface FileWrite {
  index: number;
  path: string;
}

/** Every file write in the transcript given, in order. */
export function fileWrites(calls: readonly ToolCallWithResult[]): FileWrite[] {
  const out: FileWrite[] = [];
  for (const call of calls) {
    const fields = WRITE_TOOL_PATH_FIELDS[normalizeToolName(call.toolName)];
    if (!fields) continue;
    for (const field of fields) {
      const value = call.input[field];
      if (typeof value === "string" && value.trim() !== "") {
        out.push({ index: call.index, path: value.trim() });
      }
    }
  }
  return out;
}

/**
 * Whether a discharging run OBSERVED the tree being shipped.
 *
 * `fresh` — no file the run reads was written after it.
 * `stale-evidence` — one was, so the pasted result describes an EARLIER tree
 *   than the diff it is attached to. This is the class mt#4236 exists to make
 *   visible, and it is deliberately distinct from both undischarged classes:
 *   the run is real and the session contains it.
 * `not-comparable` — the kind's file set is not derivable from a path
 *   ({@link CheckKindSpec.coverageRe}), so no comparison is made rather than a
 *   guess recorded.
 *
 * Ordering is by TRANSCRIPT INDEX, not wall-clock: at PreToolUse the transcript
 * holds exactly the calls that already happened, so index order IS happened-
 * before, and it needs no timestamp to be present or parseable.
 */
export type OrderingVerdict = "fresh" | "stale-evidence" | "not-comparable";

export function orderingAgainstWrites(
  runIndex: number,
  writes: readonly FileWrite[],
  kind: CheckKind
): OrderingVerdict {
  const coverage = CHECK_KIND_SPECS[kind].coverageRe;
  if (coverage === null) return "not-comparable";
  const invalidated = writes.some((w) => w.index > runIndex && coverage.test(w.path));
  return invalidated ? "stale-evidence" : "fresh";
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
const QUOTED_FAILURE_LINE_RE = /\(fail\)/;

/**
 * The other shapes a record pastes when it reports a run (mt#4067).
 *
 * MEASURED over the live window, not anticipated: 553 calibration records / 96
 * fires, of which **58 (60.4%) had a FAILING test run in the same session before
 * the call** and still fired — the run happened and neither join found it. The
 * `(fail)` line above is the only paste the join accepted, and a large share of
 * genuine controls do not paste one. They paste the runner's SUMMARY
 * (`5466 pass`, `Ran 5456 tests across 153 files`) or a hand-rolled harness's
 * result table (`PASS  expected=false ...`, `exit=0`).
 *
 * Widening the ACCEPTED SHAPES does not weaken the join, because the property
 * that makes it sound is unchanged and lives at the other end: the line must
 * still appear VERBATIM in a real failing run's output, and still clear
 * {@link MIN_QUOTED_LINE_LENGTH}. A 30-plus-character line reproduced exactly
 * cannot be produced without the run, whichever shape it has — while a fabricated
 * paste matches nothing and still fires, which is the case this guard exists for.
 *
 * Deliberately NOT included: a bare tally with no other content (`3 fail`). It is
 * under the length floor, and it is the one shape a fabricator could type from
 * memory and have match a real run that happened for unrelated reasons.
 */
const QUOTED_RESULT_LINE_MARKERS: readonly RegExp[] = [
  QUOTED_FAILURE_LINE_RE,
  /\b\d+\s+(?:pass|fail)(?:ed|ing|ures?)?\b/i,
  /^\s*(?:PASS|FAIL)\b/,
  /\bRan\s+\d+\s+tests?\b/i,
  /\bexit=\d+\b/,
  /\bexpected=\S+/,
  /\bAssertionError\b/,
  /error:\s*expect\(/,
];

/**
 * Below this a quoted line is too short to be evidence of anything. A bare
 * `(fail)` with a two-word test name could plausibly be typed from memory; a
 * full suite-plus-case line could not.
 */
const MIN_QUOTED_LINE_LENGTH = 30;

/**
 * ANSI SGR escapes, stripped from both sides before comparison (PR #3143 R1).
 *
 * Semantics-preserving by construction — a colour code carries no content — so
 * this cannot merge two lines that differ in what they SAY, which is the
 * property that makes it safe to apply to a join whose whole job is precision.
 *
 * MEASURED as currently inert: 0 of 186 real failing-run tool results across 12
 * recent transcripts contain an escape sequence, because bun's output reaches
 * the transcript already plain. It is forward-insurance against a runner that
 * colourises, not a fix for an observed miss.
 */

// Matching the ESC control character IS the intent: ANSI SGR sequences are
// DEFINED by it, so there is no non-control spelling to prefer.
// eslint-disable-next-line no-control-regex -- see the two lines above
const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Strip decorations that carry no content, for verbatim comparison. */
function normalizeForComparison(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/**
 * Sanity bound on lines carried forward — NOT a recall bound (PR #3143 R1).
 *
 * The first cut capped this at 20, which could drop the one line that would have
 * discharged when a record pastes a long run: the opposite of this change's
 * purpose. The cap now sits far above any real paste (the largest judged artifact
 * in the live window is ~12KB, a few hundred lines) and exists only so a
 * pathological input cannot make the join unbounded. Cost is bounded at the join
 * instead, which short-circuits on the first match.
 */
const MAX_QUOTED_LINES = 500;

/**
 * The STRICT subset: only `(fail)` lines (mt#4067).
 *
 * Adjudicability and discharge are deliberately asymmetric, and the asymmetry is
 * measured. Widening {@link extractQuotedFailures} to summaries and harness
 * tables let more records DISCHARGE — and also dragged 22 records out of
 * `unadjudicable` into `undischarged`, because the verdict treats "carries a
 * quotable line" as "is judgeable". Net effect on the live corpus was fires
 * 108 -> 129: worse, not better.
 *
 * So the widened shapes are a discharge SIGNAL, never grounds to condemn. A
 * summary line that MATCHES a real run is proof the run happened; a summary line
 * that matches nothing is not proof it did not, because the summary is weak
 * evidence either way. Only a pasted `(fail)` line is distinctive enough to make
 * a record judgeable on its absence — which is the direction-of-error rule this
 * module's header states: an unrecognized shape must not fire the guard at an
 * author who ran their tests.
 */
export function extractStrictQuotedFailures(record: string): string[] {
  return extractQuotedFailures(record).filter((l) => QUOTED_FAILURE_LINE_RE.test(l));
}

/** Run-output lines the record quotes, as literal strings to look for. */
export function extractQuotedFailures(record: string): string[] {
  const out: string[] = [];
  for (const raw of record.split("\n")) {
    if (!QUOTED_RESULT_LINE_MARKERS.some((re) => re.test(raw))) continue;
    // Drop the runner's per-test duration: the paste and the live result agree
    // on the name but a re-run's timing differs, and the timing is the tail of
    // the line, so keeping it would defeat every comparison.
    const line = raw
      .trim()
      .replace(/\s*\[[\d.]+m?s\]\s*$/, "")
      .trim();
    if (line.length >= MIN_QUOTED_LINE_LENGTH && !out.includes(line)) out.push(line);
    if (out.length >= MAX_QUOTED_LINES) break;
  }
  return out;
}

/**
 * True when the call's output contains one of the record's quoted lines.
 *
 * Both sides are ANSI-stripped first (PR #3143 R1). Deliberately NOT
 * whitespace-collapsed: measured over the live corpus, collapsing bought ZERO
 * additional discharges (69 records carrying quoted lines with a failing output
 * in-session: 52 matched exactly, 52 with whitespace collapsed, 52 with a
 * trailing stack suffix stripped), while it CAN merge two lines that differ only
 * in spacing — a real loosening of a join whose job is precision, for no measured
 * gain. `.some()` short-circuits, which is what bounds the cost.
 */
export function callContainsQuotedFailure(
  call: ToolCallWithResult,
  quoted: readonly string[]
): boolean {
  const haystack = normalizeForComparison(call.resultText);
  return quoted.some((line) => haystack.includes(normalizeForComparison(line)));
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
 *
 * `ls` WAS here and is removed (PR #3141 R1). Listing a directory is not
 * searching it: `ls docs/` credited `docs` as swept and would turn a real miss
 * into a false `clean`. That is the direction that costs this guard its purpose,
 * and it contradicted this docblock's own first sentence — the reviewer read the
 * contract against the constant and found them disagreeing.
 */
const SWEEP_COMMAND_RE = /\b(?:grep|rg|ugrep|ag|ack|find|fd|fgrep|egrep)\b/;

/**
 * Searchers whose FIRST non-flag operand is the pattern and whose remaining
 * operands are paths. `find` is deliberately absent — its path comes FIRST
 * (`find src -name x`), which is why operand role is resolved per command rather
 * than by position alone.
 */
const PATTERN_FIRST_COMMANDS: readonly string[] = [
  "grep",
  "fgrep",
  "egrep",
  "rg",
  "ugrep",
  "ag",
  "ack",
  "fd",
];

/** Searchers whose operands are ALL paths, with the pattern in a flag. */
const PATH_FIRST_COMMANDS: readonly string[] = ["find"];

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
 * Tokenize a shell segment, honouring simple single/double quoting.
 *
 * Enough of a shell lexer to tell an operand from a flag from a quoted pattern,
 * and no more. It does not expand variables or handle nested quoting — both
 * degrade toward "no operands found", which routes to the tree-defaulting branch
 * below rather than to a silent wrong directory.
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

/**
 * The operands of a search segment that are PATHS — not flags, not the pattern.
 *
 * THIS REPLACED A SLASH HEURISTIC, and the heuristic was wrong in the dangerous
 * direction (PR #3141 R1). The previous test for "does this segment name a path"
 * required a `/`, so `rg foo src` — a perfectly ordinary path-scoped search whose
 * operand has no trailing slash — read as having NO path operand, took the
 * tree-defaulting branch, and credited every prescribable directory including
 * `docs`. A path-scoped search was therefore recorded as a whole-tree sweep,
 * which is exactly how a real `docs/` miss becomes a false `clean`.
 *
 * Resolving the operand ROLE also fixes a second over-credit the token scan had:
 * a bare `docs` inside a PATTERN (`rg "docs" src/`) can no longer credit `docs`,
 * because only operands after the pattern are considered paths.
 */
function pathOperands(segment: string): string[] {
  const tokens = tokenize(segment);
  let cmdIndex = -1;
  let command = "";
  for (let i = 0; i < tokens.length; i++) {
    const bare = (tokens[i] ?? "").replace(/^.*\//, "");
    if (PATTERN_FIRST_COMMANDS.includes(bare) || PATH_FIRST_COMMANDS.includes(bare)) {
      cmdIndex = i;
      command = bare;
      break;
    }
  }
  if (cmdIndex === -1) return [];

  // Slice from the command so `nonFlagOperands` sees it at index 0, which is
  // where it expects the program name.
  const argv = tokens.slice(cmdIndex);
  const isFind = PATH_FIRST_COMMANDS.includes(command);
  const operands = nonFlagOperands(argv, { findStyle: isFind });
  if (isFind) return operands;

  // Pattern-first: drop the positional pattern — but ONLY when there is one.
  // `-e` / `-f` supply the pattern themselves, and then every operand is a path;
  // dropping the first would consume a real one. (mt#4320)
  const patternSuppliedByFlag = argv.some((t, i) => i > 0 && suppliesPattern(t));
  return patternSuppliedByFlag ? operands : operands.slice(1);
}

/**
 * True when a segment searches the whole tree: it names `.` explicitly, or it
 * runs a tree-defaulting searcher with no path operand at all.
 *
 * `grep` is deliberately NOT tree-defaulting. With no path operand `grep` reads
 * STDIN (it is the tail of a pipe), which sweeps nothing; `rg`, `ag`, `ack` and
 * `fd` default to the working tree. Treating them alike is what produced an
 * earlier revision's measured 86.4% `contract/` sweep rate — a can't-fail probe
 * (mem#704).
 */
const TREE_DEFAULTING_COMMANDS: readonly string[] = ["rg", "ugrep", "ag", "ack", "fd"];

function sweepsWholeTree(segment: string): boolean {
  if (!SWEEP_COMMAND_RE.test(segment)) return false;
  const operands = pathOperands(segment);
  if (operands.some((o) => o === "." || o === "./")) return true;
  const runsTreeDefaulting = TREE_DEFAULTING_COMMANDS.some((c) =>
    new RegExp(`(?:^|[\\s|(/])${c}\\b`).test(segment)
  );
  return runsTreeDefaulting && operands.length === 0;
}

/**
 * Directories this ONE call demonstrably searched.
 *
 * Resolved from the search's PATH OPERANDS, not by scanning the command text.
 * The scan was the earlier design and it over-credited in two ways the reviewer
 * and the replay each caught: a directory named anywhere in the string counted
 * (so a pattern mentioning `docs` credited `docs`), and a bare operand without a
 * trailing slash did not count at all (so `rg foo src` looked pathless and
 * credited EVERYTHING). Both produce a false `clean`, which is the direction that
 * costs this guard its purpose.
 */
export function sweptDirectories(call: ToolCallWithResult): string[] {
  if (!SWEEP_TOOL_NAMES.includes(normalizeToolName(call.toolName))) return [];

  const isShell = ["bash", "session_exec"].includes(normalizeToolName(call.toolName));

  if (isShell) {
    const command = call.input["command"];
    if (typeof command !== "string" || command === "") return [];
    // PER SEGMENT, and this is the whole correctness of the shell path.
    //
    // An earlier version asked "does ANY segment run a search?" and then pulled
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
      for (const operand of pathOperands(segment)) {
        const dir = directoryFromOperand(operand);
        if (dir !== null) covered.add(dir);
      }
    }
    return [...covered];
  }

  // A structured search tool: every field it exposes is part of ONE search, so
  // there are no segments to keep apart and no pattern/path ambiguity to resolve.
  const covered = new Set<string>();
  for (const field of ["path", "include_pattern", "glob"]) {
    const value = call.input[field];
    if (typeof value !== "string" || value === "") continue;
    const dir = directoryFromOperand(value);
    if (dir !== null) covered.add(dir);
  }
  return [...covered];
}

/**
 * The prescribable directory a single path operand SWEEPS, or null.
 *
 * A SUBTREE IS NOT THE DIRECTORY, and this distinction is the whole check. An
 * operand of `docs/architecture/adr-*.md` has not swept `docs/` — it has read one
 * subtree under a glob that structurally cannot reach `docs/principal-channel.md`.
 * Crediting it would be mt#4215's defect inside the guard: a path argument that
 * names a directory is not proof the directory was searched.
 *
 * Measured (2026-08-19): this is exactly how mt#4252 escaped an earlier revision.
 * That session ran
 * `grep -rln "principal-channel\|principal channel" docs/architecture/adr-*.md`,
 * which credited `docs` and suppressed the guard on its own originating incident
 * — while the file the change falsified sits at the `docs/` root, one level above
 * everything that grep could see.
 *
 * So an operand counts only when it addresses the directory ITSELF: `docs`,
 * `docs/`, `docs/*`, `docs/**`, or a file directly inside it. `docs/<subdir>/…`
 * does not. This trades a small false-positive risk (an author who sweeps several
 * subtrees separately reads as not having swept the root) for not silently
 * discharging the claim the gate exists to check — and the guard is record-only,
 * so that risk costs a calibration record rather than a denial.
 */
function directoryFromOperand(operand: string): string | null {
  const cleaned = operand.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
  for (const dir of PRESCRIBABLE_DIRECTORIES) {
    if (cleaned === dir || cleaned === `${dir}/`) return dir;
    if (!cleaned.startsWith(`${dir}/`)) continue;
    // Directly inside the directory (a file or a single-level glob) counts; a
    // further path component means a subtree, which does not.
    const remainder = cleaned.slice(dir.length + 1);
    if (remainder !== "" && !remainder.includes("/")) return dir;
  }
  return null;
}

/** Every prescribable directory the session's sweep calls reached, unioned. */
export function sessionSweptDirectories(calls: readonly ToolCallWithResult[]): Set<string> {
  const covered = new Set<string>();
  for (const call of calls) for (const dir of sweptDirectories(call)) covered.add(dir);
  return covered;
}
