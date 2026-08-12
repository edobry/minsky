#!/usr/bin/env bun
/**
 * Unit tests for silent-stretch-detector.ts
 *
 * Covers (mt#2824 acceptance tests, re-verified post mt#3027):
 * - Synthetic 20-tool-call silent transcript -> fires (matched, calibration record)
 * - Synthetic 5-call short chain -> does NOT fire
 * - Text output mid-stretch resets the tool-call counter
 * - Wall-clock gap threshold (10 min) fires only when the run is ALSO a work
 *   chain (>= MIN_CHAIN_TOOL_CALLS, mt#3196), measured WITHIN the turn
 *   (mt#3027). Before mt#3196 this leg fired independently of tool-call count.
 * - Override env var suppresses detection and returns an audit line
 * - No transcript_path / empty transcript -> null (silent allow)
 *
 * Covers (mt#3027 acceptance tests — 13/13 FP calibration round, ask 8bf53c54):
 * - A turn that ends in narration with zero trailing tool calls never fires,
 *   no matter how long the operator takes to send the NEXT prompt (the
 *   `hadTextInTurn: true` + `toolCallCount: 0` shape is structurally
 *   impossible to match, not just filtered)
 * - The same holds when a FEW trailing tool calls follow the narration
 *   (toolCallCount > 0 but the run's own span is short)
 * - A turn with only a short tool-only run (no text) does not fire even when
 *   the NEXT prompt arrives days later — inter-turn/user idle is excluded
 *   from the measured span entirely
 * - A genuine 16-consecutive-tool-call, no-text stretch still fires
 * - An early genuine stretch is detected even when a short run follows it
 *   (matched reflects ANY run in the turn, not just the trailing one)
 *
 * Covers (mt#3003 acceptance tests — shared stale-turn re-measurement fix):
 * - `buildTurnAnchor` keys on the turn's boundary-prompt timestamp pair
 * - `run()` re-parses the PARENT transcript alone when >1 candidate is
 *   present, ignoring a contaminated multi-candidate `ctx.transcriptLines`
 *   (the confirmed subagent-transcript-contamination root cause)
 * - `run()` skips re-logging a turn whose anchor was already logged for
 *   this session (dedupe fixture reproducing the 2c9ac5e6/762cde32
 *   five-repeat calibration shape: the SAME turn measured across several
 *   successive firings logs only once)
 * - AT2: a turn ending in final narration text does not fire, regardless of
 *   how long the operator idles before the next prompt
 * - AT3: a 40-minute gap between the last text and the last tool_use, with
 *   the next prompt arriving 5 minutes later, fires with gap ~40 (not ~45)
 *
 * @see mt#2824
 * @see mt#3027
 * @see mt#3003
 */

import { describe, test, expect } from "bun:test";
import {
  measureSilentStretch,
  MIN_CHAIN_TOOL_CALLS,
  isToolOnlyWorkChain,
  findTurnBoundaryTimestamps,
  buildTurnAnchor,
  computeStalenessMinutes,
  GAP_MINUTES_THRESHOLD,
  TOOL_CALL_THRESHOLD,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  run,
  type RunDeps,
} from "./silent-stretch-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_TS = Date.parse("2026-07-15T10:00:00.000Z");

/** Build an ISO timestamp `offsetSeconds` after BASE_TS. */
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

function toolResultLine(offsetSeconds: number): TranscriptLine {
  // Claude Code records tool_result as a USER-ROLE content array (no text
  // block) — this is exactly the shape isRealUserPrompt must reject and
  // that measureSilentStretch must not mistake for narration.
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
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

/** A single tool_use + its tool_result, `count` times, starting at `startOffset` seconds, `spacingSeconds` apart. */
function toolCallChain(startOffset: number, count: number, spacingSeconds = 5): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (let i = 0; i < count; i++) {
    const base = startOffset + i * spacingSeconds;
    lines.push(assistantToolUseLine(base, `Tool${i}`));
    lines.push(toolResultLine(base + 1));
  }
  return lines;
}

/**
 * Spacing that spreads a 16-20-call chain across >= 8 minutes, satisfying the
 * mt#3336 gap-qualified call leg (CALL_LEG_MIN_GAP_MINUTES) — a genuine
 * stretch, vs the default 5s spacing which builds the sub-5-minute BURST
 * shape the mt#3336 tune stops matching.
 */
const STRETCH_SPACING = 30;

const DAY_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// measureSilentStretch — pure function
// ---------------------------------------------------------------------------

describe("isToolOnlyWorkChain (mt#3196)", () => {
  test("separates the observed false-positive call counts from the true-positive one", () => {
    // Every FP in the 2026-07-24 calibration review sat at 2-7 calls.
    for (const count of [0, 1, 2, 3, 6, 7]) {
      expect(isToolOnlyWorkChain(count)).toBe(false);
    }
    // The floor itself, and the one observed true positive (44).
    for (const count of [MIN_CHAIN_TOOL_CALLS, 20, 44]) {
      expect(isToolOnlyWorkChain(count)).toBe(true);
    }
  });

  test("the floor sits below the tool-call trigger, so the two legs stay distinct", () => {
    // If the floor were >= TOOL_CALL_THRESHOLD the wall-clock leg could never
    // fire on its own — it would be fully shadowed by the call-count leg.
    expect(MIN_CHAIN_TOOL_CALLS).toBeLessThan(TOOL_CALL_THRESHOLD);
  });
});

