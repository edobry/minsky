#!/usr/bin/env bun
// PreToolUse observer: a PR that changes a SERIALIZED contract surface whose
// gate-(h) consumer sweep never reached `docs/` (mt#4171).
//
// THE QUESTION IS THE STRONGER ONE. The sibling `duplicate-check-search-provenance`
// (mt#4004) asks whether a search happened; `claim-provenance-scan` (mt#4168) asks
// whether a claim has a call behind it. Gate (h)'s recorded failures are neither:
// in every one, the agent DID sweep, and the sweep missed a prescribed directory.
//
//   - mt#1610 enumerated 25+ code sites and missed three `docs/` files, then
//     missed the Railway env-var consumers entirely and crashed production.
//   - mt#3969 grepped one symbol correctly and missed seven callers that never
//     mention it.
//   - mt#4252 (2026-08-18) produced a six-row consumer table and correctly ruled
//     the Rust side out by READING `rustConsumedFields` rather than assuming —
//     and did not sweep `docs/`. `docs/principal-channel.md:86` states its field
//     lists are "exhaustive per variant"; the change made that sentence false
//     rather than merely dating it. Caught by the reviewer as BLOCKING on
//     PR #3101.
//
// So the checkable question is not "did you search?" but "did the search you ran
// cover the prescribed set?"
//
// ===========================================================================
// WHY THIS FIRES AT `session_pr_create` AND NOT AT READY, AGAINST ADR-042's
// TABLE — measured, not preferred (mt#4171 planning + implementation, 2026-08-19)
// ===========================================================================
//
// ADR-042 assigns gate (h)'s backstop to PreToolUse on `tasks_status_set` where
// the target is READY. Its DISCRIMINATOR, stated in the same Decision section, is
// to "place each mechanizable one at the seam where its evidence first exists."
// Two premises under the READY assignment are false, and the ADR's own rule then
// points elsewhere:
//
// 1. **"The sweep's directories are structured arguments."** Measured across the
//    589 on-disk transcripts: `Bash` 27561 search calls vs 339 `session_grep_search`,
//    180 `repo_search`, 21 `Grep`, 9 `git_search`, 5 `Glob`. ~98% of this repo's
//    searching is a shell command string. (Handled — see the shared table's
//    sweep section, which parses the command string.)
//
// 2. **"The change type is inferable at READY."** It is not, because at READY the
//    spec does not yet NAME the artifact. Checked against the originating
//    recurrence directly: mt#4252's spec as surfaced at its own READY transition
//    is 7,590 characters containing ZERO `/api/…` routes, ZERO `contract/`
//    references, ZERO `-shape.json`, and ZERO `docs/` paths. It says
//    "principal-channel" and "health" as bare words. A trigger able to fire there
//    would have to key on those bare words — prose, with a paraphrase axis, which
//    is the ADR-024 arms race this task's spec explicitly forbids.
//
// A READY-seam version therefore misses its own founding incident, which mt#4171's
// AT2 names as disqualifying: "a check that cannot see it is not this check."
// Measured fire rates for the same trigger at each seam:
//
//     READY seam        53 triggered / 998 recoverable  (5.3%)   — misses mt#4252
//     PR-create seam   123 triggered / 1131 calls      (10.9%)   — catches it
//
// THIS IS THE ADR'S OWN MOVE, not a departure from it. §Sibling reconciliation
// re-scoped gate (n) on exactly this reasoning — "Its mechanism reads a diff and
// its title promises the gap 'surfaces at plan time.' No diff exists at plan
// time. It moves to the `pr` seam... Its value is unchanged; its claim about WHEN
// is not." The (h) row needs the same correction, and the ADR text should be
// amended to record it rather than left contradicting a shipped guard.
//
// TWO CONSEQUENCES FOR THE SIBLINGS, both recorded in the amendment task:
//   - This row no longer pays for a `registry-status-set-guards.ts` family module
//     or for wiring the dispatcher onto `tasks_status_set`. It joins the existing
//     `registry-pr-create-guards.ts` instead, at zero wiring cost.
//   - mt#4172 (gate (p) nominator) was to INHERIT that wiring for free. It must
//     now pay it, or move seams itself.
//
// WHAT V1 DECIDES, AND WHAT IT DECLINES (SC2/SC3). It decides ONE row of gate
// (h)'s consumer table — `Config key / schema field`, the only row whose
// prescribed set includes `docs/`, and the omission every recorded incident
// shares. It declines every other change type, recorded as its OWN outcome so
// "declined to decide" is never conflated with "decided, no gap".
//
// ROW MEMBERSHIP FOLLOWS EXPOSURE, NOT DECLARATION (mt#4265, mt#4252). An
// internal-only type and a type serialized into an HTTP response produce
// identical-looking diffs; only the second one's consumers include `docs/`. The
// trigger therefore looks at WHICH FILES THE SESSION EDITED — a golden contract
// fixture, a generated manifest, a route handler — never at how the change is
// declared or described.
//
// Never denies. Calibration-first per ADR-024 and ADR-042 §Posture, which assigns
// `tuningOwnership: advisory` to the claim-provenance rows including this one.
// Override: MINSKY_SKIP_ENUMERATION_SCOPE=1.
//
// @see .minsky/hooks/evidence-provenance-table.ts — the shared discharge table (SC4)
// @see docs/architecture/hooks/enumeration-scope-check.md — mechanism + calibration
// @see ADR-042 — the seam discriminator this applies, and the row it amends
// @see mt#4215 — why a path ARGUMENT is not proof the path was searched

