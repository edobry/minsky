#!/usr/bin/env bun
/**
 * Unit tests for wall-of-text-detector.ts
 *
 * Covers (mt#2870 acceptance tests):
 * - Synthetic 900-word label-heavy final report -> fires (matched, calibration record)
 * - Contract-conforming report -> does NOT fire
 * - Lead-label trigger fires independently of length; labels AFTER the lead window do not
 * - Deeplink / named-ref counting
 * - Final-text extraction picks the LAST assistant text block of the turn
 * - Override env var suppresses detection and returns an audit line
 * - No transcript_path / empty transcript -> null (silent allow)
 *
 * Covers (mt#3028 regression tests — 2026-07-21 calibration review, ask 8bf53c54):
 * - `resolveTurnLines` re-parses the parent candidate alone, ignoring a
 *   contaminated multi-candidate `ctx.transcriptLines`, when >1 candidate
 *   is present (the empirically-confirmed subagent-contamination bug)
 * - `resolveTurnLines` trusts `ctx.transcriptLines` as-is when <=1 candidate
 *   (the common case — no gratuitous re-parse)
 * - `hashText` / `sessionHasLoggedHash` dedupe-key primitives
 * - `run()`: five 100-word interstitial notes + a 150-word final report does NOT fire
 * - `run()`: the same over-budget report logged across 3 successive turns logs ONCE
 * - `run()`: a genuine 1,500-word final report still fires despite the dedupe check
 *
 * Covers (PR #2165 R1 review-response tests):
 * - `sessionHasLoggedHash` catches an A -> B -> A repeat, not just the
 *   single most-recent record (BLOCKING #1)
 * - `readCalibrationLogText` bounds its read to the last `MAX_DEDUPE_READ_BYTES`
 *   of the log regardless of total file size (BLOCKING #2)
 * - the compiled `.claude/hooks/` copy stays byte-identical (modulo the
 *   generated-file banner) to this file's `.minsky/hooks/` source
 *
 * Covers (mt#3112 acceptance tests — live injection + depth-request override):
 * - `INJECTION_ENABLED` is `true`; a matched over-budget report with no recent
 *   depth request fires WITH `additionalContext`, and logs
 *   `suppressedByDepthRequest: false`
 * - the same shape preceded by a depth-request user turn ("walk me through
 *   everything in detail") suppresses `additionalContext` but STILL logs,
 *   with `suppressedByDepthRequest: true`
 * - `detectDepthRequest` / `DEPTH_REQUEST_PATTERNS` matches all three named
 *   phrasings (walk-me-through / show-the-detail / full-breakdown) and does
 *   NOT match ordinary prose
 * - `recentUserPromptTexts` bounds the lookback to `DEPTH_REQUEST_LOOKBACK_TURNS`
 *   real user prompts at or before the given index, never reaching past it
 *
 * Covers (PR #2228 R1 review-response tests):
 * - `findOpeningPromptIndex` fails CLOSED (`undefined`) with fewer than 2 real
 *   prompts, instead of a magic `?? 0` fallback (BLOCKING #2)
 * - `resolveDepthCheck` treats a fail-closed anchor as unsuppressed
 * - `sessionHasLoggedTextAndSuppression` requires BOTH `textHash` AND
 *   `suppressedByDepthRequest` to match; a coincidental text repeat under a
 *   DIFFERENT suppression state is NOT treated as already-logged (BLOCKING #1)
 * - `run()`: the same finalText recurring first unsuppressed then suppressed
 *   (different preceding context) logs BOTH occurrences, each with its own
 *   correct `suppressedByDepthRequest` value
 *
 * Covers (mt#3972 acceptance tests — question-answer lookback widened past
 * non-principal turn openers):
 * - (AT1) the live 2026-08-11T17:21:47Z shape — principal question,
 *   `<task-notification>` opener, 458-word over-budget report — suppresses
 *   after the widening (negative control against the pre-tune anchor
 *   recorded in the mt#3972 PR body)
 * - (AT2) a lookback window with no principal question still fires
 * - (AT3) a label-led report after a question still fires (SC3 preserved)
 * - `isNonPrincipalTurnOpener` matches `<task-notification>`,
 *   `<system-reminder>`, and the `[SYSTEM NOTIFICATION` preamble form
 * - `findRecentPrincipalPromptIndex` skips non-principal openers, is bounded
 *   by `QUESTION_ANSWER_LOOKBACK_TURNS`, and fails CLOSED outside the window
 * - `resolveQuestionAnswerCheck` still does NOT skip past a genuine
 *   principal turn that isn't a question, hunting for an older one (the
 *   FP-risk bound SC1 requires)
 *
 * @see mt#2870
 * @see mt#3028
 * @see mt#3112
 * @see mt#3718
 * @see mt#3972
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  measureWallOfText,
  extractFinalAssistantText,
  hashText,
  sessionHasLoggedHash,
  readCalibrationLogText,
  MAX_DEDUPE_READ_BYTES,
  WORD_COUNT_THRESHOLD,
  LEAD_WORD_BUDGET,
  OVER_BUDGET_MULTIPLIER,
  LEAD_WINDOW_WORDS,
  EXCERPT_MAX_CHARS,
  EXCERPT_TRUNCATION_MARKER,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  DEPTH_REQUEST_LOOKBACK_TURNS,
  DEPTH_REQUEST_SCAN_LIMIT,
  DEPTH_REQUEST_PATTERNS,
  detectDepthRequest,
  recentUserPromptTexts,
  findOpeningPromptIndex,
  resolveDepthCheck,
  sessionHasLoggedTextAndSuppression,
  SUPPRESSION_DEPTH_REQUEST,
  SUPPRESSION_QUESTION_ANSWER,
  QUESTION_MIN_WORDS,
  detectSubstantiveQuestion,
  resolveQuestionAnswerCheck,
  QUESTION_ANSWER_LOOKBACK_TURNS,
  isNonPrincipalTurnOpener,
  findRecentPrincipalPromptIndex,
  run,
  type RunDeps,
} from "./wall-of-text-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";
import { ARTIFACT_CAPTURE_MAX_CHARS } from "./judged-input-capture";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// Shared path constants (custom/no-magic-string-duplication).
const FAKE_TRANSCRIPT_PATH = "/tmp/fake-transcript.jsonl";
const SUBAGENT_TRANSCRIPT_PATH = "/tmp/subagents/agent-fake.jsonl";
// Shared generic opening-prompt text (custom/no-magic-string-duplication) — used
// wherever a fixture's opening prompt content is not itself under test.
const OPENING_PROMPT_TEXT = "please do the thing";
// Shared depth-request phrase fixtures (custom/no-magic-string-duplication).
const DEPTH_REQUEST_PHRASE = "walk me through everything in detail";
const DEPTH_REQUEST_PHRASE_BARE = "walk me through everything";
// Shared question-answer phrase fixtures (custom/no-magic-string-duplication) —
// mt#3718. The two ask#6891 FP shapes: a plain interrogative and a
// multi-question prompt.
const QUESTION_ANSWER_PHRASE = "what happened with the deploy?";
const QUESTION_ANSWER_PHRASE_BUN_BUG =
  "Is this a known, reported Bun bug, or something specific to our setup?";
// mt#3972 — a multi-part question, mirroring the shape of the live
// 2026-08-11T17:21:47Z record's opening question (session `25a27bdb`).
// Used ONLY by the mt#3972 lookback tests, which exist to prove the
// QUESTION-ANSWER gate finds a principal question past a non-principal turn
// opener. It must therefore trip that gate and no other: if it also matched
// `DEPTH_REQUEST_PATTERNS`, those tests would pass via the depth gate even
// with the lookback widening reverted — a probe that cannot fail (mem#704).
//
// mt#4031 removed a leading "Help me understand more precisely:" from this
// fixture for exactly that reason. Worth recording rather than just deleting:
// this fixture was drawn from the live 2026-08-11T17:21:47Z record, so its
// original wording is an independently-collected THIRD instance of the shape
// mt#4031's `help-me-understand` widening is calibrated from — one found by a
// different task, months of records apart, without looking for it. The
// remaining text is still a multi-part substantive question, which is all
// these three tests need.
const MULTI_PART_QUESTION =
  "What's the actual mechanism here, why does it apply in this case, and how does it compare to the alternative we discussed?";
// mt#4031 — the VERBATIM `precedingPrompt` excerpts from the two 2026-08-12
// over-budget records that carried `suppressedByDepthRequest: false`, plus the
// name of the pattern added to match them. Verbatim is the point: these are a
// regression test for the measured misses, not a restatement of the regex.
const MT4031_PATTERN_NAME = "help-me-understand";
const MT4031_MEASURED_PROMPT_ONE =
  "help me understand what your proposal would actually look like and how it would work";
const MT4031_MEASURED_PROMPT_TWO =
  "help me understand where those missing subagent launches went, i feel like i'm missing something here. and that other ask is answered";
// mt#3972 — non-principal turn-opener fixtures (task-notification /
// system-reminder), matching the shapes `isNonPrincipalTurnOpener` matches.
const TASK_NOTIFICATION_TEXT =
  "<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>";
const SYSTEM_REMINDER_TEXT = "<system-reminder>\nInjected reminder content.\n</system-reminder>";
// mt#4109 — the harness-markup turn openers the prefix list was MISSING until
// 2026-08-25. All three are VERBATIM `precedingPrompt` excerpts from the
// calibration log (8 records anchored on `<local-command-stdout`, 7 on
// `<command-name`, 1 on `<bash-stdout`), not invented shapes.
const LOCAL_COMMAND_STDOUT_TEXT =
  "<local-command-stdout>Reconnected to minsky.</local-command-stdout>";
const COMMAND_NAME_TEXT =
  "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>";
const BASH_STDOUT_TEXT =
  "<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>";
// mt#4109 — the tag `packages/shared/src/harness-markup.ts` explicitly warns
// against adding on symmetry grounds ("A `local-command-stderr` tag does NOT
// exist in the corpus"). Pinned ABSENT so a future symmetry-driven addition
// fails here rather than shipping.
const NONEXISTENT_STDERR_TAG = "<local-command-stderr";

const BASE_TS = Date.parse("2026-07-17T10:00:00.000Z");

function ts(offsetSeconds: number): string {
  return new Date(BASE_TS + offsetSeconds * 1000).toISOString();
}

function userPromptLine(offsetSeconds: number, text = "user message"): TranscriptLine {
  return {
    type: "user",
    message: { role: "user", content: text },
    timestamp: ts(offsetSeconds),
  };
}

function assistantTextLine(offsetSeconds: number, text: string): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts(offsetSeconds),
  };
}

function assistantToolUseLine(offsetSeconds: number, toolName = "Read"): TranscriptLine {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: toolName, input: {} }],
    },
    timestamp: ts(offsetSeconds),
  };
}

/** n filler words ("w0 w1 ..."). */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
}

/** The mt#2870 acceptance-test report: 900 words, label-heavy opening. */
function labelHeavyReport(): string {
  return `Gate (l) verdict and premise audit (iii): ${words(893)}`;
}

/** A contract-conforming Tier-1 report: short, plain lead, detail behind a pointer. */
function conformingReport(): string {
  return [
    "Merged the credential-fallback change and verified the deploy is healthy.",
    "One judgment call: waited for the size-budget fix from another agent",
    "instead of overriding. Details are in [PR #2024](minsky://changeset/2024)",
    "and the task record [mt#2897](minsky://task/mt%232897). Nothing is pending.",
  ].join("\n");
}