describe("measureSilentStretch", () => {
  test("20 tool calls spanning a real gap -> matched (gap-qualified call leg, mt#3336)", () => {
    const turnLines = toolCallChain(0, 20, STRETCH_SPACING);
    const measurement = measureSilentStretch(turnLines, ts(0));
    expect(measurement.toolCallCount).toBe(20);
    expect(measurement.hadTextInTurn).toBe(false);
    expect(measurement.matched).toBe(true);
    expect(measurement.toolCallCount).toBeGreaterThanOrEqual(TOOL_CALL_THRESHOLD);
  });

  // mt#3336 regression (ask#6448): the burst shape that drove 9 of the last
  // 14 logged fires — 15-25 calls with gaps of 1.4-5.2 minutes, e.g. the
  // 2026-07-29T09:35:17Z record (15 calls / 1.77 min). Rapid rule-conformant
  // work is not perceived silence; the bare call-count leg no longer exists.
  test("mt#3336: 20 calls in under 2 minutes (burst) -> NOT matched", () => {
    const turnLines = toolCallChain(0, 20);
    const measurement = measureSilentStretch(turnLines, ts(0));
    expect(measurement.toolCallCount).toBe(20);
    expect(measurement.matched).toBe(false);
  });

  // mt#3336: the hard ceiling — the 2026-07-28T16:43:58Z record's shape
  // (34 calls / 3.33 min) stays a match regardless of gap.
  test("mt#3336: 34-call burst crosses the hard ceiling regardless of gap", () => {
    const turnLines = toolCallChain(0, 34);
    const measurement = measureSilentStretch(turnLines, ts(0));
    expect(measurement.toolCallCount).toBe(34);
    expect(measurement.matched).toBe(true);
  });

  test("5 consecutive tool calls, no text, short wall-clock gap -> NOT matched", () => {
    const turnLines = toolCallChain(0, 5);
    const measurement = measureSilentStretch(turnLines, ts(0));
    expect(measurement.toolCallCount).toBe(5);
    expect(measurement.matched).toBe(false);
  });

  test("text output mid-stretch resets the tool-call counter", () => {
    // 10 tool calls, then a narrated text line, then 5 more tool calls.
    // Total tool calls = 15, but the counter resets at the text line, so
    // only the trailing 5 count toward the threshold — must NOT match on
    // tool-call count alone.
    const before = toolCallChain(0, 10);
    const textOffset = 10 * 5 + 2;
    const narration = assistantTextLine(textOffset, "Checked the config; now running tests.");
    const after = toolCallChain(textOffset + 5, 5);
    const turnLines = [...before, narration, ...after];

    const measurement = measureSilentStretch(turnLines, ts(0));

    expect(measurement.hadTextInTurn).toBe(true);
    // Counter only reflects tool calls AFTER the reset point.
    expect(measurement.toolCallCount).toBe(5);
    expect(measurement.matched).toBe(false);
  });

  // EXPECTATION CHANGED by mt#3196. This test previously asserted the
  // wall-clock leg "fires independently of tool-call count" and expected
  // `matched: true` for this exact 3-call/11.67-min fixture. That behavior is
  // deliberately reversed: the cadence rule scopes itself to "research/build
  // chains where SEVERAL tool calls run back-to-back", and 3 calls is not a
  // chain. Calibration review 2026-07-24 found this shape was 5 of 15 fires,
  // all false positives (the extreme: 226 minutes across 2 tool calls — an
  // agent blocked on a backgrounded operation, not one working silently).
  //
  // The mt#3027 property this test was ORIGINALLY written to protect — that
  // the span is measured from the turn's own timestamps, never from a later
  // real user prompt — is still asserted below via `gapMinutes`, which must
  // still reflect the within-turn span even though it no longer matches.
  test("wall-clock gap alone does NOT fire below the work-chain floor (mt#3196)", () => {
    const turnLines = [
      assistantToolUseLine(0, "Tool0"),
      toolResultLine(1),
      assistantToolUseLine(400, "Tool1"),
      toolResultLine(401),
      assistantToolUseLine(700, "Tool2"), // 700s = 11.67 min after Tool0
      toolResultLine(701),
    ];
    const measurement = measureSilentStretch(turnLines, ts(0));

    expect(measurement.toolCallCount).toBe(3);
    // mt#3027 within-turn span measurement is unchanged — still over threshold.
    expect(measurement.gapMinutes).toBeGreaterThanOrEqual(GAP_MINUTES_THRESHOLD);
    // ...but the run is below the work-chain floor, so it is out of scope.
    expect(measurement.toolCallCount).toBeLessThan(MIN_CHAIN_TOOL_CALLS);
    expect(measurement.matched).toBe(false);
  });

  test("wall-clock gap fires once the run is also a work chain (mt#3196)", () => {
    // Same long-gap shape, but with enough calls to be a genuine chain:
    // MIN_CHAIN_TOOL_CALLS calls spread across >10 minutes, still below the
    // 15-call trigger — so ONLY the wall-clock leg can be responsible.
    const turnLines: TranscriptLine[] = [];
    for (let i = 0; i < MIN_CHAIN_TOOL_CALLS; i++) {
      const base = i * 100; // 100s apart -> 700s span at 8 calls
      turnLines.push(assistantToolUseLine(base, `Tool${i}`));
      turnLines.push(toolResultLine(base + 1));
    }
    const measurement = measureSilentStretch(turnLines, ts(0));

    expect(measurement.toolCallCount).toBe(MIN_CHAIN_TOOL_CALLS);
    expect(measurement.toolCallCount).toBeLessThan(TOOL_CALL_THRESHOLD);
    expect(measurement.gapMinutes).toBeGreaterThanOrEqual(GAP_MINUTES_THRESHOLD);
    expect(measurement.matched).toBe(true);
  });

  test("the observed false-positive records no longer fire (mt#3196)", () => {
    // Verbatim shapes from the 2026-07-24 calibration review. Each is a
    // (gapSeconds, toolCallCount) pair taken from a real logged record.
    const observedFalsePositives: Array<[number, number]> = [
      [226.1 * 60, 2],
      [20.86 * 60, 6],
      [12.17 * 60, 2],
      [12.12 * 60, 3],
      [30.64 * 60, 7],
    ];

    for (const [gapSeconds, callCount] of observedFalsePositives) {
      const turnLines: TranscriptLine[] = [];
      const step = gapSeconds / Math.max(callCount - 1, 1);
      for (let i = 0; i < callCount; i++) {
        const base = Math.round(i * step);
        turnLines.push(assistantToolUseLine(base, `Tool${i}`));
        turnLines.push(toolResultLine(base + 1));
      }
      const measurement = measureSilentStretch(turnLines, ts(0));
      expect(measurement.toolCallCount).toBe(callCount);
      expect(measurement.matched).toBe(false);
    }
  });

  test("the observed true positive still fires (mt#3196)", () => {
    // 44 calls across 12.04 minutes — the one unambiguous true positive in
    // the same review. Crosses both legs; must remain a match.
    const turnLines: TranscriptLine[] = [];
    for (let i = 0; i < 44; i++) {
      const base = Math.round(i * ((12.04 * 60) / 43));
      turnLines.push(assistantToolUseLine(base, `Tool${i}`));
      turnLines.push(toolResultLine(base + 1));
    }
    const measurement = measureSilentStretch(turnLines, ts(0));

    expect(measurement.toolCallCount).toBe(44);
    expect(measurement.matched).toBe(true);
  });

  test("missing timestamps degrade to gapMinutes=0 rather than throwing", () => {
    const turnLines = toolCallChain(0, 2);
    const measurement = measureSilentStretch(turnLines, undefined);
    expect(measurement.gapMinutes).toBe(0);
    expect(measurement.toolCallCount).toBe(2);
    expect(measurement.matched).toBe(false);
  });

  test("an early genuine stretch is detected even when a short run follows it", () => {
    // 20 tool calls (crosses the count threshold), then narration, then only
    // 2 more tool calls. `matched` must reflect the EARLY run, not just the
    // final (small) trailing run — and the reported stats must describe
    // WHY it matched (the early run), never the unrelated small trailing run.
    const genuineStretch = toolCallChain(0, 20, STRETCH_SPACING);
    const textOffset = 20 * STRETCH_SPACING + 2;
    const narration = assistantTextLine(textOffset, "Wrapping up with a quick check.");
    const shortFollowUp = toolCallChain(textOffset + 5, 2);
    const turnLines = [...genuineStretch, narration, ...shortFollowUp];

    const measurement = measureSilentStretch(turnLines, ts(0));

    expect(measurement.matched).toBe(true);
    expect(measurement.toolCallCount).toBe(20);
  });

  test("turn ends in narration with no trailing tool calls -> never matches, regardless of earlier activity", () => {
    // Some quick early tool calls (well under either threshold), then
    // narration that closes out the turn with nothing after it. The final
    // run has zero tool calls, so it can never match — reviewed in PR #2166
    // as the unit-level counterpart of the mt#3027 FP-shape tests below,
    // which only exercised this through the full run() dispatcher path.
    const turnLines = [
      ...toolCallChain(0, 3),
      assistantTextLine(20, "Done — summary of findings."),
    ];
    const measurement = measureSilentStretch(turnLines, ts(-5));

    expect(measurement.hadTextInTurn).toBe(true);
    expect(measurement.toolCallCount).toBe(0);
    expect(measurement.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findTurnBoundaryTimestamps
// ---------------------------------------------------------------------------

describe("findTurnBoundaryTimestamps", () => {
  // mt#3280: the second boundary is the measured turn's OWN last line, not a
  // later real prompt. Updating the previous expectation (which read the
  // trailing prompt's timestamp as "the current prompt") because that prompt
  // is the one that OPENED the measured turn in the shape the harness
  // actually produces at UserPromptSubmit time.
  test("returns the opening prompt's timestamp and the turn's own end", () => {
    const lines = [
      userPromptLine(0, "first message"),
      assistantToolUseLine(1),
      toolResultLine(2),
      userPromptLine(100, "second message (interrupt)"),
    ];
    const { turnStartTimestamp, turnEndTimestamp } = findTurnBoundaryTimestamps(lines);
    expect(turnStartTimestamp).toBe(ts(0));
    expect(turnEndTimestamp).toBe(ts(2));
  });

  test("a trailing turn with no following prompt still resolves both boundaries", () => {
    const lines = [userPromptLine(0), assistantToolUseLine(1), toolResultLine(2)];
    const { turnStartTimestamp, turnEndTimestamp } = findTurnBoundaryTimestamps(lines);
    expect(turnStartTimestamp).toBe(ts(0));
    expect(turnEndTimestamp).toBe(ts(2));
  });

  test("no resolvable turn -> both undefined", () => {
    const result = findTurnBoundaryTimestamps([userPromptLine(0)]);
    expect(result.turnStartTimestamp).toBeUndefined();
    expect(result.turnEndTimestamp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// run() — dispatcher-compatible pure function (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

const HOOK_EVENT_NAME = "UserPromptSubmit";

/** Closing prompt used by the stretch fixtures below. */
const STRETCH_CLOSING_PROMPT = "why has nothing happened?";

/** Closing prompt for the short-chain fixtures that must NOT cross a threshold. */
const NEXT_INSTRUCTION_PROMPT = "next instruction";

const HOOK_INPUT: ClaudeHookInput = {
  session_id: "test-session",
  transcript_path: "/mock/transcript.jsonl",
  cwd: "/test",
  hook_event_name: HOOK_EVENT_NAME,
};

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return {
    event: HOOK_EVENT_NAME,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates: ["/mock/transcript.jsonl"],
    transcriptLines,
  };
}

/** A ctx with >1 resolved transcript candidates — the mt#3003 contamination-risk shape. */
function makeCtxWithCandidates(
  transcriptLines: TranscriptLine[],
  transcriptCandidates: string[]
): DispatchContext {
  return {
    event: HOOK_EVENT_NAME,
    hostCapSec: 15,
    budgets: { overallBudgetMs: 9000, fetchTimeoutMs: 4950, gitTimeoutMs: 1530 },
    transcriptCandidates,
    transcriptLines,
  };
}

/**
 * Deterministic `run()` deps for tests that don't care about dedupe: no
 * filesystem access (`custom/no-real-fs-in-tests`), always reports "no prior
 * record" so the dedupe check never suppresses a test's expected match.
 * Mirrors wall-of-text-detector.test.ts's identical helper (mt#3003).
 */
function noDedupeDeps(): RunDeps {
  return {
    readCalibrationLogTextFn: () => undefined,
    // mt#3583 added two more real-IO seams to run(). Without stubbing them here
    // every test in this file would perform real filesystem reads AND WRITES
    // through the evaluation stream's defaults — passing all the while, since
    // that path is fail-open by design.
    readEvaluationLogTextFn: () => undefined,
    appendEvaluationRecordFn: () => {},
  };
}

/** `noDedupeDeps` plus a capture buffer for the mt#3583 evaluation stream. */
function capturingDeps(): { deps: RunDeps; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  return {
    deps: {
      ...noDedupeDeps(),
      appendEvaluationRecordFn: (_cwd, record) => {
        records.push(record);
      },
    },
    records,
  };
}

describe("run() (dispatcher-compatible)", () => {
  // mt#3399 graduated this detector to injection. The assertions below are the
  // acceptance tests for that flip: a crossing turn must produce BOTH a
  // calibration record (so measurement continues) and an additionalContext
  // reminder naming the observed numbers (so the reminder is actionable).
  test("20-tool-call silent turn -> calibration record AND additionalContext (INJECTION_ENABLED=true)", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20, STRETCH_SPACING),
      userPromptLine(1 + 20 * STRETCH_SPACING + 30, STRETCH_CLOSING_PROMPT),
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.calibration?.toolCallCount).toBe(20);
    expect(outcome?.calibration?.session_id).toBe("test-session");
    expect(INJECTION_ENABLED).toBe(true);
    // The reminder must be non-empty and must carry the OBSERVED numbers, not
    // a generic "you went quiet" — spec success criterion 2.
    expect(outcome?.additionalContext).toBeTruthy();
    expect(outcome?.additionalContext).toContain("20");
    expect(outcome?.additionalContext).toContain("silent-stretch-detector");
  });

  // The "graduation does not nag on every turn" property is already covered by
  // the pre-existing short-chain test immediately below: `run()` returns null
  // for a non-crossing turn, and a null outcome carries neither a calibration
  // record nor an additionalContext. A separate mt#3399 test asserting the same
  // thing over the same fixture was removed as redundant (PR #2457 R1).
  test("5-call short chain -> null (silent allow)", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 5),
      userPromptLine(1 + 5 * 5 + 10, NEXT_INSTRUCTION_PROMPT),
    ];
    expect(run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps())).toBeNull();
  });

  // mt#3583: the evaluation stream. A fire-only corpus can express "it happened
  // again" but never "it stopped happening", and the tuning loop needs both —
  // so run() records what it measured whether or not the guard fired.
  test("a NON-firing turn still records an evaluation carrying its measurement", () => {
    const { deps, records } = capturingDeps();
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 5),
      userPromptLine(1 + 5 * 5 + 10, NEXT_INSTRUCTION_PROMPT),
    ];

    expect(run(HOOK_INPUT, makeCtx(transcriptLines), deps)).toBeNull();
    expect(records).toHaveLength(1);
    expect(records[0]?.fired).toBe(false);
    expect(records[0]?.toolCallCount).toBe(5);
    // Both measured values, not just the one the assertion happened to reach
    // for: a record missing either is useless to the tuner downstream.
    expect(typeof records[0]?.gapMinutes).toBe("number");
    expect(records[0]?.session_id).toBe("test-session");
    expect(records[0]?.turnAnchor).toBeTruthy();
  });

  test("a firing turn records an evaluation marked fired", () => {
    const { deps, records } = capturingDeps();
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20, STRETCH_SPACING),
      userPromptLine(1 + 20 * STRETCH_SPACING + 30, STRETCH_CLOSING_PROMPT),
    ];

    expect(run(HOOK_INPUT, makeCtx(transcriptLines), deps)?.calibration).toBeDefined();
    expect(records).toHaveLength(1);
    expect(records[0]?.fired).toBe(true);
    expect(records[0]?.toolCallCount).toBe(20);
  });

  // Without this dedupe a re-measured unchanged turn appends a second record —
  // and a duplicate of a FIRE reads downstream as the guard firing twice, which
  // labels the original fire `dismissed` when nothing of the sort happened.
  test("a turn already present in the evaluation log is not recorded twice", () => {
    const records: Record<string, unknown>[] = [];
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20, STRETCH_SPACING),
      userPromptLine(1 + 20 * STRETCH_SPACING + 30, STRETCH_CLOSING_PROMPT),
    ];

    // First pass with an empty log to learn the anchor this turn produces.
    const first = capturingDeps();
    run(HOOK_INPUT, makeCtx(transcriptLines), first.deps);
    const anchor = first.records[0]?.turnAnchor;
    expect(anchor).toBeTruthy();

    // Second pass with a log that already contains that anchor for this session.
    const priorLog = `${JSON.stringify({ session_id: "test-session", turnAnchor: anchor })}\n`;
    run(HOOK_INPUT, makeCtx(transcriptLines), {
      ...noDedupeDeps(),
      readEvaluationLogTextFn: () => priorLog,
      appendEvaluationRecordFn: (_cwd, record) => {
        records.push(record);
      },
    });

    expect(records).toEqual([]);
  });

  // PR #2569 R1: sessionHasLoggedKey returns false whenever the session id is
  // falsy — it cannot match a record it cannot key — so emitting here would
  // append on EVERY evaluation with no upper bound.
  test("an evaluation with no session id is skipped rather than written undeduped", () => {
    const { deps, records } = capturingDeps();
    const input: ClaudeHookInput = { ...HOOK_INPUT, session_id: "" };
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20, STRETCH_SPACING),
      userPromptLine(1 + 20 * STRETCH_SPACING + 30, STRETCH_CLOSING_PROMPT),
    ];

    run(input, makeCtx(transcriptLines), deps);
    expect(records).toEqual([]);
  });

  test("no transcript_path -> null", () => {
    const input: ClaudeHookInput = {
      session_id: "test",
      cwd: "/test",
      hook_event_name: HOOK_EVENT_NAME,
    };
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20),
      userPromptLine(1 + 20 * 5 + 30),
    ];
    expect(run(input, makeCtx(transcriptLines), noDedupeDeps())).toBeNull();
  });

  test("empty transcript -> null", () => {
    expect(run(HOOK_INPUT, makeCtx([]), noDedupeDeps())).toBeNull();
  });

  test("override env var suppresses detection and returns an audit line", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20),
      userPromptLine(1 + 20 * 5 + 30),
    ];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());
      expect(outcome?.calibration).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });
});

