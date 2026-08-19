#!/usr/bin/env bun
// PreToolUse observer: a spec asserting a file-level COLLISION or a NEGATIVE
// OWNERSHIP claim, written with no call in the session that could have
// established it (mt#4168, re-homed from mt#3806 via mt#4044).
//
// THE SEAM IS THE POINT. `tasks_spec_patch`, `tasks_edit` and
// `tasks_spec_search_replace` carried NO PreToolUse guard of any kind before
// this one — measured against `.claude/settings.json` during mt#4168's planning
// pass. That matters because both originating incidents wrote their claim into
// an EXISTING spec, which cannot go through `tasks_create`:
//
//   - `/implement-task` §0a is an entry gate on an already-READY task.
//   - `/plan-task` operates on an already-filed one.
//
// So a guard bound only to `tasks_create` would have missed the exact surface
// that produced the class. `tasks_create` is covered here too, for the case
// where a new spec carries the claim at birth.
//
// ORIGINATING INCIDENTS, one per direction:
//
//   - POSITIVE (mem#892 / mt#3793, 2026-08-05). `/implement-task` §0a halted on
//     a claimed `SessionFilmStage.tsx` collision with mt#3792. That PR never
//     touched the file; the name came from its TITLE plus an inference about
//     where camera code lives. One `get_files` call falsified it — made only
//     after the principal prompted to resume, by which point a turn was spent
//     and a false blocking gap was in the spec.
//   - NEGATIVE (mt#3682 planning, 2026-08-08). "unowned — no task covers this
//     today" went into a `## Does NOT cover`; mt#3826 had covered it for four
//     hours. The agent DID search — `/plan-task` simply ordered the search two
//     minutes AFTER the claim was written.
//
// THE SECOND ONE IS WHY ORDERING IS THE WHOLE CHECK, and why this seam makes it
// free. At PreToolUse the claim is still in `tool_input`, so every call in the
// transcript necessarily PRECEDES it. "Did the search already run?" is exactly
// the question, with no timestamp comparison and no clock. At any later seam it
// would need one.
//
// DIRECTION OF ERROR, per `evidence-provenance-table.ts`'s header:
//
//   - RECOGNIZING a claim in prose. A phrase missed here is a false NEGATIVE —
//     an unbacked claim goes unflagged. Safe, and deliberately where the
//     narrowness lives.
//   - DISCHARGING it. A call shape missed HERE fires at an author who did the
//     work. Dangerous, so the recognizers in the shared table are generous and
//     the discriminating weight sits on the join.
//
// Never denies. Calibration-first per ADR-024 — the recognition half is a
// Rung-1 deterministic prefilter and the discharge half has no paraphrase axis
// at all, so neither climbs the ladder. Override:
// MINSKY_SKIP_CLAIM_PROVENANCE=1.
//
// @see .minsky/hooks/evidence-provenance-table.ts — the shared discharge table
// @see .minsky/hooks/duplicate-check-search-provenance.ts — same shape, tasks_create seam
// @see docs/architecture/hooks/claim-provenance-scan.md — mechanism + calibration
// @see mem#892 — the positive-direction incident
// @see ADR-042 — why this sits at the write seam rather than at READY or merge