function makeInput(overrides: Partial<ClaudeHookInput> = {}): ClaudeHookInput {
  return {
    session_id: "wall-of-text-test-session",
    transcript_path: FAKE_TRANSCRIPT_PATH,
    cwd: "/tmp",
    hook_event_name: "UserPromptSubmit",
    ...overrides,
  } as ClaudeHookInput;
}

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return { transcriptLines } as DispatchContext;
}

/** A ctx with >1 resolved transcript candidates — the mt#3028 contamination-risk shape. */
function makeCtxWithCandidates(
  transcriptLines: TranscriptLine[],
  transcriptCandidates: string[]
): DispatchContext {
  return { transcriptLines, transcriptCandidates } as DispatchContext;
}

/**
 * Deterministic `run()` deps for tests that don't care about dedupe: no
 * filesystem access (`custom/no-real-fs-in-tests`), always reports "no prior
 * record" so the dedupe check never suppresses a test's expected match.
 */
function noDedupeDeps(): RunDeps {
  return { readCalibrationLogTextFn: () => undefined };
}

/** A full synthetic transcript: prompt, report line(s), closing prompt. */
function transcriptWithFinalReport(reportText: string): TranscriptLine[] {
  return [
    userPromptLine(0, OPENING_PROMPT_TEXT),
    assistantToolUseLine(10),
    assistantTextLine(60, reportText),
    userPromptLine(120, "next prompt"),
  ];
}

/**
 * Same shape as {@link transcriptWithFinalReport}, but the OPENING prompt
 * (the one that caused the measured turn) carries `openingPromptText` instead
 * of the generic filler — used to place a depth-request phrase where the
 * mt#3112 lookback (`recentUserPromptTexts`, bounded to the opening prompt)
 * will actually see it.
 */
function transcriptWithFinalReportAndOpeningPrompt(
  openingPromptText: string,
  reportText: string
): TranscriptLine[] {
  return [
    userPromptLine(0, openingPromptText),
    assistantToolUseLine(10),
    assistantTextLine(60, reportText),
    userPromptLine(120, "next prompt"),
  ];
}

/** A 500-word, pointer-free (no deeplinks/named refs) over-budget report — the mt#3112 AT shape. */
function pointerFreeOverBudgetReport(): string {
  return `Status update, no pointers at all. ${words(500)}`;
}

/**
 * A 458-word over-budget report — the mt#3972 AT1 fixture, matching the live
 * 2026-08-11T17:21:47Z record's measured word count (session `25a27bdb`).
 */
function report458Words(): string {
  return `Status update on the research thread. ${words(452)}`;
}

/** A turn opener the operator did not type — `isNonPrincipalTurnOpener` matches it (mt#3972). */
function taskNotificationLine(offsetSeconds: number): TranscriptLine {
  return userPromptLine(offsetSeconds, TASK_NOTIFICATION_TEXT);
}

/** A hook-injected reminder turn opener — `isNonPrincipalTurnOpener` matches it (mt#3972). */
function systemReminderLine(offsetSeconds: number): TranscriptLine {
  return userPromptLine(offsetSeconds, SYSTEM_REMINDER_TEXT);
}

// ---------------------------------------------------------------------------
// measureWallOfText — pure function
// ---------------------------------------------------------------------------