// ---------------------------------------------------------------------------
// mt#3027 — 13/13 FP calibration round (ask 8bf53c54): the detector must
// measure ONLY within-turn tool-only stretches. Every one of the 13 new
// fires reviewed had `hadTextInTurn: true` and a huge `gapMinutes` that was
// actually inter-turn user idle, not agent silence.
// ---------------------------------------------------------------------------

describe("mt#3027 — within-turn-only measurement (13/13 FP calibration round)", () => {
  test("turn ends in narration, zero trailing tool calls, next prompt arrives 35 days later -> no fire", () => {
    const transcriptLines = [
      userPromptLine(0),
      assistantTextLine(5, "Done — investigated and filed the finding."),
      userPromptLine(5 + 35 * DAY_SECONDS, "ok, picking this back up"),
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());
    expect(outcome).toBeNull();
  });

  test("turn ends in narration plus ONE trailing tool call, next prompt arrives hours later -> no fire", () => {
    // Reproduces the one FP record with toolCallCount=1 (gapMinutes=238.04
    // under the old, buggy currentPromptTimestamp-based measurement).
    const transcriptLines = [
      userPromptLine(0),
      assistantTextLine(5, "Investigated; filing a follow-up task."),
      assistantToolUseLine(6, "TaskCreate"),
      toolResultLine(7),
      userPromptLine(7 + 4 * 60 * 60, "status?"),
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());
    expect(outcome).toBeNull();
  });

  test("short tool-only run (no text), next prompt arrives 40 days later -> no fire (inter-turn idle excluded)", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 3),
      userPromptLine(1 + 3 * 5 + 40 * DAY_SECONDS, "morning!"),
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());
    expect(outcome).toBeNull();
  });

  test("a resumed conversation after N days produces no fire, even for a text-then-idle turn with a large old-style gap", () => {
    // Mirrors the actual calibration record shapes: hadTextInTurn=true,
    // toolCallCount=0, gapMinutes in the hundreds-of-thousands-of-minutes
    // range under the old measurement.
    const transcriptLines = [
      userPromptLine(0),
      assistantTextLine(3, "Summary of findings, nothing further to do this turn."),
      userPromptLine(3 + 50000 * 60, "back again"), // ~34.7 days later
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());
    expect(outcome).toBeNull();
  });

  test("a synthetic genuine stretch (16 consecutive tool calls, no text) still fires", () => {
    // 35s spacing: 15 intervals x 35s = 8.75 min, clearing
    // CALL_LEG_MIN_GAP_MINUTES for a 16-call chain (STRETCH_SPACING's 30s
    // only reaches 7.5 min at this count).
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 16, 35),
      userPromptLine(1 + 16 * 35 + 10, "how's it going?"),
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.calibration?.toolCallCount).toBe(16);
    expect(outcome?.calibration?.hadTextInTurn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mt#2357 regression: a mid-turn skill launch must NOT reset the measured
// silent stretch. Before the isRealUserPrompt skill-body exclusion, the
// skill-body user-role line registered as a real prompt boundary, collapsing
// the measured window to only the post-skill segment — hiding exactly the
// long tool-only stretch this detector exists to catch.
// ---------------------------------------------------------------------------

describe("mt#2357 — skill body does not reset the silence window", () => {
  test("20-call chain with a mid-chain skill launch still measures the full stretch", () => {
    const skillBodyLine: TranscriptLine = {
      type: "user",
      isMeta: true,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "Base directory for this skill: /Users/x/.claude/skills/implement-task\n\n# Implement Task",
          },
        ],
      },
      timestamp: ts(1 + 10 * STRETCH_SPACING),
    };
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 10, STRETCH_SPACING),
      skillBodyLine,
      ...toolCallChain(1 + 10 * STRETCH_SPACING + 5, 10, STRETCH_SPACING),
      userPromptLine(1 + 20 * STRETCH_SPACING + 40, "how is it going?"),
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.calibration?.toolCallCount).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// mt#3003 — buildTurnAnchor: the dedupe key
// ---------------------------------------------------------------------------