import { readInput } from "./types";
import type { ToolHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { findToolCallsWithResults } from "./transcript";
import type { ToolCallWithResult } from "./transcript";
import { normalizeToolName, sessionSweptDirectories } from "./evidence-provenance-table";

export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_ENUMERATION_SCOPE";

// ---------------------------------------------------------------------------
// What the session changed
// ---------------------------------------------------------------------------

/**
 * Tools through which a session edits a file.
 *
 * The harness-native `Edit`/`Write` are included alongside the session-scoped
 * tools because `/implement-task` permits them for MAIN-workspace files, and a
 * docs edit made that way is still a docs edit. Missing one would under-count
 * coverage, which is the false-POSITIVE direction.
 */
const EDIT_TOOL_NAMES: readonly string[] = [
  "session_write_file",
  "session_search_replace",
  "session_edit_file",
  "session_move_file",
  "session_rename_file",
  "edit",
  "write",
  "notebookedit",
];

/**
 * The input fields those tools carry a path in.
 *
 * `sourcePath`/`targetPath` (move) and `path`/`newName` (rename) are here because
 * a PATH-LEVEL change to a serialized contract is still a change to it (PR #3141
 * R1). Renaming `contract/foo.json` or moving a generated manifest alters the
 * published shape's address, and reading only `path`/`file_path` returned
 * `declined` for it — a silent coverage gap in a trigger whose whole premise is
 * "what did this session change?". Both ends of a move are read: moving a
 * contract OUT of `contract/` and moving one IN are both events this guard wants.
 */
const EDIT_PATH_FIELDS: readonly string[] = [
  "path",
  "file_path",
  "sourcePath",
  "targetPath",
  "newName",
];

/**
 * Every path written since the previous `session_pr_create`, in transcript order.
 *
 * THE WINDOW IS THE POINT, and the replay is what established it. A long
 * conversation ships several PRs — one measured session (`c1b904ea`, 2026-08-19)
 * created SEVEN, for mt#4232, mt#4227, mt#4260, mt#4267, mt#4272, mt#4275 and
 * mt#4277. Reading the whole prefix credits every edit in the conversation to
 * whichever PR is being created now, so a `contract/cockpit-health-shape.json`
 * edit belonging to an earlier task flagged mt#4232's PR ("Restart the cockpit
 * daemon by signal"), which touched no contract at all. That is a false positive
 * fired at an author who did nothing wrong — the dangerous direction.
 *
 * A PR covers the work done since the last PR, so the previous `session_pr_create`
 * is the natural boundary and needs no task→session mapping to compute.
 */
export function callsSinceLastPr(
  calls: readonly ToolCallWithResult[]
): readonly ToolCallWithResult[] {
  let start = 0;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (call && normalizeToolName(call.toolName) === "session_pr_create") start = i + 1;
  }
  return calls.slice(start);
}

/** The paths written inside that window. */
export function editedPaths(calls: readonly ToolCallWithResult[]): string[] {
  const out: string[] = [];
  for (const call of callsSinceLastPr(calls)) {
    if (!EDIT_TOOL_NAMES.includes(normalizeToolName(call.toolName))) continue;
    for (const field of EDIT_PATH_FIELDS) {
      const value = call.input[field];
      if (typeof value === "string" && value !== "") out.push(value);
    }
  }
  return out;
}

/**
 * True when a path IS a serialized contract — an artifact whose whole purpose is
 * to be the published shape.
 *
 * Each is a PATH fact rather than a description, which is what keeps the trigger
 * free of a paraphrase axis. A type declared in `src/` and never serialized
 * matches none of them, which is the discrimination mt#4252 turned on.
 *
 * A ROUTE HANDLER IS DELIBERATELY NOT ONE, and the replay is why. An earlier
 * revision also matched any path with a `routes`, `api` or `handlers` segment;
 * measured over 589 transcripts that put the flag rate at 35.8% of decided
 * cases, and the fires were dominated by internal cockpit route handlers —
 * `entity-threads.ts`, `changesets.ts`, `events.ts`. Editing a route handler is
 * not evidence its RESPONSE SHAPE changed: mt#3398 in that set was a 500→503
 * status fix, which prescribes no `docs/` sweep at all. The path cannot
 * discriminate a shape change from a behavior change, so it is the wrong signal
 * and firing on it would fire hardest at ordinary route work (mem#719).
 *
 * What remains are artifacts that cannot be edited for any reason OTHER than
 * changing a published shape: a golden contract fixture, a generated manifest,
 * and the `-shape.json` convention. Narrow, and every recorded incident sits
 * inside it.
 */