describe("measureWallOfText", () => {
  test("900-word label-heavy report -> matched, trigger 'both' (acceptance test)", () => {
    const m = measureWallOfText(labelHeavyReport());
    expect(m.wordCount).toBeGreaterThanOrEqual(900);
    expect(m.matched).toBe(true);
    expect(m.trigger).toBe("both");
    expect(m.leadLabelHits).toContain("gate-letter");
    expect(m.leadLabelHits).toContain("premise-label");
  });

  test("contract-conforming report -> NOT matched (acceptance test)", () => {
    const m = measureWallOfText(conformingReport());
    expect(m.wordCount).toBeLessThan(WORD_COUNT_THRESHOLD);
    expect(m.leadLabelHits).toEqual([]);
    expect(m.matched).toBe(false);
    expect(m.trigger).toBe("none");
  });

  test("over-budget alone (clean prose at the threshold) -> trigger 'over-budget'", () => {
    const m = measureWallOfText(words(WORD_COUNT_THRESHOLD));
    expect(m.matched).toBe(true);
    expect(m.trigger).toBe("over-budget");
    expect(m.leadLabelHits).toEqual([]);
  });

  // mt#3942: the multiplier dropped 2 -> 1.5, narrowing the silent band from
  // 201-399 to 201-299 at the default budget. These pin the DECISION (the
  // multiplier) and the BEHAVIOUR (the newly-covered band) separately, and both
  // are expressed relative to the constants — `LEAD_WORD_BUDGET` is tunable via
  // MINSKY_WALL_OF_TEXT_WORD_BUDGET, so a literal word count would make these
  // tests fail on a tuned machine for a reason unrelated to what they assert
  // (PR #2798 R1 BLOCKING).
  test("the over-budget multiplier is 1.5x the contract budget", () => {
    expect(OVER_BUDGET_MULTIPLIER).toBe(1.5);
    expect(WORD_COUNT_THRESHOLD).toBe(Math.ceil(LEAD_WORD_BUDGET * OVER_BUDGET_MULTIPLIER));
  });

  test("the threshold is a whole number of words for any tuned budget", () => {
    // A non-integer multiplier makes an odd budget produce a fractional
    // threshold (141 * 1.5 = 211.5), which no word count can equal — so every
    // equality-based edge test would under-shoot it. WORD_COUNT_THRESHOLD
    // rounds up to stay in the same domain as the counts it is compared
    // against; this pins that so a future multiplier change cannot silently
    // reintroduce the fractional case. (PR #2798 R2 BLOCKING.)
    expect(Number.isInteger(WORD_COUNT_THRESHOLD)).toBe(true);
  });

  test("a report just over the threshold fires — the band the old 2x multiplier missed", () => {
    // Under the old 2x this length sat below the threshold and produced no
    // record at all, which is why an over-long report drew a human complaint
    // instead of a warning.
    const m = measureWallOfText(words(WORD_COUNT_THRESHOLD + 20));
    expect(m.matched).toBe(true);
    expect(m.trigger).toBe("over-budget");
  });

  test("a report below the threshold still does not fire, so margin over the budget survives", () => {
    // 1.5x deliberately leaves headroom above the ~200-word target rather than
    // firing on every report that runs slightly long — the lower-bound control.
    const m = measureWallOfText(words(WORD_COUNT_THRESHOLD - 50));
    expect(m.wordCount).toBeLessThan(WORD_COUNT_THRESHOLD);
    expect(m.matched).toBe(false);
    expect(m.trigger).toBe("none");
  });

  test("under budget but 'gate (l)' in the lead -> trigger 'lead-labels'", () => {
    const m = measureWallOfText(`Gate (l) blocked promotion. ${words(150)}`);
    expect(m.matched).toBe(true);
    expect(m.trigger).toBe("lead-labels");
    expect(m.leadLabelHits).toEqual(["gate-letter"]);
  });

  // mt#3336 regression (ask#6448): the 2026-07-29T11:38:59Z record — a
  // 56-word one-liner flagged only for containing "SC#5". Below
  // LEAD_LABELS_MIN_WORDS the lead-labels leg no longer fires: a short reply
  // is not a wall of text whatever vocabulary it uses.
  test("mt#3336: a 56-word reply containing SC#5 does NOT match (word-count floor)", () => {
    const m = measureWallOfText(`SC#5 is discharged. ${words(52)}`);
    expect(m.wordCount).toBeLessThan(100);
    expect(m.leadLabelHits).toEqual(["sc-ref"]);
    expect(m.matched).toBe(false);
    expect(m.trigger).toBe("none");
  });

  test("SC#N ref in the lead -> 'sc-ref' hit", () => {
    const m = measureWallOfText(`SC#3 is unmet. ${words(150)}`);
    expect(m.leadLabelHits).toEqual(["sc-ref"]);
    expect(m.matched).toBe(true);
  });

  test("'(i.e.' does not false-positive the premise-label pattern", () => {
    const m = measureWallOfText(`The fallback (i.e. keychain) is expected. ${words(20)}`);
    expect(m.leadLabelHits).toEqual([]);
    expect(m.matched).toBe(false);
  });

  test("roman numerals past (iv) match the premise-label pattern (PR #2036 R1)", () => {
    const m5 = measureWallOfText(`Premise (v) remains open. ${words(20)}`);
    expect(m5.leadLabelHits).toEqual(["premise-label"]);
    const m6 = measureWallOfText(`Check (vi): unresolved. ${words(20)}`);
    expect(m6.leadLabelHits).toEqual(["premise-label"]);
  });

  test("bare and unclosed gate-letter forms match; ordinary words do not (PR #2036 R1)", () => {
    expect(measureWallOfText(`Gate l blocked promotion. ${words(20)}`).leadLabelHits).toEqual([
      "gate-letter",
    ]);
    expect(measureWallOfText(`Gate (l blocked promotion. ${words(20)}`).leadLabelHits).toEqual([
      "gate-letter",
    ]);
    // A bare letter must be a standalone token — "gate lock" is prose, not a label.
    expect(measureWallOfText(`The gate lock is broken. ${words(20)}`).leadLabelHits).toEqual([]);
  });

  test("labels AFTER the lead window do not trigger on an under-budget report", () => {
    // Labels land beyond the first LEAD_WINDOW_WORDS words; total stays
    // under WORD_COUNT_THRESHOLD — the audit-trail-after-the-lead shape the
    // contract explicitly allows.
    const text = `${words(LEAD_WINDOW_WORDS + 10)} audit trail: gate (l) passed, premise (iii) clear`;
    const m = measureWallOfText(text);
    expect(m.wordCount).toBeLessThan(WORD_COUNT_THRESHOLD);
    expect(m.leadLabelHits).toEqual([]);
    expect(m.matched).toBe(false);
  });

  test("deeplink and named-ref counting", () => {
    const m = measureWallOfText(
      "Merged [PR #12](minsky://changeset/12) for [mt#34](minsky://task/mt%2334); PR #56 pending."
    );
    expect(m.deeplinkCount).toBe(2);
    // mt#34 + PR #12 + PR #56 (the label text inside the markdown links counts too)
    expect(m.namedRefCount).toBe(3);
  });

  test("'PR#12' without a space counts as a named ref (PR #2036 R1)", () => {
    const m = measureWallOfText("Merged PR#12 and mt#34.");
    expect(m.namedRefCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// measureWallOfText — excerpt (mt#3576)
// ---------------------------------------------------------------------------

describe("measureWallOfText — excerpt (mt#3576)", () => {
  test("a lead-labels fire retains the text its leadLabelHits were computed from", () => {
    // The gap this closes: `leadLabelHits: ["gate-letter"]` names the pattern
    // but never the text, so a reviewer could not tell an audit-vocabulary
    // lead from an incidental token without rebuilding the transcript.
    const m = measureWallOfText(`Gate (l) blocked promotion. ${words(150)}`);
    expect(m.trigger).toBe("lead-labels");
    expect(m.leadLabelHits).toEqual(["gate-letter"]);
    expect(m.excerpt).toContain("Gate (l) blocked promotion.");
  });

  test("the excerpt IS the scanned lead, so every label hit is visible in it", () => {
    // Identity, not approximation: whatever slice the patterns are tested
    // against is exactly what the record retains. Asserted by re-running the
    // detector on the excerpt alone and getting the same hits back.
    const m = measureWallOfText(labelHeavyReport());
    expect(m.leadLabelHits.length).toBeGreaterThan(0);
    expect(measureWallOfText(m.excerpt).leadLabelHits).toEqual(m.leadLabelHits);
  });

  test("an over-budget report is recognizable from its excerpt (mt#3028 contamination class)", () => {
    // wordCount alone cannot separate a genuine long report from one measured
    // against a subagent's transcript; the opening text can.
    const m = measureWallOfText(pointerFreeOverBudgetReport());
    expect(m.trigger).toBe("over-budget");
    expect(m.excerpt.startsWith("Status update, no pointers at all.")).toBe(true);
  });

  test("the excerpt never exceeds EXCERPT_MAX_CHARS, and marks that it was cut", () => {
    // A pathological single token: under the word bound (1 word), far past the
    // char bound — the case the cap exists for.
    const m = measureWallOfText(`${"x".repeat(EXCERPT_MAX_CHARS * 3)} ${words(400)}`);
    expect(m.excerpt.length).toBe(EXCERPT_MAX_CHARS + EXCERPT_TRUNCATION_MARKER.length);
    expect(m.excerpt.endsWith(EXCERPT_TRUNCATION_MARKER)).toBe(true);
  });

  test("a label at the END of the lead window survives into the excerpt", () => {
    // The class this covers that the fixtures above do not: a label sitting
    // LATE in the scanned window. Any excerpt shorter than the full lead —
    // an opening line, a fixed char prefix — drops it, and the record would
    // then name a pattern whose text it does not carry. The label is placed
    // at word ~145 of a 150-word window, still inside the scan, so it must
    // appear in the retained text.
    const m = measureWallOfText(`${words(LEAD_WINDOW_WORDS - 5)} gate (l) verdict ${words(400)}`);
    expect(m.leadLabelHits).toEqual(["gate-letter"]);
    expect(m.excerpt).toContain("gate (l)");
  });

  test("a lead shorter than the cap is retained whole, with no truncation marker", () => {
    const m = measureWallOfText(words(WORD_COUNT_THRESHOLD));
    expect(m.excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
    expect(m.excerpt.endsWith(EXCERPT_TRUNCATION_MARKER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractFinalAssistantText
// ---------------------------------------------------------------------------

describe("extractFinalAssistantText", () => {
  test("picks the LAST assistant text block, skipping trailing tool lines", () => {
    const turn = [
      assistantTextLine(1, "first status note"),
      assistantToolUseLine(2),
      assistantTextLine(3, "the final report"),
      assistantToolUseLine(4),
    ];
    expect(extractFinalAssistantText(turn)).toBe("the final report");
  });

  test("returns empty string when the turn has no assistant text", () => {
    expect(extractFinalAssistantText([assistantToolUseLine(1)])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// run() — dispatcher path
// ---------------------------------------------------------------------------

describe("run", () => {
  test("label-heavy over-budget report -> calibration outcome + live injection (mt#3112)", () => {
    const lines = transcriptWithFinalReport(labelHeavyReport());
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.calibration).toBeDefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.trigger).toBe("both");
    expect(cal.wordCount as number).toBeGreaterThanOrEqual(900);
    expect(cal.session_id).toBe("wall-of-text-test-session");
    // mt#3028: every logged record carries a dedupe hash.
    expect(typeof cal.textHash).toBe("string");
    expect((cal.textHash as string).length).toBeGreaterThan(0);
    // mt#3112: LIVE — no recent depth request, so injection fires and the
    // record logs suppressedByDepthRequest: false.
    expect(INJECTION_ENABLED).toBe(true);
    expect(cal.suppressedByDepthRequest).toBe(false);
    expect(outcome?.additionalContext).toBeDefined();
    // mt#4531 reworded the header: the measurement is now whole-turn, so
    // calling it a "report" violation understated what was measured.
    expect(outcome?.additionalContext).toContain("Turn shape violation");
  });

  test("contract-conforming report -> null", () => {
    const lines = transcriptWithFinalReport(conformingReport());
    expect(run(makeInput(), makeCtx(lines), noDedupeDeps())).toBeNull();
  });

  // mt#3576: the written record — not just the measurement — carries the
  // excerpt, and it is the same string the label patterns matched against.
  test("mt#3576: the logged record carries the excerpt, matching the measurement", () => {
    const lines = transcriptWithFinalReport(labelHeavyReport());
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(typeof cal.excerpt).toBe("string");
    expect(cal.excerpt).toBe(measureWallOfText(labelHeavyReport()).excerpt);
    expect(cal.excerpt as string).toContain("Gate (l)");
    expect((cal.excerpt as string).length).toBeLessThanOrEqual(
      EXCERPT_MAX_CHARS + EXCERPT_TRUNCATION_MARKER.length
    );
  });

  test("override env var -> audit line, no measurement", () => {
    const prev = process.env[OVERRIDE_ENV_VAR];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const lines = transcriptWithFinalReport(labelHeavyReport());
      const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
      expect(outcome?.calibration).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      if (prev === undefined) {
        delete process.env[OVERRIDE_ENV_VAR];
      } else {
        process.env[OVERRIDE_ENV_VAR] = prev;
      }
    }
  });

  test("missing transcript_path -> null", () => {
    const lines = transcriptWithFinalReport(labelHeavyReport());
    const input = makeInput({ transcript_path: undefined });
    expect(run(input, makeCtx(lines), noDedupeDeps())).toBeNull();
  });

  test("empty transcript -> null", () => {
    expect(run(makeInput(), makeCtx([]), noDedupeDeps())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mt#3112 acceptance tests — live injection + depth-request override
// ---------------------------------------------------------------------------

describe("run — mt#3112 depth-request override", () => {
  test("(AT1) 500-word pointer-free final report -> injection emitted + log record", () => {
    const lines = transcriptWithFinalReport(pointerFreeOverBudgetReport());
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.calibration).toBeDefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.trigger).toBe("over-budget");
    expect(cal.suppressedByDepthRequest).toBe(false);
    expect(outcome?.additionalContext).toBeDefined();
  });

  test("(AT2) same shape preceded by a depth-request opening prompt -> no injection, logged suppressed", () => {
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      DEPTH_REQUEST_PHRASE,
      pointerFreeOverBudgetReport()
    );
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal).toBeDefined();
    expect(cal.suppressedByDepthRequest).toBe(true);
    // mt#3207: the SHARED field is what `isSuppressedRecord` reads — the
    // boolean above has always been invisible to the sweep, so the override's
    // real-world fire rate (ask#5425's stated payoff) never reached it.
    expect(cal.suppressionReasons).toEqual([SUPPRESSION_DEPTH_REQUEST]);
  });

  test("(mt#3207) an INJECTED report records an empty suppressionReasons, not an absent one", () => {
    // mt#3718: the opening prompt here MUST NOT be a substantive question —
    // it would then trip the new question-answer override and suppress the
    // fire, defeating this test's purpose (demonstrating the UNSUPPRESSED,
    // injected shape). "what happened with the deploy?" (the original
    // fixture) is itself a substantive question under the new logic, so a
    // plain non-question opening prompt is used instead.
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      OPENING_PROMPT_TEXT,
      pointerFreeOverBudgetReport()
    );
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome?.additionalContext).toBeDefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressionReasons).toEqual([]);
    expect(Object.keys(cal)).toContain("suppressionReasons");
  });

  test("a depth request several turns back (within lookback) still suppresses", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, "show me the detail on this one"),
      assistantTextLine(5, "ok, digging in"),
      userPromptLine(10, "please continue"),
      assistantToolUseLine(15),
      assistantTextLine(60, pointerFreeOverBudgetReport()),
      userPromptLine(120, "next prompt"),
    ];
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressedByDepthRequest).toBe(true);
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("a depth request OUTSIDE the lookback window does NOT suppress", () => {
    // DEPTH_REQUEST_LOOKBACK_TURNS real user prompts intervene between the
    // depth request and the opening prompt of the measured turn — it has
    // scrolled out of the "recent" window.
    const lines: TranscriptLine[] = [
      userPromptLine(0, DEPTH_REQUEST_PHRASE_BARE),
      assistantTextLine(1, "ok"),
      userPromptLine(2, "turn two"),
      assistantTextLine(3, "ok"),
      userPromptLine(4, "turn three"),
      assistantTextLine(5, "ok"),
      userPromptLine(6, "turn four"),
      assistantTextLine(7, "ok"),
      userPromptLine(8, OPENING_PROMPT_TEXT),
      assistantToolUseLine(10),
      assistantTextLine(60, pointerFreeOverBudgetReport()),
      userPromptLine(120, "next prompt"),
    ];
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressedByDepthRequest).toBe(false);
    expect(outcome?.additionalContext).toBeDefined();
  });

  test("a depth request in the CURRENT (not-yet-answered) prompt does not retroactively suppress", () => {
    // The depth request arrives AFTER the measured report — it could not have
    // caused it, so it must not suppress this fire.
    const lines = [
      userPromptLine(0, OPENING_PROMPT_TEXT),
      assistantToolUseLine(10),
      assistantTextLine(60, pointerFreeOverBudgetReport()),
      userPromptLine(120, DEPTH_REQUEST_PHRASE),
    ];
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressedByDepthRequest).toBe(false);
    expect(outcome?.additionalContext).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// mt#4031 — the question-answer override missed explanation-answers
//
// End-to-end counterpart to the unit tests below. The two prompts are the
// verbatim `precedingPrompt` excerpts from the records that made this task
// measurable; the third test is the negative control the spec's AT2 requires,
// and it is the one that would catch an over-broad widening: an ordinary
// over-budget turn-end report must still fire, or the detector has lost its
// purpose (spec SC3).
// ---------------------------------------------------------------------------

describe("run — mt#4031 help-me-understand override", () => {
  test("an over-budget report answering the first measured prompt is suppressed", () => {
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      MT4031_MEASURED_PROMPT_ONE,
      pointerFreeOverBudgetReport()
    );
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.trigger).toBe("over-budget");
    expect(cal.suppressedByDepthRequest).toBe(true);
    expect(cal.suppressionReasons).toEqual([SUPPRESSION_DEPTH_REQUEST]);
  });

  test("an over-budget report answering the second measured prompt is suppressed", () => {
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      MT4031_MEASURED_PROMPT_TWO,
      pointerFreeOverBudgetReport()
    );
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressedByDepthRequest).toBe(true);
    expect(cal.suppressionReasons).toEqual([SUPPRESSION_DEPTH_REQUEST]);
  });

  // NEGATIVE CONTROL (spec AT2 / SC3). The identical report, preceded by an
  // ordinary prompt, must STILL fire. Without this, a widening that matched
  // everything would pass both tests above.
  test("the same report after an ordinary prompt still fires", () => {
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      OPENING_PROMPT_TEXT,
      pointerFreeOverBudgetReport()
    );
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome?.additionalContext).toBeDefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressedByDepthRequest).toBe(false);
    expect(cal.suppressionReasons).toEqual([]);
  });
});

describe("detectDepthRequest / DEPTH_REQUEST_PATTERNS", () => {
  test("exposes the three mt#3112 patterns, the four mt#3336 widenings, and the mt#4031 widening", () => {
    expect(DEPTH_REQUEST_PATTERNS.map((p) => p.name)).toEqual([
      "walk-me-through",
      "show-the-detail",
      "full-breakdown",
      "deep-dive",
      "go-into-detail",
      "be-expansive",
      "in-full-detail",
      "help-me-understand",
    ]);
  });

  test("matches each of the three named phrasings", () => {
    expect(detectDepthRequest(["walk me through everything please"]).matched).toBe(true);
    expect(detectDepthRequest(["can you show me the detail"]).matched).toBe(true);
    expect(detectDepthRequest(["give me the full breakdown"]).matched).toBe(true);
  });

  // mt#3336 widenings — each imperative-shaped request for MORE depth.
  test("matches each of the mt#3336 widened phrasings", () => {
    expect(detectDepthRequest(["take a deep dive on the auth module"]).matched).toBe(true);
    expect(detectDepthRequest(["deep-dive into the sweep logic"]).matched).toBe(true);
    expect(detectDepthRequest(["go into more detail on the failure"]).matched).toBe(true);
    expect(detectDepthRequest(["be expansive here"]).matched).toBe(true);
    expect(detectDepthRequest(["be thorough about the edge cases"]).matched).toBe(true);
    expect(detectDepthRequest(["explain it in full detail"]).matched).toBe(true);
  });

  test("matches the mt#4031 measured prompts", () => {
    expect(detectDepthRequest([MT4031_MEASURED_PROMPT_ONE]).matched).toBe(true);
    expect(detectDepthRequest([MT4031_MEASURED_PROMPT_ONE]).matchedPattern).toBe(
      MT4031_PATTERN_NAME
    );
    expect(detectDepthRequest([MT4031_MEASURED_PROMPT_TWO]).matched).toBe(true);
    expect(detectDepthRequest([MT4031_MEASURED_PROMPT_TWO]).matchedPattern).toBe(
      MT4031_PATTERN_NAME
    );
  });

  // The widening is bounded to the phrase the records name. These adjacent
  // shapes are the neighborhood it deliberately does NOT reach — pinning them
  // as non-matching is what keeps a later edit from quietly generalizing the
  // entry into "any request for an explanation".
  test("mt#4031 widening does not reach adjacent unmeasured phrasings", () => {
    expect(detectDepthRequest(["explain the sweep logic"]).matched).toBe(false);
    expect(detectDepthRequest(["i don't understand the sweep logic"]).matched).toBe(false);
    expect(detectDepthRequest(["do you understand the sweep logic"]).matched).toBe(false);
  });

  test("does not match ordinary prose", () => {
    expect(detectDepthRequest(["please fix the bug in session.ts"]).matched).toBe(false);
    expect(detectDepthRequest(["background this for me"]).matched).toBe(false);
  });

  test("returns the matched pattern name", () => {
    expect(detectDepthRequest([DEPTH_REQUEST_PHRASE_BARE]).matchedPattern).toBe("walk-me-through");
  });

  test("empty input -> not matched", () => {
    expect(detectDepthRequest([]).matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mt#3718 — question-answer override widening
// ---------------------------------------------------------------------------

describe("detectSubstantiveQuestion", () => {
  test("matches a plain interrogative", () => {
    expect(detectSubstantiveQuestion(QUESTION_ANSWER_PHRASE).matched).toBe(true);
  });

  test("matches a multi-question prompt", () => {
    expect(
      detectSubstantiveQuestion(
        "What happened with the pickup ack? Why didn't I see it? Should the retrospective watcher have caught this?"
      ).matched
    ).toBe(true);
  });

  test("does not match a brief affirmative with no question mark", () => {
    expect(detectSubstantiveQuestion("proceed").matched).toBe(false);
  });

  test("does not match a bare 'ok?' below the word floor", () => {
    expect(detectSubstantiveQuestion("ok?").matched).toBe(false);
  });

  test("does not match an empty string", () => {
    expect(detectSubstantiveQuestion("").matched).toBe(false);
    expect(detectSubstantiveQuestion("   ").matched).toBe(false);
  });

  test("QUESTION_MIN_WORDS is the floor separating 'ok?' from a real question", () => {
    const belowFloor = Array.from({ length: QUESTION_MIN_WORDS - 1 }, () => "w").join(" ");
    expect(detectSubstantiveQuestion(`${belowFloor}?`).matched).toBe(false);
    const atFloor = Array.from({ length: QUESTION_MIN_WORDS }, () => "w").join(" ");
    expect(detectSubstantiveQuestion(`${atFloor}?`).matched).toBe(true);
  });
});

describe("resolveQuestionAnswerCheck", () => {
  test("a REAL principal turn between a question and the opening does not suppress (bound preserved)", () => {
    // mt#3972 widened this gate to skip NON-PRINCIPAL openers, but a
    // genuine principal turn that intervenes — and isn't itself a question —
    // still stops the walk: the gate must not keep hunting further back for
    // an OLDER question once it lands on a real principal prompt. This is
    // exactly the FP-risk guard SC1 requires preserved (it is what the
    // original mt#3718 single-opening-prompt anchor protected against).
    const lines: TranscriptLine[] = [
      userPromptLine(0, QUESTION_ANSWER_PHRASE),
      assistantTextLine(1, "ok"),
      userPromptLine(2, OPENING_PROMPT_TEXT),
      assistantToolUseLine(4),
      assistantTextLine(60, pointerFreeOverBudgetReport()),
      userPromptLine(120, "next prompt"),
    ];
    expect(resolveQuestionAnswerCheck(lines).matched).toBe(false);
  });

  test("matches when the OPENING prompt itself is a substantive question", () => {
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      QUESTION_ANSWER_PHRASE,
      pointerFreeOverBudgetReport()
    );
    expect(resolveQuestionAnswerCheck(lines).matched).toBe(true);
  });

  test("fails CLOSED when findOpeningPromptIndex cannot anchor", () => {
    expect(resolveQuestionAnswerCheck([userPromptLine(0, "only one prompt?")]).matched).toBe(false);
  });

  // mt#3972 — widened lookback past non-principal turn openers.
  test("widens past a SINGLE task-notification opener to the principal's question", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, QUESTION_ANSWER_PHRASE),
      assistantTextLine(1, "ok, digging in"),
      taskNotificationLine(30),
      assistantToolUseLine(31),
      assistantTextLine(60, pointerFreeOverBudgetReport()),
      userPromptLine(120, "next prompt"),
    ];
    expect(resolveQuestionAnswerCheck(lines).matched).toBe(true);
  });

  test("widens past a SINGLE system-reminder opener to the principal's question", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, QUESTION_ANSWER_PHRASE),
      assistantTextLine(1, "ok, digging in"),
      systemReminderLine(30),
      assistantToolUseLine(31),
      assistantTextLine(60, pointerFreeOverBudgetReport()),
      userPromptLine(120, "next prompt"),
    ];
    expect(resolveQuestionAnswerCheck(lines).matched).toBe(true);
  });

  test("widens past MULTIPLE consecutive non-principal openers within the bound", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, QUESTION_ANSWER_PHRASE),
      assistantTextLine(1, "ok, digging in"),
      taskNotificationLine(10),
      taskNotificationLine(20),
      taskNotificationLine(30),
      assistantToolUseLine(31),
      assistantTextLine(60, pointerFreeOverBudgetReport()),
      userPromptLine(120, "next prompt"),
    ];
    expect(resolveQuestionAnswerCheck(lines).matched).toBe(true);
  });

  test("does NOT widen past QUESTION_ANSWER_LOOKBACK_TURNS non-principal openers (bound is enforced)", () => {
    // Exactly QUESTION_ANSWER_LOOKBACK_TURNS real-prompt slots are consumed
    // entirely by non-principal openers before the principal's question is
    // reached — it has scrolled out of the bounded window, so this must NOT
    // suppress. This is the SC1 bound doing its job: without it, this fixture
    // would suppress too, on the grounds that a question exists SOMEWHERE in
    // the transcript. Generated from the constant (rather than a hardcoded
    // count) so the test tracks the bound if it is ever retuned.
    const openers: TranscriptLine[] = Array.from(
      { length: QUESTION_ANSWER_LOOKBACK_TURNS },
      (_, i) => taskNotificationLine(10 * (i + 1))
    );
    const lines: TranscriptLine[] = [
      userPromptLine(0, QUESTION_ANSWER_PHRASE),
      assistantTextLine(1, "ok"),
      ...openers,
      assistantToolUseLine(200),
      assistantTextLine(210, pointerFreeOverBudgetReport()),
      userPromptLine(300, "next prompt"),
    ];
    expect(resolveQuestionAnswerCheck(lines).matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNonPrincipalTurnOpener / findRecentPrincipalPromptIndex — mt#3972
// ---------------------------------------------------------------------------

describe("isNonPrincipalTurnOpener", () => {
  test("matches a task-notification block", () => {
    expect(isNonPrincipalTurnOpener(TASK_NOTIFICATION_TEXT)).toBe(true);
  });

  test("matches a system-reminder block", () => {
    expect(isNonPrincipalTurnOpener(SYSTEM_REMINDER_TEXT)).toBe(true);
  });

  test("matches the [SYSTEM NOTIFICATION preamble form", () => {
    expect(
      isNonPrincipalTurnOpener(
        "[SYSTEM NOTIFICATION - NOT USER INPUT]\nAn automated event, not from the user."
      )
    ).toBe(true);
  });

  test("does not match an ordinary operator prompt", () => {
    expect(isNonPrincipalTurnOpener(QUESTION_ANSWER_PHRASE)).toBe(false);
    expect(isNonPrincipalTurnOpener(OPENING_PROMPT_TEXT)).toBe(false);
  });

  test("tolerates leading/trailing whitespace", () => {
    expect(isNonPrincipalTurnOpener(`  \n${TASK_NOTIFICATION_TEXT}\n  `)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mt#4109 — the prefix list reaches BOTH gates
//
// Two defects, measured together. (1) `NON_PRINCIPAL_OPENER_PREFIXES` held 3
// of the 11 tags in `packages/shared/src/harness-markup.ts`. (2) The DEPTH gate
// never consulted the list at all — `recentUserPromptTexts` took the last 3
// REAL prompts unfiltered — so fixing (1) alone would have moved it by zero.
// ---------------------------------------------------------------------------

/** Build a run of `n` harness turns (alternating command echo / stdout echo). */
function harnessRun(startOffset: number, n: number): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      userPromptLine(
        startOffset + i * 2,
        i % 2 === 0 ? COMMAND_NAME_TEXT : LOCAL_COMMAND_STDOUT_TEXT
      )
    );
    out.push(assistantTextLine(startOffset + i * 2 + 1, "ok"));
  }
  return out;
}

describe("mt#4109 — NON_PRINCIPAL_OPENER_PREFIXES reconciled with the shared inventory", () => {
  test("matches every harness-markup opener the inventory names (AT4)", () => {
    // The three that were already covered.
    expect(isNonPrincipalTurnOpener(TASK_NOTIFICATION_TEXT)).toBe(true);
    expect(isNonPrincipalTurnOpener(SYSTEM_REMINDER_TEXT)).toBe(true);
    expect(isNonPrincipalTurnOpener("[SYSTEM NOTIFICATION] background task done")).toBe(true);
    // The nine added by mt#4109, verbatim-sampled where the corpus had them.
    expect(isNonPrincipalTurnOpener(COMMAND_NAME_TEXT)).toBe(true);
    expect(isNonPrincipalTurnOpener("<command-message>model</command-message>")).toBe(true);
    expect(isNonPrincipalTurnOpener("<command-args>--json</command-args>")).toBe(true);
    expect(isNonPrincipalTurnOpener("<skill-format>md</skill-format>")).toBe(true);
    expect(isNonPrincipalTurnOpener(LOCAL_COMMAND_STDOUT_TEXT)).toBe(true);
    expect(
      isNonPrincipalTurnOpener("<local-command-caveat>DO NOT respond</local-command-caveat>")
    ).toBe(true);
    expect(isNonPrincipalTurnOpener("<bash-input>ls -la</bash-input>")).toBe(true);
    expect(isNonPrincipalTurnOpener(BASH_STDOUT_TEXT)).toBe(true);
    expect(isNonPrincipalTurnOpener("<bash-stderr>command not found</bash-stderr>")).toBe(true);
  });

  test("does NOT match `local-command-stderr` — the inventory says it does not exist (AT4)", () => {
    // Pinned so a future symmetry-driven addition fails HERE, naming the
    // reason, rather than shipping a prefix matching nothing in the corpus.
    expect(isNonPrincipalTurnOpener(`${NONEXISTENT_STDERR_TAG}>boom</local-command-stderr>`)).toBe(
      false
    );
  });

  test("still does not match an ordinary operator prompt", () => {
    expect(isNonPrincipalTurnOpener(QUESTION_ANSWER_PHRASE)).toBe(false);
    expect(isNonPrincipalTurnOpener(DEPTH_REQUEST_PHRASE)).toBe(false);
    expect(isNonPrincipalTurnOpener(MULTI_PART_QUESTION)).toBe(false);
  });

  // mem#1002 — widening a matcher on a multi-gate detector can silently
  // re-route an existing fixture to a DIFFERENT gate. These pin the new
  // fixtures as inert to BOTH suppression gates, so if a later widening makes
  // one of them match, it fails here rather than quietly satisfying some other
  // test's assertion through the wrong path.
  test("the harness fixtures themselves trip neither suppression gate", () => {
    for (const text of [COMMAND_NAME_TEXT, LOCAL_COMMAND_STDOUT_TEXT, BASH_STDOUT_TEXT]) {
      expect(detectDepthRequest([text]).matched).toBe(false);
      expect(detectSubstantiveQuestion(text).matched).toBe(false);
    }
  });
});

describe("mt#4109 — the depth gate skips harness openers", () => {
  test("a RUN of harness turns no longer starves the depth window (AT1)", () => {
    // The corpus shape: a `/model` invocation and its echo are two consecutive
    // turns, so three unfiltered slots fill with markup and the principal's
    // actual request falls out of the window.
    //
    // NEGATIVE CONTROL, measured 2026-08-25 against the pre-fix tree: this
    // transcript returned `matched: false`. The spec's original AT1 used a
    // SINGLE harness turn and returned `matched: true` before any fix — it was
    // not a negative control at all, which is why it was replaced.
    const lines: TranscriptLine[] = [
      userPromptLine(0, MT4031_MEASURED_PROMPT_ONE),
      assistantTextLine(1, "Short answer first."),
      ...harnessRun(2, 3),
      assistantTextLine(20, "a long report"),
      userPromptLine(21, "ok"),
    ];
    const check = resolveDepthCheck(lines);
    expect(check.matched).toBe(true);
    expect(check.matchedPattern).toBe(MT4031_PATTERN_NAME);
  });

  test("reaches the principal prompt past each individual missing tag", () => {
    for (const opener of [COMMAND_NAME_TEXT, LOCAL_COMMAND_STDOUT_TEXT, BASH_STDOUT_TEXT]) {
      const lines: TranscriptLine[] = [
        userPromptLine(0, DEPTH_REQUEST_PHRASE_BARE),
        assistantTextLine(1, "ok"),
        userPromptLine(2, opener),
        assistantTextLine(3, "a long report"),
        userPromptLine(4, "ok"),
      ];
      expect(resolveDepthCheck(lines).matched).toBe(true);
    }
  });

  test("gives up past DEPTH_REQUEST_SCAN_LIMIT real slots rather than walking the session", () => {
    // The scan budget is a pathology guard: a harness storm longer than the
    // limit leaves the window empty, and an empty window suppresses nothing.
    const lines: TranscriptLine[] = [
      userPromptLine(0, DEPTH_REQUEST_PHRASE_BARE),
      assistantTextLine(1, "ok"),
      ...harnessRun(2, DEPTH_REQUEST_SCAN_LIMIT + 2),
      assistantTextLine(200, "a long report"),
      userPromptLine(201, "ok"),
    ];
    expect(resolveDepthCheck(lines).matched).toBe(false);
  });

  test("does not over-suppress: a real prompt requesting no depth stays unsuppressed (AT3)", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, OPENING_PROMPT_TEXT),
      assistantTextLine(1, "ok"),
      userPromptLine(2, LOCAL_COMMAND_STDOUT_TEXT),
      assistantTextLine(3, "a long report"),
      userPromptLine(4, "ok"),
    ];
    expect(resolveDepthCheck(lines).matched).toBe(false);
    expect(resolveQuestionAnswerCheck(lines).matched).toBe(false);
  });

  test("recentUserPromptTexts returns principal prompts only, oldest-first", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, "prompt A"),
      assistantTextLine(1, "ok"),
      userPromptLine(2, COMMAND_NAME_TEXT),
      assistantTextLine(3, "ok"),
      userPromptLine(4, "prompt B"),
      assistantTextLine(5, "ok"),
      userPromptLine(6, LOCAL_COMMAND_STDOUT_TEXT),
    ];
    expect(recentUserPromptTexts(lines, 6, DEPTH_REQUEST_LOOKBACK_TURNS)).toEqual([
      "prompt A",
      "prompt B",
    ]);
  });
});

describe("mt#4109 — the question-answer gate reaches past the newly-covered tags (AT2)", () => {
  test("anchors on the principal question behind each missing tag", () => {
    for (const opener of [COMMAND_NAME_TEXT, LOCAL_COMMAND_STDOUT_TEXT, BASH_STDOUT_TEXT]) {
      const lines: TranscriptLine[] = [
        userPromptLine(0, MULTI_PART_QUESTION),
        assistantTextLine(1, "ok"),
        userPromptLine(2, opener),
        assistantTextLine(3, "a long report"),
        userPromptLine(4, "ok"),
      ];
      const idx = findRecentPrincipalPromptIndex(lines, 2);
      expect(idx).toBe(0);
      expect(resolveQuestionAnswerCheck(lines).matched).toBe(true);
    }
  });

  // PR #3329 R1 — the reviewer caught that the depth gate got a scan budget
  // while this one kept the conflated bound. At 5, a run of 5+ harness turns
  // left the anchor with nothing but markup in reach and it failed closed;
  // measured, that was 395 of 2,926 turns.
  test("a harness RUN longer than the old bound of 5 no longer starves the anchor", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, MULTI_PART_QUESTION),
      assistantTextLine(1, "ok"),
      ...harnessRun(2, 6),
      assistantTextLine(40, "a long report"),
      userPromptLine(41, "ok"),
    ];
    // Six harness turns sit between the question and the report — one more
    // than the old budget, so this resolved to `undefined` before R1.
    expect(findRecentPrincipalPromptIndex(lines, 12)).toBe(0);
    expect(resolveQuestionAnswerCheck(lines).matched).toBe(true);
  });

  test("still fails CLOSED when the run exceeds even the raised budget", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, MULTI_PART_QUESTION),
      assistantTextLine(1, "ok"),
      ...harnessRun(2, QUESTION_ANSWER_LOOKBACK_TURNS + 2),
      assistantTextLine(100, "a long report"),
      userPromptLine(101, "ok"),
    ];
    expect(resolveQuestionAnswerCheck(lines).matched).toBe(false);
  });
});