import { readInput } from "./types";
import type { ToolHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { findToolCallsWithResults, extractToolUseNames } from "./transcript";
// Spec prose is not known-ASCII — em dashes and backticked identifiers are
// routine — so the calibration excerpt cannot use a bare `.slice`, which may
// split a surrogate pair (`custom/no-unsafe-string-truncation`).
import { safeTruncate } from "@minsky/shared/safe-truncate";
import {
  prNumbersWithFileListRead,
  sessionReadMergeHistory,
  sessionRanASearch,
} from "./evidence-provenance-table";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_CLAIM_PROVENANCE";

/**
 * Which input field carries author-written spec prose, per tool.
 *
 * Explicit rather than "scan every string in `tool_input`": the latter would
 * read `taskId`, `instructions` and `search` too, and an instruction describing
 * what to write is not a claim. An unlisted tool yields no text and is recorded
 * as `skipped`, never as `clean` — the same not-adjudicable discipline the
 * mt#4004 sibling applies to a missing transcript.
 */
export const SPEC_TEXT_FIELD_BY_TOOL: Readonly<Record<string, string>> = {
  tasks_create: "spec",
  tasks_spec_patch: "content",
  tasks_edit: "specContent",
  tasks_spec_search_replace: "replace",
};

/** Strip the MCP prefix and normalize the dotted/underscore spellings. */
function normalize(toolName: string): string {
  return toolName
    .replace(/^mcp__minsky__/, "")
    .replace(/\./g, "_")
    .toLowerCase();
}

/** The authored prose this call is about to write, or null if none applies. */
export function extractAuthoredSpecText(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined
): string | null {
  if (!toolName || !toolInput) return null;
  const field = SPEC_TEXT_FIELD_BY_TOOL[normalize(toolName)];
  if (!field) return null;
  const value = toolInput[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// ---------------------------------------------------------------------------
// Claim recognition — narrow on purpose (a miss is the safe direction)
// ---------------------------------------------------------------------------

/**
 * A negative ownership claim: the spec asserts nothing/no task covers something.
 *
 * Present and past tense both, because the claim is about the world rather than
 * about the author's session — "no task covers this" and "nothing handled it"
 * assert the same absence. What is deliberately NOT matched is a QUESTION or an
 * instruction ("check whether any task covers this"), which asserts nothing.
 */
const OWNERSHIP_CLAIM_RE =
  /\b(?:unowned|no\s+(?:existing\s+)?task\s+(?:covers|owns|handles|tracks)|nothing\s+(?:covers|owns|handles|tracks)\s+(?:this|it)|not\s+owned\s+by\s+any\s+task|no\s+owner)\b/i;

/**
 * The sanctioned no-candidates line belongs to a DIFFERENT record with its own
 * guard (`duplicate-check-search-provenance`, mt#4004), which already checks
 * that its search ran. Matching it here would double-fire on one claim.
 */
const DUPLICATE_CHECK_RECORD_RE =
  /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?duplicate check(?:\*\*)?[ \t]*:[^\n]*(?:\n(?![ \t]*\n).*)*/gim;

/** Drop duplicate-check records before scanning, so mt#4004 keeps its own turf. */
export function stripDuplicateCheckRecords(text: string): string {
  return text.replace(DUPLICATE_CHECK_RECORD_RE, " ");
}

/** True when the spec asserts that nothing owns something. */
export function claimsNoOwner(specText: string): boolean {
  return OWNERSHIP_CLAIM_RE.test(stripDuplicateCheckRecords(specText));
}

/**
 * A file-level collision claim: two pieces of work asserted to touch the same
 * file.
 *
 * BOTH halves are required — an overlap verb AND a file-shaped token — because
 * either alone is ordinary spec prose. "overlaps with mt#123" is a task-level
 * adjacency claim, which gate (g) explicitly permits recording when no PR
 * exists ("task-level adjacency, files unknown"); it is the FILE-level version
 * that needs a changed-file list behind it.
 */
const COLLISION_VERB_RE =
  /\b(?:collides?|collision|overlaps?\s+(?:on|with)|overlapping|touch(?:es)?\s+the\s+same|conflicts?\s+with|same\s+file)\b/i;

/** A path or a bare filename with a source extension. */
const FILE_TOKEN_RE =
  /\b[\w@][\w\-./]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdc|sql|sh|py|go|rs|yml|yaml)\b/;

/**
 * The two signals must land in the SAME paragraph.
 *
 * MEASURED, not anticipated — and this is the whole reason AT5 exists. The
 * first implementation tested both signals against the entire authored body,
 * and a 40-transcript replay put the fire rate at 27.2% of claims with **8 of 8
 * sampled fires false**. Every one was a long spec patch in which a collision
 * verb appeared in one paragraph ("conflicts with", "superseding") and a
 * `.ts`/`.md` path appeared in a completely unrelated one. At spec length those
 * two vocabularies co-occur essentially always, so the conjunction was
 * measuring nothing.
 *
 * A paragraph is the unit rather than a sentence because a real collision claim
 * routinely spans one — "This collides with PR #2692 on\n`SessionFilmStage.tsx`"
 * — and it mirrors `coverage.ts`'s same-statement window, which exists for the
 * identical failure one subsystem over.
 */
function paragraphs(text: string): string[] {
  return text.split(/\n[ \t]*\n/);
}

/**
 * A paragraph DENYING an overlap is not asserting one.
 *
 * The largest false class in the 40-transcript replay, and the most costly one:
 * "No overlapping in-flight work" and "the two nearest open PRs were
 * file-checked, no collision" are the COMPLIANT phrasings gate (g) prescribes.
 * Firing at them would punish exactly the behavior mt#3806 shipped the prose
 * half to produce — the precise inversion mem#719 warns about, since the author
 * doing the right thing is the one who learns to discount the guard.
 */
const OVERLAP_DENIAL_RE =
  /\b(?:no|not|never|zero|none|without)\s+(?:[\w`'’-]+\s+){0,3}?(?:overlap|overlapping|collision|collides?|conflict)/i;

/**
 * The intervening-token class is `[\w`'’-]+`, not `\w+` (mt#4190).
 *
 * `\w` excludes the hyphen, so a hyphenated compound between the negator and the
 * overlap noun read as TWO non-matching tokens and the denial went unseen. The
 * measured instance: "there is no generated-file overlap with in-flight PR
 * #3070" — a correct, compliant denial that fired the guard, which is the
 * precise inversion mem#719 warns about, since the author doing the right thing
 * is the one who learns to discount it. Backticks and apostrophes are in the
 * class for the same reason: `` no `foo.ts` overlap `` and "no author's overlap"
 * are one token to a reader and two to `\w+`.
 *
 * This is a repair to an existing recognizer, not a new vocabulary family — the
 * regex already meant to allow three intervening words and did not.
 */

/**
 * A markdown table row, which is a tabulated RECORD and never a claim.
 *
 * The `| --- |` separator and the data rows both match; that is deliberate, since
 * the test below is "is this paragraph made of record lines?" rather than "does
 * this line carry data?".
 */
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

/**
 * A list item opening with an audit-record marker: a parenthesized gate letter or
 * premise-audit numeral, optionally bolded, optionally after a bullet.
 *
 * `- **(g)** No parallel work.` / `| (a) required sections | PASS |` /
 * `**(iii) Parallel work.**` — the shapes `/plan-task` and `/create-task` emit
 * when they record a gate battery's verdicts.
 */
const AUDIT_MARKER_LINE_RE = /^\s*(?:[-*+]\s+)?\*{0,2}\((?:[a-p]|i{1,3}|iv|v|vi{0,3})\)/i;

/**
 * True when this paragraph is a RECORD of a check rather than an assertion.
 *
 * THIS IS THE STRUCTURAL DISCRIMINATOR, and it is ADR-024's Rung 1 rather than a
 * fourth vocabulary pass. Rung 1 prescribes eliding "prose-quoted spans and
 * explicit discussion-framing" before matching; a gate-verdict block IS explicit
 * discussion-framing — it is the recorded OUTPUT of the very check that this
 * guard exists to demand. Four of the nine false fires measured in mt#4190's
 * planning pass are exactly this shape, and they are the guard firing at its most
 * careful authors.
 *
 * MAJORITY OF ITEMS, not of LINES, and not any-line. A single `(g)` mentioned
 * inside ordinary prose must not silence a real claim, so the paragraph has to be
 * MADE of record items: at least two, and more than half.
 *
 * ITEMS rather than lines because this repo wraps at 100 characters, so a gate
 * bullet routinely spans three or four of them. Counting lines, the real mt#4275
 * block scored 7 markers against 10 wrapped continuations and failed its own
 * majority — the discriminator was correct about every line it looked at and
 * wrong about the paragraph. Same wrapped-line trap mem#1067 §2 records one
 * subsystem over, where a same-sentence window treated `\n` as a sentence end.
 * Caught here by a fixture sampled verbatim from the transcript; a hand-written
 * one would have been narrower than 100 columns and passed.
 *
 * What this deliberately does NOT do is elide inline code spans. The obvious
 * reading of Rung 1 is "run `elideMarkdownNonProse` and match the residual", and
 * that pass blanks code spans — which is where this corpus keeps its filenames.
 * Both recall controls in `claim-provenance-corpus-fixtures.ts` name their files
 * inside backticks, so the wholesale version would delete the file-token half of
 * the conjunction and drive the fire rate toward zero: a result that reads as a
 * precision win and is the guard switched off.
 */
export function isAuditRecordParagraph(para: string): boolean {
  // An enumeration is an enumeration whether or not it is broken across lines.
  // A premise audit written as one run-on paragraph — "**Premise audit.** (i) …
  // (ii) … (iii) … (iv) …" — is the same record as the bulleted form, and the
  // line-anchored test below cannot see it, because the markers are inline.
  //
  // THREE distinct markers, not one: a single "(i)" or "per gate (g)" is an
  // ordinary prose citation, while three parenthesized sequence markers in one
  // paragraph is a structure. Counting DISTINCT ones matters — a paragraph that
  // says "(a)" three times is quoting, not enumerating.
  const inlineMarkers = new Set(
    [...para.matchAll(/\((?:[a-p]|i{1,3}|iv|v|vi{0,3})\)/gi)].map((m) => m[0].toLowerCase())
  );
  if (inlineMarkers.size >= 3) return true;

  const lines = para.split("\n").filter((l) => l.trim() !== "");
  let items = 0;
  let records = 0;
  let seenFirst = false;
  for (const line of lines) {
    // A wrapped continuation: indented, and not itself opening a new bullet or
    // table row. It belongs to the item above and must not be counted against
    // it.
    const startsItem = /^\s*[-*+]\s/.test(line) || TABLE_ROW_RE.test(line);
    const isContinuation = seenFirst && !startsItem && /^\s{2,}\S/.test(line);
    if (isContinuation) continue;
    seenFirst = true;
    items += 1;
    if (TABLE_ROW_RE.test(line) || AUDIT_MARKER_LINE_RE.test(line)) records += 1;
  }
  return items >= 2 && records >= 2 && records * 2 > items;
}

/**
 * REJECTED: requiring the paragraph to name a counterparty (mt#4190).
 *
 * The idea was that a collision is a RELATION, so a paragraph naming only one
 * side is describing a file rather than asserting a collision on it — tested as
 * "does a `PR #N` / `mt#N` / `origin/…` / `task/…` ref appear?". It is recorded
 * here rather than deleted silently because it is an attractive rule that a
 * later pass will re-derive, and it is WRONG for a reason that is not obvious
 * until it runs.
 *
 * A counterparty is routinely named DESCRIPTIVELY: "this conflicts with a merge
 * that landed on `src/thing.ts` yesterday" names its counterparty perfectly well
 * and carries no identifier. That is not a rare phrasing — it is the whole
 * merge-shaped class, the one `sessionReadMergeHistory` exists to discharge. The
 * rule silenced it, and the existing AT2 test caught that within a minute.
 *
 * Widening the test to accept descriptive counterparties ("merge", "branch",
 * "sibling", "another task") would be a word list, which is the arms race
 * ADR-024 §Context exists to end, and it would be bought for ONE fire in twelve.
 * The narrow repair below covers that fire without the trade.
 */

/**
 * `(same file` — a parenthetical cross-reference, not a collision claim.
 *
 * "`mapAttachmentTypeToBlockType` (same file, line 43)" is how this corpus
 * points at a second symbol in a file it just named. `same\s+file` is the
 * weakest member of the verb list — unlike "collides" or "conflicts with" it is
 * not inherently relational — and inside a parenthetical it is doing citation
 * work exclusively.
 *
 * This NARROWS one existing verb's context rather than adding a family, which is
 * the opposite direction from the widening SC1 forbids: it can only ever remove
 * fires, and it removes them from a construction that cannot express a collision.
 */
const CITATION_PARENTHETICAL_RE = /\(\s*same\s+file\b[^)]*\)/gi;

/**
 * Blank citation parentheticals with same-length whitespace.
 *
 * Same convention as `elideMarkdownNonProse`: the replacement preserves
 * character positions and newlines, so anything downstream that reads offsets
 * into the paragraph stays aligned.
 */
function elideCitationParentheticals(text: string): string {
  return text.replace(CITATION_PARENTHETICAL_RE, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * True when a collision verb survives the citation elision.
 *
 * Applied as a DISCRIMINATOR rather than folded into the signal test, so that
 * `paragraphsWithCollisionSignals` stays the raw-signal layer the corpus
 * fixtures assert liveness against. A paragraph carrying both a citation
 * parenthetical and a real verb keeps the real one.
 */
function hasNonCitationCollisionVerb(para: string): boolean {
  return COLLISION_VERB_RE.test(elideCitationParentheticals(para));
}

/**
 * Paragraphs carrying the raw SIGNALS — overlap verb, file token, no denial —
 * before either discriminator runs.
 *
 * Exported for the tests, and for a reason mem#1020 makes concrete: this tune's
 * assertions are almost all negative ("this must STOP firing"), and a negative
 * assertion passes vacuously on a fixture that reaches no matcher at all. It also
 * SURVIVES its own negative control, because "nothing matched" is stable whether
 * or not the code under test is disabled. So each corpus fixture asserts
 * liveness HERE first — it does reach the matcher — and only then asserts that
 * the discriminator is what silences it.
 */
export function paragraphsWithCollisionSignals(specText: string): string[] {
  return paragraphs(stripDuplicateCheckRecords(specText)).filter(
    (p) => COLLISION_VERB_RE.test(p) && FILE_TOKEN_RE.test(p) && !OVERLAP_DENIAL_RE.test(p)
  );
}

/**
 * The paragraphs that actually assert a file-level collision.
 *
 * Returned rather than a boolean because the PR join needs the SAME span
 * (PR #3050 R1). Extracting cited PR numbers from the whole spec made an
 * unrelated `PR #9999` in a `## Context` list a required read, so the guard
 * fired at authors who HAD read the PR their claim was about — the dangerous
 * direction, and a plausible cause of the three "author says `get_files` was
 * read" misses the pre-ship replay measured.
 *
 * Two discriminators sit on top of the raw signals (mt#4190), both structural:
 * the paragraph must not BE an audit record, and it must name a counterparty.
 */
export function collisionParagraphs(specText: string): string[] {
  return paragraphsWithCollisionSignals(specText).filter(
    (p) => !isAuditRecordParagraph(p) && hasNonCitationCollisionVerb(p)
  );
}

/** True when the spec asserts a FILE-level collision, not mere adjacency. */
export function claimsFileCollision(specText: string): boolean {
  return collisionParagraphs(specText).length > 0;
}

/**
 * PR numbers the collision claim names, so the join can require a read of THOSE.
 *
 * `PR #N` ONLY — a bare `#123` is deliberately NOT matched, and the earlier
 * version of this comment claimed otherwise while the code never did it
 * (PR #3050 R1). Bare-`#N` cannot be made safe here: `\b#(\d+)` matches inside
 * every task reference, because `mt#4168` carries a word boundary right before
 * its `#`. Taking bare `#N` would turn each of a spec's task citations into a
 * PR whose files must have been read — the same over-demanding join the
 * paragraph scoping above exists to remove, reintroduced at a larger scale.
 *
 * Scoped to the collision paragraphs, not the whole spec.
 */
export function prNumbersInParagraph(para: string): number[] {
  const out = new Set<number>();
  for (const m of para.matchAll(/\bPR\s*#(\d+)\b/gi)) {
    const n = Number.parseInt(m[1] ?? "", 10);
    if (Number.isInteger(n)) out.add(n);
  }
  return [...out];
}

export function citedPrNumbers(specText: string): number[] {
  const out = new Set<number>();
  for (const para of collisionParagraphs(specText)) {
    for (const n of prNumbersInParagraph(para)) out.add(n);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// No advisory text, deliberately
// ---------------------------------------------------------------------------
//
// An earlier revision built a remediation message here. It is deleted rather
// than left unwired: a builder that nothing calls is the "present, tested,
// green, and inert" shape this tree keeps having to diagnose. The graduation
// task writes the copy when it has the calibration data to aim it — see
// `docs/architecture/hooks/claim-provenance-scan.md` for what the fires
// actually look like today.

// ---------------------------------------------------------------------------
// Dispatcher entry point (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

export function run(input: ToolHookInput, ctx: DispatchContext): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  if (
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes"
  ) {
    return {
      auditLines: [
        `[claim-provenance-scan] OVERRIDE: ack=${overrideVal} session=${
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

  const specText = extractAuthoredSpecText(input.tool_name, input.tool_input);
  if (specText === null) {
    return {
      calibration: { ...base, outcome: "skipped", reason: "no authored spec text on this call" },
    };
  }

  const collision = claimsFileCollision(specText);
  const ownership = claimsNoOwner(specText);
  if (!collision && !ownership) {
    return { calibration: { ...base, outcome: "clean", reason: "no provenance-bearing claim" } };
  }

  const lines = ctx.transcriptLines;
  if (!lines || lines.length === 0) {
    // A claim we cannot adjudicate is `skipped`, never `clean`. A guard whose
    // no-transcript path returned a pass would report an outage as a run of
    // correct behavior.
    return {
      calibration: { ...base, outcome: "skipped", reason: "no transcript lines available" },
    };
  }

  const calls = findToolCallsWithResults(lines);
  const unbacked: string[] = [];

  if (collision) {
    const readPrs = prNumbersWithFileListRead(calls);
    const readHistory = sessionReadMergeHistory(calls);
    // PER PARAGRAPH, not per spec (mt#4190). A claim naming PRs is discharged
    // only by reading THOSE PRs' files; a claim naming none is about a merge,
    // and a path-filtered `git_log` or a branch-range file diff is its evidence.
    //
    // Evaluating the union across every collision paragraph — which is what this
    // did — makes a PR named in paragraph A a required read for the claim made
    // in paragraph B. That is the same over-demanding join PR #3050 R1 fixed one
    // level up by scoping extraction to collision paragraphs rather than the
    // whole spec; it scoped to the SET of them collectively and stopped there.
    // The measured instance: a spec asserting a resolved partial collision on
    // PR #774 (read with `get_files`, and said so) fired anyway, because a
    // SECOND collision paragraph elsewhere named PR #703.
    const unbackedParagraph = collisionParagraphs(specText).some((para) => {
      const cited = prNumbersInParagraph(para);
      return cited.length > 0 ? !cited.every((n) => readPrs.has(n)) : !readHistory;
    });
    if (unbackedParagraph) unbacked.push("a file-level collision");
  }

  if (ownership && !sessionRanASearch(extractToolUseNames(lines))) {
    unbacked.push("a negative ownership claim");
  }

  if (unbacked.length === 0) {
    return { calibration: { ...base, outcome: "clean", reason: "every claim matched a call" } };
  }

  // RECORD-ONLY (mt#4168). No `additionalContext`, and the registration
  // declares `recorderEffect()` alone so the declaration cannot over-describe
  // what ships (the mismatch PR #2886 R1 flagged on the sibling).
  //
  // Decided by measurement, not caution: a 40-transcript replay
  // (`scripts/replay-claim-provenance.ts --sweep`) put this at 16 fires over 70
  // claims, and hand-classifying all 16 found ONE true unbacked claim. Twelve
  // were prose that DISCUSSES a collision rather than asserting one — gate
  // reports, duplicate-signature reconciliations, and this guard's own spec
  // table — and three were claims whose author states in the same paragraph
  // that `get_files` WAS read, which the join missed. Injecting at ~6%
  // precision is the mem#719 failure mode exactly: it would train the reader to
  // discount the one fire that matters, and it would fire hardest at the
  // authors doing the most careful gate-(g) work.
  return {
    calibration: {
      ...base,
      outcome: "matched",
      kinds: unbacked,
      excerpt: safeTruncate(specText, 300, "head"),
    },
  };
}

// ---------------------------------------------------------------------------
// Standalone CLI entry point (fail-open: any error allows the call)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    // Deliberately does NOT call `run()`, for the reason
    // `duplicate-check-search-provenance.ts` records: the discriminating input
    // is `ctx.transcriptLines`, which only the dispatcher populates (D6), so a
    // standalone invocation could only reach the cannot-adjudicate branch.
    await readInput<ToolHookInput>();
    process.stderr.write(
      "[claim-provenance-scan] standalone invocation: this guard reads dispatcher-parsed " +
        "transcript lines and has nothing to check outside it. No-op.\n"
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[claim-provenance-scan] fail-open: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }
}