export function isSerializedSurfacePath(path: string): boolean {
  // `.json` ONLY inside those directories. `contract/README.md` is prose ABOUT
  // the contract, not a published shape, and the replay caught it as a false
  // positive on the first narrowed run — editing a directory's README prescribes
  // no consumer sweep.
  const isDataFile = /\.json$/.test(path);
  return (
    (isDataFile && (path.includes("contract/") || path.includes("src/generated/"))) ||
    /-shape\.json$/.test(path)
  );
}

/**
 * Directories the `Config key / schema field` row prescribes.
 *
 * v1 CHECKS ONLY `docs`. The other four are listed because the row prescribes
 * them and a later revision will want them, but they are not asserted: `src` and
 * `tests` are swept by essentially every session (measured: `src` 92.1%), so
 * requiring them would add fires that carry no information, and `services` /
 * `.github` are legitimately irrelevant to many serialized changes. `docs` is the
 * one every recorded incident missed.
 */
export const CONFIG_KEY_ROW_DIRECTORIES: readonly string[] = [
  "src",
  "tests",
  "services",
  ".github",
  "docs",
];

/** The subset v1 actually asserts. */
export const V1_ASSERTED_DIRECTORIES: readonly string[] = ["docs"];

// ---------------------------------------------------------------------------
// Row 2: message constant / rendered string (mt#4399)
// ---------------------------------------------------------------------------
//
// V1 DECIDED ONE ROW AND DECLINED THE REST, and that is the boundary this
// extends — not a blind spot it repairs. Read the decline log before reading
// this: 86 invocations between 2026-08-19 and 2026-08-21, across 42 sessions,
// and **every one of them `declined`**. v1 has never decided a live case,
// because no session in three days edited a `contract/*.json`,
// `src/generated/*.json` or `*-shape.json`. Its 10.9% match rate came from a
// replay over historical transcripts, not from operation.
//
// THE DIRECTIONAL GAP (mt#4379 / PR #3219, 2026-08-21). v1 asserts `docs/`,
// because every incident it was built from swept code and missed docs. The
// inverse happened: a reviewer finding named ONE stale quote in
// `docs/multi-backend-user-guide.md`, and the sweep run in response was
// `grep -rn '<phrases>' docs/ .minsky/ README.md` — docs-only by construction,
// recorded as complete for the class. Two CODE renderers of the same message
// were missed and a peer's PR #3220 had to close them. v1 could not fire: the
// sweep DID reach `docs/`, the only omission it knows.
//
// WHY THE MISS WAS EASY. The reviewer supplied a REGION, and a region supplied
// by a finding reads as the class. Class-not-instance was applied along the axis
// the reviewer named (this doc → all docs) rather than the axis the change
// defined (this renderer → all renderers). A reviewer finding is a SAMPLE from
// the class, not a description of it.
//
// SO THIS ROW DERIVES ITS PRESCRIBED SET FROM THE CHANGE, and the derivation is
// not a heuristic about scope — it is the defect itself. When a session replaces
// a string literal, the literal it removed either still occurs in the tree or it
// does not. The files where it still occurs ARE the unswept renderers; there is
// nothing to infer. That is why this row can assert `src` and `packages`, which
// v1 deliberately would not: v1 would have been asserting "you should have swept
// src" against a 92.1% base rate that carries no information, whereas this
// asserts "the exact text you just changed is still in these files."

/**
 * Quoted runs in a payload, single-line only.
 *
 * SINGLE-LINE IS A CORRECTNESS CONSTRAINT, not a simplification: the occurrence
 * search below is `git grep -F`, which is line-oriented, so a literal spanning a
 * newline could never match and would silently contribute nothing — a can't-fail
 * probe (mem#704) inside a check whose whole output is an absence.
 *
 * Reads quoted runs rather than parsing TypeScript. A real parse would be more
 * precise and would also introduce a paraphrase axis this module has twice paid
 * to avoid (mem#719): a quoted run is a lexical fact about the payload, and the
 * only judgement in it is the length floor.
 */