describe("findRecentPrincipalPromptIndex", () => {
  test("returns the opening prompt itself when it is already principal-authored", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, QUESTION_ANSWER_PHRASE),
      assistantTextLine(1, "report"),
      userPromptLine(2, "current prompt"),
    ];
    expect(findRecentPrincipalPromptIndex(lines, 0)).toBe(0);
  });

  test("skips a single non-principal opener to find the principal prompt before it", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, QUESTION_ANSWER_PHRASE),
      assistantTextLine(1, "ok"),
      taskNotificationLine(2),
    ];
    expect(findRecentPrincipalPromptIndex(lines, 2)).toBe(0);
  });

  test("returns undefined when every prompt within the window is non-principal", () => {
    const lines: TranscriptLine[] = [
      taskNotificationLine(0),
      systemReminderLine(1),
      taskNotificationLine(2),
    ];
    expect(findRecentPrincipalPromptIndex(lines, 2)).toBeUndefined();
  });

  test("respects an explicit lookback override smaller than QUESTION_ANSWER_LOOKBACK_TURNS", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, QUESTION_ANSWER_PHRASE),
      taskNotificationLine(1),
      taskNotificationLine(2),
    ];
    // With the default lookback (5) the principal prompt at index 0 is
    // reachable; with lookback=2 only the two notifications are in the
    // window, so it is not.
    expect(findRecentPrincipalPromptIndex(lines, 2)).toBe(0);
    expect(findRecentPrincipalPromptIndex(lines, 2, 2)).toBeUndefined();
  });

  test("never reaches past throughIndex, even when later prompts exist", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, QUESTION_ANSWER_PHRASE),
      assistantTextLine(1, "ok"),
      userPromptLine(2, "prompt after throughIndex"),
    ];
    expect(findRecentPrincipalPromptIndex(lines, 0)).toBe(0);
  });
});