describe("buildTurnAnchor", () => {
  test("combines both boundary timestamps", () => {
    const anchor = buildTurnAnchor({
      turnStartTimestamp: ts(0),
      turnEndTimestamp: ts(100),
    });
    expect(anchor).toBe(`${ts(0)}::${ts(100)}`);
  });

  test("missing either boundary -> undefined (never a dedupe candidate)", () => {
    expect(
      buildTurnAnchor({ turnStartTimestamp: undefined, turnEndTimestamp: ts(100) })
    ).toBeUndefined();
    expect(
      buildTurnAnchor({ turnStartTimestamp: ts(0), turnEndTimestamp: undefined })
    ).toBeUndefined();
  });

  test("the SAME turn (identical boundaries) always produces the SAME anchor", () => {
    const boundaries = { turnStartTimestamp: ts(0), turnEndTimestamp: ts(50) };
    // Same-value comparison, but the spread-arg call types as `string |
    // undefined`; prove it present before comparing (mt#2900).
    const fromCopy = buildTurnAnchor({ ...boundaries });
    expect(fromCopy).toBeDefined();
    expect(buildTurnAnchor(boundaries)).toBe(fromCopy as string);
  });
});

// ---------------------------------------------------------------------------
// mt#3003 — cross-transcript contamination: the actual root cause of the
// "stale turn re-measurement" bug. Investigation against the three named
// calibration sessions (3bf59029, 2c9ac5e6 — wall-of-text; 762cde32 —
// silent-stretch) found no missed-prompt-shape bug in findRealPromptIndices
// itself; all three sessions have populated `subagents/` dirs, and
// `ctx.transcriptLines` being a flat parent+subagent concatenation
// (mt#2637) is what actually froze the measured turn. This mirrors
// wall-of-text-detector.test.ts's `resolveTurnLines` contamination test,
// run end-to-end through this file's own `run()`.
// ---------------------------------------------------------------------------