/**
 * Drop whole-line comments, so a retired phrase QUOTED IN A COMMENT does not
 * read as still-present code.
 *
 * THIS IS LOAD-BEARING, and the verbatim payload is what proved it. mt#4379's
 * edit to `multi-backend-service.ts` replaced the message AND explained itself:
 *
 *   // The retry clause is what keeps this HONEST (mt#4379). The previous
 *   // wording asserted "The database is unreachable" and "`minsky persistence
 *   // check` reports the same failure" in the PRESENT tense ...
 *
 * So `replace` still CONTAINS "The database is unreachable" — in the comment
 * describing its removal. A plain containment test therefore reads the literal
 * as surviving and never searches for it, and the only literal it would flag
 * instead is the long chunk ("registered. The database is unreachable — this is
 * NOT an empty database, and an empty ") which the sibling renderers phrase
 * differently and which consequently matches nothing. The row would have gone
 * `clean` on its own originating incident — the same self-suppression an earlier
 * revision of this module already paid for once.
 *
 * WHOLE-LINE only, deliberately. Stripping from a mid-line `//` would corrupt
 * any string containing a URL, and the case that matters is a comment on its own
 * line — which is how an agent explains a retirement.
 *
 * BLOCK STATE IS TRACKED rather than guessed (PR #3231 R3). An earlier version
 * dropped any line whose first non-space character was `*`, on the theory that
 * such a line is a JSDoc continuation. It is not always: a markdown bullet
 * inside a template literal, a wrapped multiplication, and a `**bold**` line in
 * an embedded prose string all begin that way, and dropping them corrupts the
 * very text this function feeds to the literal extractor. Reading block-comment delimiters
 * state costs a boolean and removes the guess entirely — a `*` line is a
 * continuation when it is inside a block comment and ordinary code otherwise.
 */
export function stripCommentLines(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close === -1) {
        inBlock = true;
        continue;
      }
      // A block that closes MID-LINE leaves real code after it, and dropping the
      // whole line would delete that code (PR #3231 R6). `/* note */ const m =
      // "…";` is the case: the comment is a prefix, not the line.
      const after = trimmed.slice(close + 2);
      if (after.trim() !== "") out.push(after);
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    out.push(line);
  }
  return out.join("\n");
}

export function quotedLiterals(text: string): string[] {
  const out: string[] = [];
  // Double, single and backtick runs. Escapes are not interpreted — an escaped
  // quote ends the run early, which yields a SHORTER literal, and a shorter
  // literal can only under-match. Erring toward under-matching is the
  // false-negative direction, which is the safe one for a record-only guard.
  for (const match of text.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (typeof value === "string") out.push(value);
  }
  return out;
}

/**
 * How long a literal must be before it is treated as a rendered message.
 *
 * Short strings are identifiers, keys, flags and enum members — `"postgres"`,
 * `"docs"`, `"utf8"` — and they occur all over a tree for reasons that have
 * nothing to do with the edit. Searching for them would return hundreds of
 * unrelated files and fire at every author. 24 chars is above every such token
 * and below every message in the originating incident (its shortest useful
 * chunk, "The database is unreachable", is 27).
 */
export const MESSAGE_LITERAL_MIN_CHARS = 24;

/** A literal this session removed from a file, with the file it removed it from. */
export interface ReplacedLiteral {
  literal: string;
  path: string;
}

/**
 * Literals present in an edit's `search` and absent from its `replace`.
 *
 * Reads the SEARCH/REPLACE PAIR, which is the only edit shape that states its
 * own before and after. `session_write_file` carries content with no prior
 * value, and `session_edit_file` carries an instruction for a fast-apply model
 * rather than the resulting text — neither can say what was REMOVED without
 * re-reading the file from disk at a revision that no longer exists. So this row
 * decides `session_search_replace`-shaped edits and is silent on the others,
 * which is the same declared-boundary discipline v1 shipped with.
 */
export function replacedLiterals(calls: readonly ToolCallWithResult[]): ReplacedLiteral[] {
  const out: ReplacedLiteral[] = [];
  for (const call of calls) {
    if (!EDIT_TOOL_NAMES.includes(normalizeToolName(call.toolName))) continue;
    const search = call.input["search"];
    const replace = call.input["replace"];
    const path = call.input["path"] ?? call.input["file_path"];
    if (typeof search !== "string" || typeof replace !== "string") continue;
    if (typeof path !== "string" || path === "") continue;
    // Both sides stripped of comment lines, symmetrically. On the SEARCH side a
    // phrase quoted in a comment is prose about the code rather than a rendered
    // message; on the REPLACE side it is the retirement note that would
    // otherwise suppress this row — see `stripCommentLines`.
    const searchCode = stripCommentLines(search);
    const replaceCode = stripCommentLines(replace);
    for (const literal of quotedLiterals(searchCode)) {
      if (literal.length < MESSAGE_LITERAL_MIN_CHARS) continue;
      // Absent from the replacement TEXT, not from its literals: a literal that
      // survives inside a differently-quoted or reflowed replacement was not
      // removed, and calling it removed would send the author hunting for a
      // change they did not make.
      if (replaceCode.includes(literal)) continue;
      out.push({ literal, path });
    }
  }
  return out;
}