describe("run — mt#3718 question-answer override", () => {
  // AT1 — the 2026-08-03T21:48Z FP shape (ask#6891).
  test("(AT1) over-budget report answering a substantive opening question -> suppressed, logged", () => {
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      QUESTION_ANSWER_PHRASE_BUN_BUG,
      pointerFreeOverBudgetReport()
    );
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressedByQuestionAnswer).toBe(true);
    expect(cal.suppressedByDepthRequest).toBe(false);
    expect(cal.suppressionReasons).toEqual([SUPPRESSION_QUESTION_ANSWER]);
  });

  // AT2 — the 2026-08-03T22:38Z FP shape (multi-question Telegram reply).
  test("(AT2) over-budget report answering a multi-question opening prompt -> suppressed, logged", () => {
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      "What happened with the pickup ack? Why didn't I see it? Should the retrospective watcher have caught this?",
      pointerFreeOverBudgetReport()
    );
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressedByQuestionAnswer).toBe(true);
    expect(cal.suppressionReasons).toEqual([SUPPRESSION_QUESTION_ANSWER]);
  });

  test("a brief affirmative opening prompt ('proceed') -> fires as today, not suppressed", () => {
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      "proceed",
      pointerFreeOverBudgetReport()
    );
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeDefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressedByQuestionAnswer).toBe(false);
    expect(cal.suppressionReasons).toEqual([]);
  });

  // SC3 — a label-led report is never excused by a preceding question, even
  // though the trigger is "both" (over-budget AND lead-labels).
  test("a label-led report preceded by a substantive question -> STILL fires (SC3)", () => {
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      QUESTION_ANSWER_PHRASE_BUN_BUG,
      labelHeavyReport()
    );
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeDefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.trigger).toBe("both");
    expect(cal.suppressedByQuestionAnswer).toBe(false);
    expect(cal.suppressionReasons).toEqual([]);
  });

  // SC3, pure lead-labels leg (under budget, label hit only) — extra
  // coverage that the question-answer gate never applies outside the pure
  // over-budget trigger.
  test("a PURE lead-labels report (under budget) preceded by a substantive question -> still fires", () => {
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      QUESTION_ANSWER_PHRASE_BUN_BUG,
      `Gate (l) blocked promotion. ${words(150)}`
    );
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeDefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.trigger).toBe("lead-labels");
    expect(cal.suppressedByQuestionAnswer).toBe(false);
    expect(cal.suppressionReasons).toEqual([]);
  });

  test("both gates can suppress independently: a depth-request opening prompt is unaffected", () => {
    // Regression guard: the question-answer gate is ADDITIVE, not a
    // replacement — a depth-request phrase (no "?") still suppresses via
    // suppressedByDepthRequest, with suppressedByQuestionAnswer false.
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      DEPTH_REQUEST_PHRASE,
      pointerFreeOverBudgetReport()
    );
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressedByDepthRequest).toBe(true);
    expect(cal.suppressedByQuestionAnswer).toBe(false);
    expect(cal.suppressionReasons).toEqual([SUPPRESSION_DEPTH_REQUEST]);
  });
});