describe("run() — mt#3003 cross-transcript contamination", () => {
  const PARENT_PATH = "/mock/parent.jsonl";
  const SUBAGENT_PATH = "/mock/subagents/agent-fake.jsonl";

  // mt#3293 removed `RunDeps.parseTranscriptFn`: with resolution hoisted to the dispatcher
  // this detector has no transcript-reading seam left, so "never re-reads the transcript" is
  // structural rather than something a poisoned fake has to assert.
  const parentOnlyDeps = (): RunDeps => ({
    ...noDedupeDeps(),
    readCalibrationLogTextFn: () => undefined,
  });

  // mt#3293 moved contamination resolution to the dispatcher: `ctx.transcriptLines` is
  // PARENT-ONLY by construction for every guard, and this detector no longer re-resolves it.
  // The resolution itself is covered in `dispatcher.test.ts` ("parent + subagent candidates ->
  // parses ONLY the parent"). What stays worth pinning HERE is the detector's own half of the
  // contract: it measures exactly the array it is handed, and never re-reads the transcript.
  test("measures the parent's short turn and does not fire, given the dispatcher's parent-only lines", () => {
    // The parent's OWN turn is short (5 calls, well under threshold) — it must NOT fire.
    // Pre-mt#3293 this array would have carried the subagent's 20-call stretch appended
    // after it, and the detector would have fired on THAT, misattributing a subagent's
    // activity to this conversation's turn.
    const parentLines = [
      userPromptLine(0),
      ...toolCallChain(1, 5),
      userPromptLine(1 + 5 * 5 + 10, "status?"),
    ];
    const ctx = makeCtxWithCandidates(parentLines, [PARENT_PATH, SUBAGENT_PATH]);
    const input: ClaudeHookInput = { ...HOOK_INPUT, transcript_path: PARENT_PATH };
    expect(run(input, ctx, parentOnlyDeps())).toBeNull();
  });

  test("a genuine parent-side stretch fires on the dispatcher's parent-only lines", () => {
    const parentLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20, STRETCH_SPACING),
      userPromptLine(1 + 20 * STRETCH_SPACING + 30, "still going?"),
    ];
    const ctx = makeCtxWithCandidates(parentLines, [PARENT_PATH, SUBAGENT_PATH]);
    const input: ClaudeHookInput = { ...HOOK_INPUT, transcript_path: PARENT_PATH };
    const outcome = run(input, ctx, parentOnlyDeps());
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.calibration?.toolCallCount).toBe(20);
  });

  test("single candidate -> also consumed as-is, no transcript re-read (structural)", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20, STRETCH_SPACING),
      userPromptLine(1 + 20 * STRETCH_SPACING + 30),
    ];
    const ctx = makeCtxWithCandidates(transcriptLines, [PARENT_PATH]);
    const outcome = run(HOOK_INPUT, ctx, parentOnlyDeps());
    expect(outcome?.calibration).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// mt#3003 — dedupe: reproduces the 2c9ac5e6/762cde32 "logged N times for the