/**
 * THE SEARCH UNIT IS A PHRASE, NOT A QUOTED CHUNK — measured, not preferred.
 *
 * The first implementation searched for whole removed literals and it did NOT
 * catch its own originating incident. Run against the real tree at
 * `fbc352c97^` — the revision as it stood when mt#4379's sweep was made — all
 * five literals removed from `multi-backend-service.ts` returned **zero hits**
 * outside the edited file, `git grep` exit 1 on every one.
 *
 * The reason is structural and general: a long message is ASSEMBLED from
 * concatenated chunks, and two renderers of the same message almost never break
 * their chunks at the same points. The task-backend renderer had
 *
 *     "registered. The database is unreachable — this is NOT an empty database, and an empty "
 *
 * while the two siblings that needed the same correction had
 *
 *     "The database is unreachable — this is a degraded provider, not a missing "
 *
 * Same sentence opening, different chunk boundary and different continuation, so
 * no whole-literal comparison relates them. Searching the shared PHRASE does:
 * `git grep -F "The database is unreachable — this is"` at that revision returns
 * `packages/domain/src/persistence/unconfigured-provider.ts:205` and
 * `src/cockpit/db-providers.ts:179` — precisely the two renderers mt#4379 missed
 * and PR #3220 had to close.
 *
 * Literals are joined before windowing because `+` concatenation is what the
 * chunks are FOR: rejoining them reconstructs the rendered message, which is the
 * unit a sibling shares. A window that spans two unrelated statements simply
 * matches nothing, which is the harmless direction.
 */
/**
 * CLAUSES, not fixed-width windows — measured too, and this is the second
 * correction the real tree forced.
 *
 * A sliding 6-word window stepping by 3 found `src/cockpit/db-providers.ts` and
 * MISSED `packages/domain/src/persistence/unconfigured-provider.ts`, because a
 * fixed step lands its boundaries wherever the arithmetic puts them: the window
 * came out as "backend is registered. The database is" while the phrase the two
 * renderers actually share is "The database is unreachable — this is". Widening
 * the step to 1 would emit ~60 windows for one message and then search 8 of
 * them, which is a lottery dressed as a cap.
 *
 * A message's own punctuation already marks the units two renderers share,
 * because both were written as prose before they were chunked. Splitting on
 * sentence and clause boundaries yields four candidates here instead of sixty,
 * and they are the RIGHT four.
 */
const CLAUSE_BOUNDARY = /(?<=[.;:!?])\s+|\s+—\s+|\s+--\s+/;

/**
 * Below this a clause is a fragment that occurs everywhere ("and an empty result
 * here"), and searching it returns noise rather than renderers. 24 admits "The
 * database is unreachable" (27), which is the clause that relates the three
 * renderers in the originating incident.
 */
export const PHRASE_MIN_CHARS = 24;

/**
 * How many phrases are searched per run.
 *
 * Each costs a `git grep`, and a long message yields many overlapping windows.
 * Longest-first, because a longer window is more distinctive. A cap is a bounded
 * enumeration, so it is LOGGED rather than silent — see `phrasesTruncated`.
 */
export const MAX_PHRASES_SEARCHED = 8;

/**
 * Sliding word-windows over the reassembled removed text.
 *
 * Whitespace is normalized first: the chunks carry the line breaks and indentation
 * of the SOURCE, and a sibling renderer wraps at different columns, so comparing
 * raw spacing would fail for a reason that has nothing to do with the message.
 * `git grep` is line-oriented, so a window must also not contain a newline —
 * normalizing to single spaces guarantees that.
 */