describe("run — mt#3972 question-answer lookback widened past non-principal openers", () => {
  // mt#4031 guard. Every test below asserts `suppressionReasons` is exactly
  // the question-answer reason, which only isolates the gate under test while
  // the fixture trips no other. Pinning that here means a later edit that
  // reintroduces a depth-request phrase into the fixture fails HERE, naming
  // the cause, instead of silently making the three tests below pass for the
  // wrong reason.
  test("(mt#4031) the fixture trips the question gate only, never the depth gate", () => {
    expect(detectDepthRequest([MULTI_PART_QUESTION]).matched).toBe(false);
    expect(detectSubstantiveQuestion(MULTI_PART_QUESTION).matched).toBe(true);
  });

  // AT1 — reproduces the live 2026-08-11T17:21:47Z record's shape (session
  // `25a27bdb`): a principal multi-part question, a SINGLE
  // `<task-notification>` turn opener, then the 458-word over-budget report
  // that answers the question. Negative control (run against the pre-mt#3972
  // single-opening-prompt anchor): this exact fixture FIRES —
  // `suppressedByQuestionAnswer: false` and `additionalContext` defined —
  // because the opening prompt IS the task-notification, not the question.
  // See the mt#3972 PR body's execution-evidence block for the recorded
  // negative-control run.
  test("(AT1) 17:21 shape suppresses after the widened lookback", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, MULTI_PART_QUESTION),
      assistantTextLine(5, "ok, digging in"),
      taskNotificationLine(600),
      assistantToolUseLine(601),
      assistantTextLine(700, report458Words()),
      userPromptLine(800, "next prompt"),
    ];
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.wordCount).toBe(458);
    expect(cal.trigger).toBe("over-budget");
    expect(cal.suppressedByQuestionAnswer).toBe(true);
    expect(cal.suppressionReasons).toEqual([SUPPRESSION_QUESTION_ANSWER]);
  });

  // SC2 — the sibling 2026-08-11T19:16:53Z record (475 words, same session)
  // shares the identical general shape: a substantive principal question,
  // then a `<task-notification>` opener, then the over-budget report
  // answering it. (Direct verification against the raw session transcript,
  // done for this task: the LITERAL immediate real prompt before that
  // record's notification opener was a short post-interrupt aside — "i
  // switched to fable btw" — not itself a question; per SC1's FP-risk bound
  // this gate correctly stops there rather than skipping past a genuine
  // principal turn to reach the substantive question two turns earlier. This
  // fixture reproduces the GENERAL shape both records exemplify, per the
  // spec's own framing of AT1 as "the 17:21 shape" rather than a byte-exact
  // replay.)
  test("(SC2) 19:16 shape suppresses after the widened lookback", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, MULTI_PART_QUESTION),
      assistantTextLine(5, "ok, digging in"),
      taskNotificationLine(900),
      assistantToolUseLine(901),
      assistantTextLine(1000, `Status update on the research thread. ${words(469)}`),
      userPromptLine(1100, "next prompt"),
    ];
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeUndefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.wordCount).toBe(475);
    expect(cal.suppressedByQuestionAnswer).toBe(true);
    expect(cal.suppressionReasons).toEqual([SUPPRESSION_QUESTION_ANSWER]);
  });

  // AT2 — the lookback window contains NO principal question (the one real
  // prompt in the window is not a question) -> still fires, exactly as an
  // ordinary unsuppressed report does today. This is the required control:
  // widening the lookback must not turn into "suppress whenever ANY prompt
  // exists nearby," only "suppress when a PRINCIPAL QUESTION is found."
  test("(AT2) no principal question within the lookback window -> still fires", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, OPENING_PROMPT_TEXT), // not a question
      assistantTextLine(5, "ok, digging in"),
      taskNotificationLine(600),
      assistantToolUseLine(601),
      assistantTextLine(700, report458Words()),
      userPromptLine(800, "next prompt"),
    ];
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeDefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.suppressedByQuestionAnswer).toBe(false);
    expect(cal.suppressionReasons).toEqual([]);
  });

  // AT3 — SC3: a label-led report is never excused by a preceding question,
  // even across the widened lookback (trigger exclusion is unchanged).
  test("(AT3) label-led report after a question with a task-notification opener -> still fires", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, MULTI_PART_QUESTION),
      assistantTextLine(5, "ok, digging in"),
      taskNotificationLine(600),
      assistantToolUseLine(601),
      assistantTextLine(700, labelHeavyReport()),
      userPromptLine(800, "next prompt"),
    ];
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeDefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.trigger).toBe("both");
    expect(cal.suppressedByQuestionAnswer).toBe(false);
    expect(cal.suppressionReasons).toEqual([]);
  });
});

describe("recentUserPromptTexts", () => {
  test("bounds the lookback to DEPTH_REQUEST_LOOKBACK_TURNS prompts at or before throughIndex", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, "prompt A"),
      assistantTextLine(1, "ok"),
      userPromptLine(2, "prompt B"),
      assistantTextLine(3, "ok"),
      userPromptLine(4, "prompt C"),
      assistantTextLine(5, "ok"),
      userPromptLine(6, "prompt D"),
    ];
    const texts = recentUserPromptTexts(lines, 6, DEPTH_REQUEST_LOOKBACK_TURNS);
    expect(texts.length).toBe(DEPTH_REQUEST_LOOKBACK_TURNS);
    expect(texts).toEqual(["prompt B", "prompt C", "prompt D"]);
  });

  test("never reaches past throughIndex, even when later prompts exist", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, "prompt A"),
      assistantTextLine(1, "ok"),
      userPromptLine(2, "prompt B (after throughIndex)"),
    ];
    const texts = recentUserPromptTexts(lines, 0, DEPTH_REQUEST_LOOKBACK_TURNS);
    expect(texts).toEqual(["prompt A"]);
  });
});

// ---------------------------------------------------------------------------
// findOpeningPromptIndex / resolveDepthCheck — PR #2228 R1 BLOCKING #2 fix
// ---------------------------------------------------------------------------

describe("findOpeningPromptIndex", () => {
  test("fails CLOSED (undefined) with zero real prompts", () => {
    expect(findOpeningPromptIndex([assistantTextLine(0, "no prompts at all")])).toBeUndefined();
  });

  test("fails CLOSED (undefined) with exactly one real prompt", () => {
    const lines: TranscriptLine[] = [userPromptLine(0, "only one prompt")];
    expect(findOpeningPromptIndex(lines)).toBeUndefined();
  });

  test("returns the second-to-last real prompt index with exactly two prompts", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, "opening prompt"),
      assistantTextLine(1, "report"),
      userPromptLine(2, "current prompt"),
    ];
    expect(findOpeningPromptIndex(lines)).toBe(0);
  });

  test("returns the OPENING prompt of the measured turn, not the first prompt of the session", () => {
    const lines: TranscriptLine[] = [
      userPromptLine(0, "turn one opener"),
      assistantTextLine(1, "ok"),
      userPromptLine(2, "turn two opener"),
      assistantTextLine(3, "report"),
      userPromptLine(4, "current prompt"),
    ];
    // The measured turn is between index 2 (its opener) and index 4 (current) —
    // index 0 belongs to an EARLIER, already-closed turn.
    expect(findOpeningPromptIndex(lines)).toBe(2);
  });
});