// identical turn" calibration shape. AC#2: a turn is logged at most once per
// detector across subsequent prompts.
// ---------------------------------------------------------------------------

describe("run() — mt#3003 dedupe (five-repeat calibration shape)", () => {
  test("the SAME turn re-measured across 5 successive firings logs only once", () => {
    // A single frozen anchor pair (mirrors what a stuck findRealPromptIndices
    // anchor would keep re-resolving to across many subsequent prompts, or
    // simply the SAME turn genuinely re-observed because nothing new
    // happened in the parent thread between firings).
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20, STRETCH_SPACING), // genuine 20-tool-call stretch -> crosses the gap-qualified call leg
      userPromptLine(1 + 20 * STRETCH_SPACING + 30, "why so long?"),
    ];
    const ctx = makeCtx(transcriptLines);

    // Firing 1: no prior record for this session -> logs.
    const outcome1 = run(HOOK_INPUT, ctx, { ...noDedupeDeps() });
    expect(outcome1?.calibration).toBeDefined();
    const anchor1 = (outcome1?.calibration as Record<string, unknown>).turnAnchor as string;
    expect(typeof anchor1).toBe("string");

    // Simulate the framework having appended firing 1's record — firings
    // 2-5 read it back and see the SAME anchor for this session, because
    // it's genuinely the same (frozen or re-observed) turn.
    const priorLogText = `${JSON.stringify({ session_id: HOOK_INPUT.session_id, turnAnchor: anchor1 })}\n`;
    const deps: RunDeps = { ...noDedupeDeps(), readCalibrationLogTextFn: () => priorLogText };

    expect(run(HOOK_INPUT, ctx, deps)).toBeNull();
    expect(run(HOOK_INPUT, ctx, deps)).toBeNull();
    expect(run(HOOK_INPUT, ctx, deps)).toBeNull();
    expect(run(HOOK_INPUT, ctx, deps)).toBeNull();
  });

  test("a DIFFERENT turn for the same session (changed anchor) is NOT deduped", () => {
    const firstTurn = [
      userPromptLine(0),
      ...toolCallChain(1, 20, STRETCH_SPACING),
      userPromptLine(1 + 20 * STRETCH_SPACING + 30, "still going?"),
    ];
    const outcome1 = run(HOOK_INPUT, makeCtx(firstTurn), {
      ...noDedupeDeps(),
      readCalibrationLogTextFn: () => undefined,
    });
    const anchor1 = (outcome1?.calibration as Record<string, unknown>).turnAnchor as string;
    const priorLogText = `${JSON.stringify({ session_id: HOOK_INPUT.session_id, turnAnchor: anchor1 })}\n`;

    // A genuinely NEW turn (different boundary timestamps) must still fire,
    // even though a (stale, different-anchor) prior record exists.
    const secondTurnStart = 1 + 20 * STRETCH_SPACING + 30;
    const secondTurn = [
      userPromptLine(secondTurnStart, "still going?"),
      ...toolCallChain(secondTurnStart + 1, 20, STRETCH_SPACING),
      userPromptLine(secondTurnStart + 1 + 20 * STRETCH_SPACING + 30, "and now?"),
    ];
    const outcome2 = run(HOOK_INPUT, makeCtx(secondTurn), {
      ...noDedupeDeps(),
      readCalibrationLogTextFn: () => priorLogText,
    });
    expect(outcome2?.calibration).toBeDefined();
  });

  test("A -> B -> A sequence: the repeat A is deduped even though B is the most recent record", () => {
    const turnA = [
      userPromptLine(0),
      ...toolCallChain(1, 20, STRETCH_SPACING),
      userPromptLine(1 + 20 * STRETCH_SPACING + 30, "A"),
    ];
    const anchorA = buildTurnAnchor(findTurnBoundaryTimestamps(turnA));
    const turnBStart = 1 + 20 * STRETCH_SPACING + 30;
    const turnB = [
      userPromptLine(turnBStart, "A"),
      ...toolCallChain(turnBStart + 1, 20, STRETCH_SPACING),
      userPromptLine(turnBStart + 1 + 20 * STRETCH_SPACING + 30, "B"),
    ];
    const anchorB = buildTurnAnchor(findTurnBoundaryTimestamps(turnB));

    const logWithBothPriorTurns = [
      JSON.stringify({ session_id: HOOK_INPUT.session_id, turnAnchor: anchorA }),
      JSON.stringify({ session_id: HOOK_INPUT.session_id, turnAnchor: anchorB }),
    ].join("\n");

    // Re-observing turn A (the anchor pair is IDENTICAL to firing 1's) with
    // B's record as the most-recent log entry must still dedupe — a
    // "compare only the last record" check would miss this.
    const outcome = run(HOOK_INPUT, makeCtx(turnA), {
      ...noDedupeDeps(),
      readCalibrationLogTextFn: () => logWithBothPriorTurns,
    });
    expect(outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mt#3003 — spec acceptance tests AT2/AT3 (verbatim scenarios)
// ---------------------------------------------------------------------------

describe("mt#3003 acceptance tests", () => {
  test("AT2: turn ends with final narration text, next prompt arrives 3 hours later -> does not fire", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 3),
      assistantTextLine(1 + 3 * 5 + 5, "Investigated and filed the finding — done for now."),
      userPromptLine(1 + 3 * 5 + 5 + 3 * 60 * 60, "ok, picking this back up"),
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());
    expect(outcome).toBeNull();
  });

  // FIXTURE ADJUSTED by mt#3196 — the ASSERTION is unchanged.
  //
  // AT3's acceptance criterion is a MEASUREMENT property: the gap must be
  // measured to the last tool_use (~40 min), never to the next prompt
  // (~45 min, the mt#3003 bug). That property is fully preserved below.
  //
  // What changed is the fixture: AT3 originally used a SINGLE tool call, and
  // mt#3196 excludes single-call runs from the wall-clock leg entirely — a
  // 1-call/40-min run is precisely the false-positive shape mt#3196 exists to
  // stop firing (calibration review 2026-07-24). Asserting the measurement
  // through `run()` therefore now requires a fixture that is in scope, so the
  // fixture carries MIN_CHAIN_TOOL_CALLS calls clustered near the end of the
  // window. The run still spans 40 minutes from the preceding text to the
  // last tool_use, so the ~40-not-~45 assertion tests exactly what it did
  // before.
  test("AT3: 40 min between last text and last tool_use, next prompt 5 min after -> fires with gap ~40 (not ~45)", () => {
    const textOffset = 0;
    const lastToolOffset = textOffset + 40 * 60; // 40 minutes after the text
    const nextPromptOffset = lastToolOffset + 5 * 60; // 5 minutes after the last tool call

    // Calls clustered at the END of the window so the run's span (text ->
    // last tool_use) stays exactly 40 minutes.
    const chain: TranscriptLine[] = [];
    for (let i = 0; i < MIN_CHAIN_TOOL_CALLS; i++) {
      const offset = lastToolOffset - (MIN_CHAIN_TOOL_CALLS - 1 - i) * 10;
      chain.push(assistantToolUseLine(offset, "Read"));
      chain.push(toolResultLine(offset + 1));
    }

    const transcriptLines = [
      userPromptLine(-10),
      assistantTextLine(textOffset, "Starting the check now."),
      ...chain,
      userPromptLine(nextPromptOffset, "any update?"),
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());
    expect(outcome?.calibration).toBeDefined();
    const gap = outcome?.calibration?.gapMinutes as number;
    // ~40 (measured to the last tool_use), never ~45 (which would mean the
    // old bug of measuring to the NEXT prompt instead).
    expect(gap).toBeGreaterThanOrEqual(39);
    expect(gap).toBeLessThan(41);
  });
});