export function messagePhrases(literals: readonly string[]): string[] {
  const text = literals.join("").replace(/\s+/g, " ").trim();
  const out: string[] = [];
  for (const raw of text.split(CLAUSE_BOUNDARY)) {
    // Leading/trailing punctuation is dropped so a clause that ended a chunk
    // ("failure.") still matches a renderer that continues past it.
    const phrase = raw
      .trim()
      .replace(/^[^\w`'"(]+/, "")
      .replace(/[.,;:!?]+$/, "")
      .trim();
    if (phrase.length < PHRASE_MIN_CHARS) continue;
    // A clause carrying an interpolation can never match another renderer as a
    // fixed string — `${x}` is source, not rendered output — so it is a
    // guaranteed zero that only spends a `git grep`.
    if (phrase.includes("${")) continue;
    out.push(phrase);
  }
  return [...new Set(out)];
}

/** Directories a stale occurrence is worth reporting from. */
export const RENDERER_DIRECTORIES: readonly string[] = [
  "src",
  "packages",
  "services",
  "tests",
  "docs",
  ".github",
];

/**
 * Tracked files that still contain `literal`, excluding ones this session edited.
 *
 * `git grep` rather than a walk: it reads the index, so `node_modules`, `.tmp`
 * and untracked scratch files are excluded without a denylist that would go
 * stale. `-F` because the literal is data, not a pattern — a message containing
 * `(` or `?` is otherwise a regex and matches nothing.
 *
 * EXCLUDING THE SESSION'S OWN EDITS is what keeps this from firing at an author
 * who did the work: if the session already corrected a renderer, that renderer
 * is not a miss. The comparison is `wasEditedThisSession`, which matches on a
 * PATH BOUNDARY — see its docblock for why a bare suffix was wrong.
 *
 * A search that could not RUN returns `{ ok: false }` rather than an empty list,
 * because those are different facts and the caller renders them differently
 * (`skipped` vs `clean`).
 *
 * `.minsky/` is NOT in `RENDERER_DIRECTORIES` on purpose: rules, memories and
 * calibration logs quote old message wording as HISTORY, and a task record
 * describing what a message used to say is not a renderer that needs updating.
 * Including it would fire on every session that documented its own change.
 */
export function staleOccurrences(
  literal: string,
  cwd: string,
  sessionEdited: readonly string[],
  spawn: typeof Bun.spawnSync = Bun.spawnSync
): StaleSearchResult {
  // `-n` rather than `-l`: the LINE is needed to drop retirement assertions
  // below. Filtering at file grain would discard a file that carries both a
  // negative assertion and a real stale render.
  const result = spawn(["git", "grep", "-n", "-F", "--", literal, ...RENDERER_DIRECTORIES], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  // exit 1 is `git grep`'s "no match", which is a real answer. Anything else is
  // the search NOT HAVING RUN, and this must be a distinguishable value rather
  // than an empty list (PR #3231 R1). Returning `[]` for both was the exact
  // can't-fail-probe shape this module cites mem#704 about, three lines under a
  // comment saying the caller must not read it that way — and the caller did,
  // rendering a broken search as `clean`.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return {
      ok: false,
      reason: `git grep exited ${result.exitCode}`,
    };
  }

  const files = new Set<string>();
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    if (line.trim() === "") continue;
    // `path:lineno:content` — split twice only, since the content may contain
    // colons and re-joining a naive split would corrupt the text being judged.
    const firstColon = line.indexOf(":");
    if (firstColon === -1) continue;
    const secondColon = line.indexOf(":", firstColon + 1);
    if (secondColon === -1) continue;
    const path = line.slice(0, firstColon);
    const content = line.slice(secondColon + 1);
    if (RETIREMENT_ASSERTION_RE.test(content)) continue;
    files.add(path);
  }

  return { ok: true, files: [...files].filter((hit) => !wasEditedThisSession(hit, sessionEdited)) };
}

/** A search that RAN, or one that did not — never collapsed into an empty list. */
export type StaleSearchResult = { ok: true; files: string[] } | { ok: false; reason: string };

/**
 * Did this session edit the file `git grep` reported?
 *
 * ON A PATH BOUNDARY, not a bare suffix (PR #3231 R2). The first version asked
 * `edited.endsWith(hit) || hit.endsWith(edited)`, which relates any two paths
 * whose tails happen to agree: a session that edited
 * `packages/domain/src/tasks/x.ts` would have silently excluded a genuine stale
 * hit at `src/tasks/x.ts`, because the first string ends with the second. That
 * is a FALSE NEGATIVE — the guard going quiet about a renderer nobody swept —
 * which is the direction that costs this row its purpose.
 *
 * A `git grep` hit is repo-relative; an edit path may be repo-relative or an
 * absolute session path. So the only sound relation is equality after
 * normalization, or an absolute path ending at a `/`-delimited segment
 * boundary. `a/x.ts` no longer matches `bba/x.ts`.
 */
export function wasEditedThisSession(hit: string, sessionEdited: readonly string[]): boolean {
  const normalize = (p: string): string => p.replace(/^\.\//, "");
  const target = normalize(hit);
  return sessionEdited.some((raw) => {
    const edited = normalize(raw);
    if (edited === target) return true;
    // The `/`-boundary suffix is sound ONLY for an ABSOLUTE edit path, where the
    // leading segments are a workspace prefix the grep hit never carries. Allowing
    // it for a RELATIVE edit is the defect itself: `packages/domain/src/tasks/x.ts`
    // ends with `/src/tasks/x.ts`, and those are two different files.
    return edited.startsWith("/") && edited.endsWith(`/${target}`);
  });
}

/**
 * A line that asserts the literal is GONE, which is the opposite of a stale render.
 *
 * Observed, not anticipated (2026-08-21). After mt#4379 and mt#4383 retired the
 * wording "The database is unreachable", `git grep` still returned five files
 * carrying it — and every surviving occurrence in a test file was
 * `expect(...).not.toContain("The database is unreachable")`, i.e. the
 * regression test that FORBIDS the old message. Firing on those would fire
 * hardest at the author who retired the string most carefully, which is the
 * false-positive direction this module has twice paid to avoid (mem#719).
 *
 * Lexical, so it adds no paraphrase axis: it matches the assertion form, not a
 * description of intent. It deliberately does NOT try to exclude PROSE comments
 * that quote retired wording — those exist too (this build leaves them in, and
 * the calibration record is how their rate gets measured rather than guessed).
 */
const RETIREMENT_ASSERTION_RE = /\.not\s*\.\s*(?:toContain|toMatch|toBe|toEqual)\b/;

/**
 * The two filesystem-touching steps, injectable for tests.
 *
 * The alternative was a temp git repo per fixture, which would make the suite's
 * only real-filesystem tests the ones checking a guard that must never be wrong
 * about the filesystem — and `custom/no-real-fs-in-tests` exists to keep that
 * out. Injection keeps the fixtures verbatim (AT4) while making the outcome a
 * function of the transcript alone.
 */
export interface SearchDeps {
  staleOccurrences?: (
    literal: string,
    cwd: string,
    sessionEdited: readonly string[]
  ) => StaleSearchResult;
  searchableRepo?: (cwd: string | undefined) => cwd is string;
}

/** True when `git grep` can run here at all — an unusable cwd must not read as clean. */
export function searchableRepo(cwd: string | undefined, spawn = Bun.spawnSync): cwd is string {
  if (typeof cwd !== "string" || cwd === "") return false;
  const probe = spawn(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return probe.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Dispatcher entry point (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

/**
 * The message-constant row: did the sweep reach the files that still render the
 * text this session just changed? (mt#4399)
 *
 * Returns `null` when the row does not apply, so the caller falls through to its
 * own `declined`. Every other exit is a decided outcome, INCLUDING the one where
 * the search could not run — a guard whose broken-probe path returned `clean`
 * would report an outage as a run of correct behavior, which is the same reason
 * the no-transcript path is `skipped`.
 */
function runMessageConstantRow(
  input: ToolHookInput,
  calls: readonly ToolCallWithResult[],
  edited: readonly string[],
  base: Record<string, unknown>,
  deps: SearchDeps = {}
): GuardOutcome | null {
  const findStale = deps.staleOccurrences ?? staleOccurrences;
  const isRepo = deps.searchableRepo ?? searchableRepo;

  const replaced = replacedLiterals(callsSinceLastPr(calls));
  if (replaced.length === 0) return null;

  const cwd = input.cwd;
  if (!isRepo(cwd)) {
    return {
      calibration: {
        ...base,
        outcome: "skipped",
        reason: `cwd is not a git work tree, so stale occurrences cannot be searched (cwd=${cwd ?? "unset"})`,
        replacedLiteralCount: replaced.length,
      },
    };
  }

  // Phrases, not whole literals — see `messagePhrases` for the measurement that
  // forced that. Grouped by file so one edit's chunks are rejoined only with
  // each other; concatenating across files would invent phrases no renderer has.
  const byPath = new Map<string, string[]>();
  for (const { literal, path } of replaced) {
    const existing = byPath.get(path);
    if (existing) existing.push(literal);
    else byPath.set(path, [literal]);
  }
  const phrases = [...new Set([...byPath.values()].flatMap((ls) => messagePhrases(ls)))];
  // Longest first: the most distinctive, and the most likely to have been
  // reproduced by a sibling renderer.
  const ordered = [...phrases].sort((a, b) => b.length - a.length);
  const searched = ordered.slice(0, MAX_PHRASES_SEARCHED);

  const stale = new Set<string>();
  for (const phrase of searched) {
    const result = findStale(phrase, cwd, edited);
    // A search that did not RUN is not a search that found nothing (PR #3231 R1).
    // Bailing on the first failure rather than continuing: a partial sweep of the
    // phrase set cannot support `clean` either, and reporting `matched` off the
    // phrases that happened to succeed would understate the miss.
    if (!result.ok) {
      return {
        calibration: {
          ...base,
          outcome: "skipped",
          reason: `stale-occurrence search failed (${result.reason}); a failed probe is not a clean result`,
          replacedLiteralCount: replaced.length,
        },
      };
    }
    for (const hit of result.files) stale.add(hit);
  }

  if (stale.size === 0) {
    return {
      calibration: {
        ...base,
        outcome: "clean",
        reason: "no unedited file still contains any phrase this session replaced",
        replacedLiteralCount: replaced.length,
      },
    };
  }

  const staleFiles = [...stale];
  const staleDirectories = [
    ...new Set(staleFiles.map((f) => f.split("/")[0]).filter((d): d is string => Boolean(d))),
  ];
  const swept = sessionSweptDirectories(callsSinceLastPr(calls));
  const missing = staleDirectories.filter((d) => !swept.has(d));

  if (missing.length === 0) {
    return {
      calibration: {
        ...base,
        outcome: "clean",
        reason: "every directory still rendering a replaced phrase was swept",
        staleFiles: staleFiles.slice(0, 10),
      },
    };
  }

  // RECORD-ONLY, like row 1 and for the same reason (ADR-042 §Posture): a new
  // row ships calibration-first, and this one reads a `git grep` whose result
  // depends on the working tree the hook happens to sit in. That is a fresh way
  // to be wrong, and being wrong here means firing at an author who did the work.
  return {
    calibration: {
      ...base,
      outcome: "matched",
      row: "message-constant",
      missingDirectories: missing,
      staleFiles: staleFiles.slice(0, 10),
      swept: [...swept],
      replacedLiteralCount: replaced.length,
      phrasesSearched: searched.length,
      // NB1 (PR #3231): the `${` and length filters can silently empty the
      // candidate set, which would look identical to a message nobody
      // duplicated. Recording the drop makes over-filtering measurable from the
      // calibration log rather than inferable only by reading this file.
      phraseCandidatesDropped: Math.max(0, replaced.length - phrases.length),
      // A bounded enumeration is logged, never silent: reporting on 8 of N
      // phrases while printing a bare finding would read as full coverage.
      ...(phrases.length > searched.length
        ? { phrasesTruncated: phrases.length - searched.length }
        : {}),
    },
  };
}

export function run(
  input: ToolHookInput,
  ctx: DispatchContext,
  deps: SearchDeps = {}
): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  if (
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes"
  ) {
    return {
      auditLines: [
        `[enumeration-scope-check] OVERRIDE: ack=${overrideVal} session=${
          input.session_id ?? "unknown"
        } ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  const base = {
    ts: new Date().toISOString(),
    sessionId: input.session_id ?? null,
    toolName: input.tool_name ?? null,
  };

  const lines = ctx.transcriptLines;
  if (!lines || lines.length === 0) {
    // Not adjudicable is `skipped`, never `clean` — a guard whose no-transcript
    // path returned a pass would report an outage as a run of correct behavior.
    return {
      calibration: { ...base, outcome: "skipped", reason: "no transcript lines available" },
    };
  }

  const calls = findToolCallsWithResults(lines);
  const edited = editedPaths(calls);
  const serialized = edited.filter(isSerializedSurfacePath);

  // Row 2 runs exactly where row 1 declines (mt#4399). Ordering matters and is
  // not arbitrary: a session that edited a serialized contract is decided by the
  // row built for it, whose prescribed set comes from gate (h)'s table rather
  // than from a literal search. Only when there is no serialized surface — the
  // 86-for-86 case in the live log — does the message-constant row get a turn.
  if (serialized.length === 0) {
    const messageOutcome = runMessageConstantRow(input, calls, edited, base, deps);
    if (messageOutcome) return messageOutcome;

    // SC3: a change type neither row decides produces NO finding, recorded as
    // its OWN outcome so the calibration record never conflates "declined to
    // decide" with "decided, no gap".
    return {
      calibration: {
        ...base,
        outcome: "declined",
        reason:
          "no serialized surface and no replaced message literal among the session's edits; " +
          "this build decides the Config key / schema field row and the message-constant row",
      },
    };
  }

  // A docs EDIT is stronger evidence than a docs sweep — it is the consumer
  // actually being reached, which is what gate (h) wants — so either discharges.
  //
  // Swept directories are read from the SAME window as the edits. Asymmetry here
  // would let a sweep belonging to an earlier task in the conversation discharge
  // this PR's claim — the false-negative mirror of the defect the window fixes.
  const swept = sessionSweptDirectories(callsSinceLastPr(calls));
  const editedDocs = edited.some((p) => p.includes("docs/"));
  const missing = V1_ASSERTED_DIRECTORIES.filter(
    (d) => !swept.has(d) && !(d === "docs" && editedDocs)
  );

  if (missing.length === 0) {
    return {
      calibration: {
        ...base,
        outcome: "clean",
        reason: editedDocs ? "docs edited directly" : "the sweep reached docs/",
        serializedSurfaces: [...new Set(serialized)].slice(0, 10),
      },
    };
  }

  // RECORD-ONLY. ADR-042 §Posture: every new row ships calibration-first, and a
  // provenance check joins a claim against tool calls, so a missed call shape is
  // a false positive fired at an author who did the work. That asymmetry is why
  // this does not inject on day one (mem#719).
  return {
    calibration: {
      ...base,
      outcome: "matched",
      missingDirectories: missing,
      serializedSurfaces: [...new Set(serialized)].slice(0, 10),
      swept: [...swept],
    },
  };
}

// ---------------------------------------------------------------------------
// Standalone CLI entry point (fail-open: any error allows the call)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    // Deliberately does NOT call `run()`: the discriminating input is
    // `ctx.transcriptLines`, which only the dispatcher populates (D6), so a
    // standalone invocation could only ever reach the cannot-adjudicate branch.
    await readInput<ToolHookInput>();
    process.stderr.write(
      "[enumeration-scope-check] standalone invocation: this guard reads dispatcher-parsed " +
        "transcript lines and has nothing to check outside it. No-op.\n"
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[enumeration-scope-check] fail-open: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }
}