describe("resolveDepthCheck", () => {
  test("fail-closed anchor (fewer than 2 real prompts) -> not matched", () => {
    expect(resolveDepthCheck([userPromptLine(0, DEPTH_REQUEST_PHRASE_BARE)]).matched).toBe(false);
  });

  test("delegates to findOpeningPromptIndex + recentUserPromptTexts + detectDepthRequest", () => {
    const lines = transcriptWithFinalReportAndOpeningPrompt(
      "give me the full breakdown",
      pointerFreeOverBudgetReport()
    );
    expect(resolveDepthCheck(lines).matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sessionHasLoggedTextAndSuppression — PR #2228 R1 BLOCKING #1 fix
// ---------------------------------------------------------------------------

describe("sessionHasLoggedTextAndSuppression", () => {
  test("matches when both textHash AND the legacy suppressedByDepthRequest agree", () => {
    const log = `${JSON.stringify({
      session_id: "s",
      textHash: "hash-A",
      suppressedByDepthRequest: true,
    })}\n`;
    // Legacy (pre-mt#3207) shape: no `suppressionReasons` array, so the
    // record's implied reason set is derived from the boolean alone.
    expect(
      sessionHasLoggedTextAndSuppression(log, "s", "hash-A", [SUPPRESSION_DEPTH_REQUEST])
    ).toBe(true);
  });

  test("does NOT match when textHash agrees but the legacy suppressedByDepthRequest differs (the R1 fix)", () => {
    const log = `${JSON.stringify({
      session_id: "s",
      textHash: "hash-A",
      suppressedByDepthRequest: false,
    })}\n`;
    // Same text, but this occurrence's suppression state is non-empty while
    // the logged record's is empty — a genuinely different depth-request
    // context coincidentally producing identical text; must NOT be treated
    // as a stale re-measurement.
    expect(
      sessionHasLoggedTextAndSuppression(log, "s", "hash-A", [SUPPRESSION_DEPTH_REQUEST])
    ).toBe(false);
  });

  test("a pre-mt#3112 record (no suppressedByDepthRequest field) is treated as an empty reason set", () => {
    const log = `${JSON.stringify({ session_id: "s", textHash: "hash-A" })}\n`;
    expect(sessionHasLoggedTextAndSuppression(log, "s", "hash-A", [])).toBe(true);
    expect(
      sessionHasLoggedTextAndSuppression(log, "s", "hash-A", [SUPPRESSION_DEPTH_REQUEST])
    ).toBe(false);
  });

  test("undefined log text / session id -> false", () => {
    expect(sessionHasLoggedTextAndSuppression(undefined, "s", "hash-A", [])).toBe(false);
    expect(sessionHasLoggedTextAndSuppression("{}", undefined, "hash-A", [])).toBe(false);
  });

  // mt#3718 R1 fix (PR #2651 review round 1): the case a collapsed boolean
  // could not distinguish — same "suppressed" verdict, DIFFERENT gate.
  describe("mt#3718 R1 — reason-SET-aware, not just suppressed-or-not", () => {
    test("a differing reason SET is NOT a duplicate, even though both are non-empty", () => {
      const log = `${JSON.stringify({
        session_id: "s",
        textHash: "hash-A",
        suppressionReasons: [SUPPRESSION_DEPTH_REQUEST],
      })}\n`;
      // Both this occurrence and the logged record are "suppressed" (a
      // non-empty reason set) — the pre-R1 collapsed-boolean comparison
      // would have matched these as duplicates. They must NOT match: the
      // gates differ.
      expect(
        sessionHasLoggedTextAndSuppression(log, "s", "hash-A", [SUPPRESSION_QUESTION_ANSWER])
      ).toBe(false);
    });

    test("reason sets compare order-independently", () => {
      const log = `${JSON.stringify({
        session_id: "s",
        textHash: "hash-A",
        suppressionReasons: [SUPPRESSION_DEPTH_REQUEST, SUPPRESSION_QUESTION_ANSWER],
      })}\n`;
      expect(
        sessionHasLoggedTextAndSuppression(log, "s", "hash-A", [
          SUPPRESSION_QUESTION_ANSWER,
          SUPPRESSION_DEPTH_REQUEST,
        ])
      ).toBe(true);
    });

    test("an empty suppressionReasons array (injected) matches an empty query, not a non-empty one", () => {
      const log = `${JSON.stringify({
        session_id: "s",
        textHash: "hash-A",
        suppressionReasons: [],
      })}\n`;
      expect(sessionHasLoggedTextAndSuppression(log, "s", "hash-A", [])).toBe(true);
      expect(
        sessionHasLoggedTextAndSuppression(log, "s", "hash-A", [SUPPRESSION_QUESTION_ANSWER])
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveTurnLines — mt#3028 fix (1): cross-transcript contamination defense
//
// RETIRED by mt#3293, along with the function itself. Its three cases —
// single-candidate pass-through, absent candidates array, and re-parsing the parent
// when a subagent transcript is present — now live in `dispatcher.test.ts`, which is
// where the resolution happens for every guard rather than for this one. The
// end-to-end contamination case below still runs here, against the parent-only lines
// the dispatcher now guarantees.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// hashText / sessionHasLoggedHash — mt#3028 fix (2): dedupe primitives
// ---------------------------------------------------------------------------

describe("hashText", () => {
  test("stable and deterministic for identical input", () => {
    expect(hashText("the same report")).toBe(hashText("the same report"));
  });

  test("differs for different input", () => {
    expect(hashText("report A")).not.toBe(hashText("report B"));
  });
});

describe("sessionHasLoggedHash", () => {
  test("undefined log text -> false", () => {
    expect(sessionHasLoggedHash(undefined, "session-a", "abc123")).toBe(false);
  });

  test("undefined session id -> false", () => {
    const log = `${JSON.stringify({ session_id: "session-a", textHash: "abc123" })}\n`;
    expect(sessionHasLoggedHash(log, undefined, "abc123")).toBe(false);
  });

  test("no record for this session -> false", () => {
    const log = `${JSON.stringify({ session_id: "session-a", textHash: "abc123" })}\n`;
    expect(sessionHasLoggedHash(log, "session-b", "abc123")).toBe(false);
  });

  test("matches the hash regardless of position in the log, ignoring other sessions (PR #2165 R1 BLOCKING #1: A -> B -> A)", () => {
    const lines = [
      { session_id: "session-a", textHash: "hash-A" },
      { session_id: "session-b", textHash: "other-session" },
      { session_id: "session-a", textHash: "hash-B" },
    ];
    const log = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
    // The MOST RECENT record for session-a carries hash-B, not hash-A — a
    // naive "compare against the last record only" check would miss that
    // hash-A already occurred for this session and re-log it. Scanning every
    // record for the session catches the repeat.
    expect(sessionHasLoggedHash(log, "session-a", "hash-A")).toBe(true);
    expect(sessionHasLoggedHash(log, "session-a", "hash-B")).toBe(true);
    expect(sessionHasLoggedHash(log, "session-a", "hash-C")).toBe(false);
  });

  test("tolerates blank lines and malformed JSON lines", () => {
    const log = [
      "",
      "not valid json",
      JSON.stringify({ session_id: "session-a", textHash: "ok" }),
      "",
    ].join("\n");
    expect(sessionHasLoggedHash(log, "session-a", "ok")).toBe(true);
  });

  test("record lacking textHash (pre-mt#3028 record) never matches", () => {
    const log = `${JSON.stringify({ session_id: "session-a" })}\n`;
    expect(sessionHasLoggedHash(log, "session-a", "anything")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run() — mt#3028 regression tests (spec's three Acceptance Tests)
// ---------------------------------------------------------------------------

describe("run — mt#3028 regressions", () => {
  test("(1) five 100-word interstitial status notes + a 150-word final report does NOT fire", () => {
    // A multi-tool turn: five rounds of [~100-word narration + tool_use],
    // ending with a separate, SEPARATE final line: 150 words, text-only,
    // no tool_use — the turn-ending report. Total content across the whole
    // turn is ~650 words (five 100-word notes + one 150-word report) but
    // only the FINAL 150-word block is the measured report.
    const turnLines: TranscriptLine[] = [];
    for (let i = 0; i < 5; i++) {
      turnLines.push(assistantTextLine(i * 2, `status note ${i}: ${words(100)}`));
      turnLines.push(assistantToolUseLine(i * 2 + 1));
    }
    turnLines.push(assistantTextLine(20, `Final report: ${words(149)}`));
    const lines = [
      userPromptLine(0, OPENING_PROMPT_TEXT),
      ...turnLines,
      userPromptLine(60, "next prompt"),
    ];

    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).toBeNull();
  });

  test("(2) the same over-budget report across 3 turns logs at most once (dedupe)", () => {
    const input = makeInput();
    const lines = transcriptWithFinalReport(labelHeavyReport());
    const ctx = makeCtx(lines);

    // Turn 1: no prior record for this session -> logs.
    const outcome1 = run(input, ctx, { readCalibrationLogTextFn: () => undefined });
    expect(outcome1?.calibration).toBeDefined();
    const hash1 = (outcome1?.calibration as Record<string, unknown>).textHash as string;
    expect(typeof hash1).toBe("string");

    // Simulate the framework having appended turn 1's record to the log —
    // turns 2 and 3 read it back and see the SAME hash for this session,
    // because it's genuinely the same unchanged report re-observed.
    const priorLogText = `${JSON.stringify({ session_id: input.session_id, textHash: hash1 })}\n`;
    const deps: RunDeps = { readCalibrationLogTextFn: () => priorLogText };

    const outcome2 = run(input, ctx, deps);
    expect(outcome2).toBeNull();

    const outcome3 = run(input, ctx, deps);
    expect(outcome3).toBeNull();
  });

  test("(3) a genuine 1,500-word final report still fires despite the dedupe check", () => {
    const report = `Status update. ${words(1500)}`;
    const lines = transcriptWithFinalReport(report);
    const outcome = run(makeInput(), makeCtx(lines), noDedupeDeps());
    expect(outcome).not.toBeNull();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.wordCount as number).toBeGreaterThanOrEqual(1500);
    expect(cal.trigger).toBe("over-budget");
  });

  test("a DIFFERENT over-budget report for the same session (changed content) is NOT deduped", () => {
    const input = makeInput();
    const firstReport = labelHeavyReport();
    const secondReport = `Gate (l) verdict and premise audit (iii), revised: ${words(950)}`;

    const outcome1 = run(input, makeCtx(transcriptWithFinalReport(firstReport)), noDedupeDeps());
    const hash1 = (outcome1?.calibration as Record<string, unknown>).textHash as string;
    const priorLogText = `${JSON.stringify({ session_id: input.session_id, textHash: hash1 })}\n`;

    // A genuinely different report for the SAME session must still fire,
    // even though a (stale, different-hash) prior record exists.
    const outcome2 = run(input, makeCtx(transcriptWithFinalReport(secondReport)), {
      readCalibrationLogTextFn: () => priorLogText,
    });
    expect(outcome2?.calibration).toBeDefined();
  });

  test("A -> B -> A sequence: the repeat A is deduped even though B is the most recent record (PR #2165 R1 BLOCKING #1)", () => {
    const input = makeInput();
    const reportA = labelHeavyReport();
    const reportB = `Gate (l) verdict and premise audit (iii), revised: ${words(950)}`;
    // `transcriptWithFinalReport` puts the report text in a single text-only
    // assistant line, so run()'s internal textHash is exactly hashText(reportText).
    const hashA = hashText(reportA);
    const hashB = hashText(reportB);
    const logWithBothPriorTurns = [
      JSON.stringify({ session_id: input.session_id, textHash: hashA }),
      JSON.stringify({ session_id: input.session_id, textHash: hashB }),
    ].join("\n");

    // Turn 3 re-observes report A. The MOST RECENT log record is B's hash,
    // not A's — a "compare only the last record" dedupe would miss this and
    // re-log A. Scanning the session's full (bounded) history catches it.
    const outcome3 = run(input, makeCtx(transcriptWithFinalReport(reportA)), {
      readCalibrationLogTextFn: () => logWithBothPriorTurns,
    });
    expect(outcome3).toBeNull();
  });

  test("does NOT fire on a subagent's label-heavy report, given the dispatcher's parent-only lines", () => {
    // The end-to-end half of the contamination defense. Pre-mt#3293 `ctx.transcriptLines`
    // for a session that dispatched subagents was "parent + subagent" concatenated, and the
    // subagent's own label-heavy final report landed LAST — so a naive scan measured the
    // subagent's report as this session's turn-end report (the misattribution observed in
    // session e1a0c941). The dispatcher now hands over the parent's lines alone, and run()
    // consumes them as-is; the parent's own report is conforming, so nothing fires.
    const parentLines = transcriptWithFinalReport(conformingReport());
    const ctx = makeCtxWithCandidates(parentLines, [
      FAKE_TRANSCRIPT_PATH,
      SUBAGENT_TRANSCRIPT_PATH,
    ]);
    const deps: RunDeps = { readCalibrationLogTextFn: () => undefined };
    expect(run(makeInput(), ctx, deps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// run() — PR #2228 R1 BLOCKING #1: dedupe-vs-suppression interaction
// ---------------------------------------------------------------------------

describe("run — mt#3112 R1 dedupe-vs-suppression interaction", () => {
  test("the same finalText recurring first unsuppressed then suppressed logs BOTH occurrences", () => {
    const input = makeInput();
    const report = pointerFreeOverBudgetReport();

    // Occurrence 1: no depth request in context -> unsuppressed, logs.
    const outcome1 = run(input, makeCtx(transcriptWithFinalReport(report)), noDedupeDeps());
    expect(outcome1?.calibration).toBeDefined();
    const cal1 = outcome1?.calibration as Record<string, unknown>;
    expect(cal1.suppressedByDepthRequest).toBe(false);
    expect(outcome1?.additionalContext).toBeDefined();
    const hash1 = cal1.textHash as string;

    // Simulate occurrence 1 having been appended to the calibration log.
    const priorLogText = `${JSON.stringify({
      session_id: input.session_id,
      textHash: hash1,
      suppressedByDepthRequest: false,
    })}\n`;

    // Occurrence 2: BYTE-IDENTICAL report text, but this time the opening
    // prompt carries a depth request -> suppressed. Under the OLD
    // textHash-only dedupe this would have been silently swallowed
    // (PR #2228 R1 BLOCKING #1); it must log as a distinct record instead.
    const lines2 = transcriptWithFinalReportAndOpeningPrompt(DEPTH_REQUEST_PHRASE, report);
    const outcome2 = run(input, makeCtx(lines2), {
      readCalibrationLogTextFn: () => priorLogText,
    });
    expect(outcome2?.calibration).toBeDefined();
    const cal2 = outcome2?.calibration as Record<string, unknown>;
    expect(cal2.suppressedByDepthRequest).toBe(true);
    expect(cal2.textHash).toBe(hash1); // same text, confirmed via identical hash
    expect(outcome2?.additionalContext).toBeUndefined();
  });

  test("the same finalText + same suppression state IS still deduped (mt#3028 behavior preserved)", () => {
    const input = makeInput();
    const lines = transcriptWithFinalReport(pointerFreeOverBudgetReport());

    const outcome1 = run(input, makeCtx(lines), noDedupeDeps());
    const hash1 = (outcome1?.calibration as Record<string, unknown>).textHash as string;
    const priorLogText = `${JSON.stringify({
      session_id: input.session_id,
      textHash: hash1,
      suppressedByDepthRequest: false,
    })}\n`;

    // Same lines, same suppression state -> genuine re-measurement, deduped.
    const outcome2 = run(input, makeCtx(lines), { readCalibrationLogTextFn: () => priorLogText });
    expect(outcome2).toBeNull();
  });
});

describe("run — mt#3718 R1 dedupe-vs-suppression interaction (reason-set-aware dedupe)", () => {
  test("same text suppressed by DIFFERENT gates across occurrences logs BOTH (reason-set collapse fix)", () => {
    const input = makeInput();
    const report = pointerFreeOverBudgetReport();

    // Occurrence 1: opening prompt is a depth-request phrase -> suppressed by
    // the depth-request gate.
    const lines1 = transcriptWithFinalReportAndOpeningPrompt(DEPTH_REQUEST_PHRASE, report);
    const outcome1 = run(input, makeCtx(lines1), noDedupeDeps());
    expect(outcome1?.calibration).toBeDefined();
    const cal1 = outcome1?.calibration as Record<string, unknown>;
    expect(cal1.suppressedByDepthRequest).toBe(true);
    expect(cal1.suppressedByQuestionAnswer).toBe(false);
    expect(cal1.suppressionReasons).toEqual([SUPPRESSION_DEPTH_REQUEST]);
    const hash1 = cal1.textHash as string;

    // Simulate occurrence 1 having been appended to the calibration log.
    const priorLogText = `${JSON.stringify({
      session_id: input.session_id,
      textHash: hash1,
      suppressedByDepthRequest: true,
      suppressedByQuestionAnswer: false,
      suppressionReasons: [SUPPRESSION_DEPTH_REQUEST],
    })}\n`;

    // Occurrence 2: BYTE-IDENTICAL report text, but this time the opening
    // prompt is a substantive QUESTION rather than a depth-request phrase
    // -> suppressed by the OTHER gate. Before the R1 fix, the dedupe check
    // compared only the combined `suppressed` boolean (true in both cases),
    // so this record was wrongly treated as an unchanged duplicate and
    // dropped -- losing the fact that a DIFFERENT gate suppressed it.
    const lines2 = transcriptWithFinalReportAndOpeningPrompt(
      QUESTION_ANSWER_PHRASE_BUN_BUG,
      report
    );
    const outcome2 = run(input, makeCtx(lines2), {
      readCalibrationLogTextFn: () => priorLogText,
    });
    expect(outcome2?.calibration).toBeDefined();
    const cal2 = outcome2?.calibration as Record<string, unknown>;
    expect(cal2.suppressedByDepthRequest).toBe(false);
    expect(cal2.suppressedByQuestionAnswer).toBe(true);
    expect(cal2.suppressionReasons).toEqual([SUPPRESSION_QUESTION_ANSWER]);
    expect(cal2.textHash).toBe(hash1); // same text, confirmed via identical hash
    expect(outcome2?.additionalContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readCalibrationLogText — mt#3028 / PR #2165 R1 BLOCKING #2: bounded tail read
// ---------------------------------------------------------------------------

/* eslint-disable custom/no-real-fs-in-tests -- this block specifically
   verifies readCalibrationLogText's bounded-tail-read behavior against a
   real file (the whole point is proving the byte-offset seek actually
   bounds disk I/O regardless of file size); every OTHER test in this file
   uses in-memory fixtures / injected fakes. A throwaway mkdtempSync
   directory (removed in afterEach) keeps this isolated from any real
   .minsky/wall-of-text-calibration.jsonl. */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("readCalibrationLogText", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wall-of-text-detector-test-"));
    mkdirSync(join(tmpDir, ".minsky"), { recursive: true });
    logPath = join(tmpDir, ".minsky", "wall-of-text-calibration.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("missing log file -> undefined", () => {
    expect(readCalibrationLogText(tmpDir)).toBeUndefined();
  });

  test("file at or under the byte cap is returned in full", () => {
    const content = `${JSON.stringify({ session_id: "s", textHash: "abc" })}\n`;
    writeFileSync(logPath, content);
    expect(readCalibrationLogText(tmpDir)).toBe(content);
  });

  test("file over the byte cap returns only a bounded tail, excluding early content (BLOCKING #2)", () => {
    const startRecord = `${JSON.stringify({ session_id: "session-at-start", textHash: "start-hash" })}\n`;
    const filler = `${JSON.stringify({ session_id: "filler", textHash: "f" })}\n`;
    const fillerCount = Math.ceil((MAX_DEDUPE_READ_BYTES * 3) / filler.length);
    const endRecord = `${JSON.stringify({ session_id: "session-at-end", textHash: "end-hash" })}\n`;
    writeFileSync(logPath, startRecord + filler.repeat(fillerCount) + endRecord);

    const result = readCalibrationLogText(tmpDir);
    expect(result).toBeDefined();
    expect((result as string).length).toBeLessThanOrEqual(MAX_DEDUPE_READ_BYTES);
    // The tail record (at end-of-file) is inside the bounded read...
    expect(sessionHasLoggedHash(result, "session-at-end", "end-hash")).toBe(true);
    // ...but the start-of-file record fell outside it and is invisible —
    // proving the read is genuinely BOUNDED, not a full-file read that
    // happens to still find everything.
    expect(sessionHasLoggedHash(result, "session-at-start", "start-hash")).toBe(false);
  });
});
/* eslint-enable custom/no-real-fs-in-tests */

// ---------------------------------------------------------------------------
// Compiled-copy parity — PR #2165 R1 non-blocking (compile-drift risk)
// ---------------------------------------------------------------------------

/* eslint-disable custom/no-real-fs-in-tests -- reads two committed repo
   files (this source + its compiled .claude/hooks/ counterpart) to assert
   they stay in sync; not a mock/fixture concern. */
import { readFileSync as readFileSyncForParityCheck } from "node:fs";
import { resolve as resolvePathForParityCheck } from "node:path";

describe("compiled .claude/hooks/ copy stays in sync with this source file", () => {
  test("identical modulo the generated-file banner", () => {
    const sourcePath = resolvePathForParityCheck(import.meta.dir, "wall-of-text-detector.ts");
    const compiledPath = resolvePathForParityCheck(
      import.meta.dir,
      "..",
      "..",
      ".claude",
      "hooks",
      "wall-of-text-detector.ts"
    );
    const source = readFileSyncForParityCheck(sourcePath, "utf-8");
    const compiled = readFileSyncForParityCheck(compiledPath, "utf-8");
    // The compile step (mt#2304) inserts a fixed generation banner right
    // after the shebang line and otherwise copies the source verbatim.
    const bannerStripped = compiled.replace(
      /^#!\/usr\/bin\/env bun\n\/\/ Generated by minsky compile\. Do not edit directly\.\n\/\/ Source: \.minsky\/hooks\/wall-of-text-detector\.ts\n\n/,
      "#!/usr/bin/env bun\n"
    );
    expect(bannerStripped).toBe(source);
  });
});
/* eslint-enable custom/no-real-fs-in-tests */

// ---------------------------------------------------------------------------
// Preceding-prompt capture (mt#4048) — AT1..AT4
//
// The override RESOLVES the principal prompt to decide suppression and used to
// discard it, so a reviewer could see that it declined to fire but not what it
// was looking at. mt#4031's two candidate causes are indistinguishable without
// this.
// ---------------------------------------------------------------------------

describe("preceding-prompt capture (mt#4048)", () => {
  /**
   * Over-budget with NO lead labels, so `trigger` is exactly `over-budget`
   * — the only leg the question-answer override guards, and therefore the
   * only one where a prompt is resolved at all.
   */
  const STATUS_KEY = "precedingPromptStatus";

  function plainOverBudgetReport(): string {
    return words(900);
  }

  function recordFor(openingPrompt: string, report: string): Record<string, unknown> {
    const outcome = run(
      makeInput(),
      makeCtx(transcriptWithFinalReportAndOpeningPrompt(openingPrompt, report)),
      noDedupeDeps()
    );
    return outcome?.calibration as Record<string, unknown>;
  }

  test("AT1: a substantive question is captured on the record", () => {
    const cal = recordFor("Why did the dedup miss on the second scan?", plainOverBudgetReport());
    expect(cal[STATUS_KEY]).toBe("captured");
    const captured = cal["precedingPrompt"] as { excerpt: string; truncated: boolean };
    // The observable that matters: the recorded prompt IS the opening prompt.
    expect(captured.excerpt).toContain("Why did the dedup miss");
    expect(captured.truncated).toBe(false);
    // Consistency: the override fired, and the recorded prompt is the one it
    // fired on.
    expect(cal["suppressedByQuestionAnswer"]).toBe(true);
  });

  test("AT2: a NON-question prompt is still captured — the not-fired case is what needs inspecting", () => {
    const cal = recordFor("go ahead and ship it", plainOverBudgetReport());
    expect(cal[STATUS_KEY]).toBe("captured");
    const captured = cal["precedingPrompt"] as { excerpt: string };
    expect(captured.excerpt).toContain("go ahead and ship it");
    expect(cal["suppressedByQuestionAnswer"]).toBe(false);
  });

  test("PR #2928 R1: the shared judged-input marker is NOT stamped for this capture", () => {
    // `hasJudgedInputCapture` means "this writer captured its JUDGED input".
    // The preceding prompt is a different message, so stamping the marker for it
    // would make that predicate answer differently across records whose
    // judged-text capture is identical.
    const cal = recordFor("Why did the dedup miss?", plainOverBudgetReport());
    expect(cal["precedingPrompt"]).toBeDefined();
    expect(cal["captureSchema"]).toBeUndefined();
  });

  test("AT3: an unresolved prompt is distinguishable from an empty one", () => {
    // No principal prompt at all: the status says so rather than recording an
    // empty string that would read as "the prompt was empty".
    const outcome = run(
      makeInput(),
      makeCtx([assistantTextLine(60, plainOverBudgetReport())]),
      noDedupeDeps()
    );
    const cal = outcome?.calibration as Record<string, unknown> | undefined;
    if (cal !== undefined) {
      expect(cal[STATUS_KEY]).not.toBe("captured");
      expect(cal["precedingPrompt"]).toBeUndefined();
    } else {
      // No measurement at all for this shape is also acceptable; the point is
      // that no record ever claims a captured prompt it did not resolve.
      expect(outcome).toBeNull();
    }
  });

  test("the capture is the ELIDED copy — a fenced paste never reaches the log", () => {
    const secretish = "sk-live-DO-NOT-LOG-abcdefghijklmnop";
    const cal = recordFor(
      `Why is this failing?\n\n\`\`\`\n${secretish}\n\`\`\`\n`,
      plainOverBudgetReport()
    );
    const captured = cal["precedingPrompt"] as { excerpt: string };
    expect(captured.excerpt).not.toContain(secretish);
    expect(captured.excerpt).toContain("Why is this failing");
  });

  test("AT4: capture is bounded by the shared documented cap", () => {
    const cal = recordFor(`Why ${"padding ".repeat(4000)}?`, plainOverBudgetReport());
    const captured = cal["precedingPrompt"] as {
      excerpt: string;
      truncated: boolean;
      length: number;
    };
    expect(captured.truncated).toBe(true);
    expect(captured.excerpt.length).toBeLessThanOrEqual(ARTIFACT_CAPTURE_MAX_CHARS + 1);
    expect(captured.length).toBeGreaterThan(ARTIFACT_CAPTURE_MAX_CHARS);
  });
});