describe("mt#4018 — staleness of the record relative to the turn it measures", () => {
  // AT1. Exactness lives here rather than in a run() test on purpose: run()
  // reads the real clock for `firedAt`, so a run()-level assertion can only
  // bound the value, never pin it. The pure function is where the arithmetic
  // is actually checkable.
  test("AT1: staleness is the minutes from the turn's END to the fire", () => {
    const turnEnd = "2026-08-10T18:29:15.000Z";
    const firedNinetyMinutesLater = "2026-08-10T19:59:15.000Z";
    expect(computeStalenessMinutes(turnEnd, firedNinetyMinutesLater)).toBe(90);
  });

  test("AT1: the ~28h record from the originating window reproduces its delta", () => {
    // Verbatim from .minsky/silent-stretch-calibration.jsonl — the record that
    // opened mt#4018. turnAnchor's end component and the record's timestamp.
    const staleness = computeStalenessMinutes(
      "2026-08-10T18:29:15.049Z",
      "2026-08-11T22:48:50.361Z"
    );
    expect(staleness).toBeGreaterThan(28 * 60);
    expect(staleness).toBeLessThan(29 * 60);
  });

  test("an unknown turn end yields undefined, never a zero that reads as fresh", () => {
    expect(computeStalenessMinutes(undefined, "2026-08-10T18:29:15.000Z")).toBeUndefined();
    expect(computeStalenessMinutes("not-a-timestamp", "2026-08-10T18:29:15.000Z")).toBeUndefined();
  });

  test("a fire BEFORE the turn end clamps to 0 rather than going negative", () => {
    // computeGapMinutes already clamps; asserted here because a negative
    // staleness would corrupt any distribution computed over the corpus.
    expect(computeStalenessMinutes("2026-08-10T19:00:00.000Z", "2026-08-10T18:00:00.000Z")).toBe(0);
  });

  // AT2. The distribution is a property of when the guard RUNS, not of whether
  // it fired, so a fire-only sample would be biased by construction.
  test("AT2: a NON-firing evaluation still carries stalenessMinutes", () => {
    const { deps, records } = capturingDeps();
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 5),
      userPromptLine(1 + 5 * 5 + 10, NEXT_INSTRUCTION_PROMPT),
    ];

    expect(run(HOOK_INPUT, makeCtx(transcriptLines), deps)).toBeNull();
    expect(records).toHaveLength(1);
    expect(records[0]?.fired).toBe(false);
    expect(typeof records[0]?.stalenessMinutes).toBe("number");
  });

  test("a FIRING turn carries stalenessMinutes on both the evaluation and the calibration record", () => {
    const { deps, records } = capturingDeps();
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20, STRETCH_SPACING),
      userPromptLine(1 + 20 * STRETCH_SPACING + 30, STRETCH_CLOSING_PROMPT),
    ];

    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), deps);
    expect(typeof outcome?.calibration?.stalenessMinutes).toBe("number");
    expect(typeof records[0]?.stalenessMinutes).toBe("number");
    // Both rows describe ONE firing, so they must agree exactly — a per-record
    // clock read would let them drift by however long the dedupe reads took.
    expect(outcome?.calibration?.stalenessMinutes).toBe(records[0]?.stalenessMinutes);
    expect(outcome?.calibration?.timestamp).toBe(records[0]?.timestamp);
  });

  // AT3 — the scope boundary. This task measures; it must not change delivery.
  // Suppressing a stale advisory is mt#4027, gated on an operator decision per
  // ADR-031's principal-facing axis. This fixture's turn is from 2026-07-15, so
  // its staleness is enormous by construction — and the advisory must STILL
  // fire. If this test ever fails, the change has crossed into mt#4027.
  test("AT3: a very stale turn still emits its advisory — delivery is unchanged", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20, STRETCH_SPACING),
      userPromptLine(1 + 20 * STRETCH_SPACING + 30, STRETCH_CLOSING_PROMPT),
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());

    expect(outcome?.calibration?.stalenessMinutes).toBeGreaterThan(60);
    expect(outcome?.additionalContext).toBeTruthy();
    expect(outcome?.additionalContext).toContain("silent-stretch-detector");
  });

  // AT4. The two shapes a large delta can have must not be conflated: a turn
  // that RAN for hours is a different phenomenon from one that ENDED hours ago.
  // The anchor carries both bounds, so the turn's own duration is derivable
  // from the record without a second field — this test is what makes that
  // claim checkable rather than asserted in a comment.
  test("AT4: a long-RUNNING turn is distinguishable from a long-ABSENCE turn", () => {
    const durationMinutes = (anchor: string): number => {
      const [start, end] = anchor.split("::");
      return (Date.parse(end as string) - Date.parse(start as string)) / 60000;
    };

    // Long-running: 20 calls spread 30s apart — the turn itself spans ~10 min.
    const longRunning = run(
      HOOK_INPUT,
      makeCtx([
        userPromptLine(0),
        ...toolCallChain(1, 20, STRETCH_SPACING),
        userPromptLine(1 + 20 * STRETCH_SPACING + 30, STRETCH_CLOSING_PROMPT),
      ]),
      noDedupeDeps()
    );

    // Short-but-crossing: 31 calls 2s apart clears the hard 30-call arm while
    // the turn itself spans ~1 min. Same guard, opposite shape.
    const shortBurst = run(
      HOOK_INPUT,
      makeCtx([
        userPromptLine(0),
        ...toolCallChain(1, 31, 2),
        userPromptLine(1 + 31 * 2 + 10, STRETCH_CLOSING_PROMPT),
      ]),
      noDedupeDeps()
    );

    const longAnchor = longRunning?.calibration?.turnAnchor as string;
    const shortAnchor = shortBurst?.calibration?.turnAnchor as string;
    expect(longAnchor).toBeTruthy();
    expect(shortAnchor).toBeTruthy();

    // Both carry staleness; the DURATION is what tells the two shapes apart.
    expect(typeof longRunning?.calibration?.stalenessMinutes).toBe("number");
    expect(typeof shortBurst?.calibration?.stalenessMinutes).toBe("number");
    expect(durationMinutes(longAnchor)).toBeGreaterThan(5);
    expect(durationMinutes(shortAnchor)).toBeLessThan(3);
  });
});
