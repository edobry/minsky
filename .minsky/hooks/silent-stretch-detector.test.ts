#!/usr/bin/env bun
/**
 * Unit tests for silent-stretch-detector.ts
 *
 * Covers (mt#2824 acceptance tests, re-verified post mt#3027):
 * - Synthetic 20-tool-call silent transcript -> fires (matched, calibration record)
 * - Synthetic 5-call short chain -> does NOT fire
 * - Text output mid-stretch resets the tool-call counter
 * - Wall-clock gap threshold (10 min) fires independently of tool-call count,
 *   measured WITHIN the turn (mt#3027)
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
  findTurnBoundaryTimestamps,
  buildTurnAnchor,
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

/** A single tool_use + its tool_result, `count` times, starting at `startOffset` seconds, 5s apart. */
function toolCallChain(startOffset: number, count: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (let i = 0; i < count; i++) {
    const base = startOffset + i * 5;
    lines.push(assistantToolUseLine(base, `Tool${i}`));
    lines.push(toolResultLine(base + 1));
  }
  return lines;
}

const DAY_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// measureSilentStretch — pure function
// ---------------------------------------------------------------------------

describe("measureSilentStretch", () => {
  test("20 consecutive tool calls, no text -> matched (tool-call threshold)", () => {
    const turnLines = toolCallChain(0, 20);
    const measurement = measureSilentStretch(turnLines, ts(0));
    expect(measurement.toolCallCount).toBe(20);
    expect(measurement.hadTextInTurn).toBe(false);
    expect(measurement.matched).toBe(true);
    expect(measurement.toolCallCount).toBeGreaterThanOrEqual(TOOL_CALL_THRESHOLD);
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

  test("wall-clock gap threshold fires independently of tool-call count (within-turn span)", () => {
    // Only 3 tool calls, but the SPAN BETWEEN THEM (all within the turn)
    // exceeds 10 minutes. mt#3027: this must be measured from the turn's own
    // timestamps, never from a later real user prompt.
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
    expect(measurement.gapMinutes).toBeGreaterThanOrEqual(GAP_MINUTES_THRESHOLD);
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
    const genuineStretch = toolCallChain(0, 20);
    const textOffset = 20 * 5 + 2;
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
  test("returns the previous and current real-prompt timestamps", () => {
    const lines = [
      userPromptLine(0, "first message"),
      assistantToolUseLine(1),
      toolResultLine(2),
      userPromptLine(100, "second message (interrupt)"),
    ];
    const { turnStartTimestamp, currentPromptTimestamp } = findTurnBoundaryTimestamps(lines);
    expect(turnStartTimestamp).toBe(ts(0));
    expect(currentPromptTimestamp).toBe(ts(100));
  });

  test("fewer than 2 real prompts -> both undefined", () => {
    const lines = [userPromptLine(0), assistantToolUseLine(1)];
    const result = findTurnBoundaryTimestamps(lines);
    expect(result.turnStartTimestamp).toBeUndefined();
    expect(result.currentPromptTimestamp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// run() — dispatcher-compatible pure function (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

const HOOK_EVENT_NAME = "UserPromptSubmit";

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
  return { readCalibrationLogTextFn: () => undefined };
}

describe("run() (dispatcher-compatible)", () => {
  test("20-tool-call silent turn -> calibration record, NO additionalContext (INJECTION_ENABLED=false)", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20),
      userPromptLine(1 + 20 * 5 + 30, "why has nothing happened?"),
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps());
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.calibration?.toolCallCount).toBe(20);
    expect(outcome?.calibration?.session_id).toBe("test-session");
    expect(outcome?.additionalContext).toBeUndefined();
    expect(INJECTION_ENABLED).toBe(false);
  });

  test("5-call short chain -> null (silent allow)", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 5),
      userPromptLine(1 + 5 * 5 + 10, "next instruction"),
    ];
    expect(run(HOOK_INPUT, makeCtx(transcriptLines), noDedupeDeps())).toBeNull();
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
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 16),
      userPromptLine(1 + 16 * 5 + 10, "how's it going?"),
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
      timestamp: ts(1 + 10 * 5),
    };
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 10),
      skillBodyLine,
      ...toolCallChain(1 + 10 * 5 + 5, 10),
      userPromptLine(1 + 20 * 5 + 40, "how is it going?"),
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
      currentPromptTimestamp: ts(100),
    });
    expect(anchor).toBe(`${ts(0)}::${ts(100)}`);
  });

  test("missing either boundary -> undefined (never a dedupe candidate)", () => {
    expect(
      buildTurnAnchor({ turnStartTimestamp: undefined, currentPromptTimestamp: ts(100) })
    ).toBeUndefined();
    expect(
      buildTurnAnchor({ turnStartTimestamp: ts(0), currentPromptTimestamp: undefined })
    ).toBeUndefined();
  });

  test("the SAME turn (identical boundaries) always produces the SAME anchor", () => {
    const boundaries = { turnStartTimestamp: ts(0), currentPromptTimestamp: ts(50) };
    expect(buildTurnAnchor(boundaries)).toBe(buildTurnAnchor({ ...boundaries }));
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

  test("measures only the parent transcript when >1 candidate is resolved, ignoring the flattened array", () => {
    // The parent's OWN turn is short (5 calls, well under threshold) — it
    // must NOT fire. A naive scan of the flattened array would see the
    // subagent's 20-call stretch appended after it and fire on THAT
    // instead, misattributing the subagent's own activity to this
    // conversation's turn.
    const parentLines = [
      userPromptLine(0),
      ...toolCallChain(1, 5),
      userPromptLine(1 + 5 * 5 + 10, "status?"),
    ];
    const subagentLines = [userPromptLine(0), ...toolCallChain(1, 20), userPromptLine(500)];
    const contaminated = [...parentLines, ...subagentLines];
    const ctx = makeCtxWithCandidates(contaminated, [PARENT_PATH, SUBAGENT_PATH]);
    const deps: RunDeps = {
      parseTranscriptFn: (path) => {
        expect(path).toBe(PARENT_PATH); // always candidates[0]
        return parentLines;
      },
      readCalibrationLogTextFn: () => undefined,
    };
    const input: ClaudeHookInput = { ...HOOK_INPUT, transcript_path: PARENT_PATH };
    expect(run(input, ctx, deps)).toBeNull();
  });

  test("a genuine parent-side stretch still fires even with a contaminated multi-candidate ctx", () => {
    const parentLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20),
      userPromptLine(1 + 20 * 5 + 30, "still going?"),
    ];
    const subagentLines = [
      userPromptLine(0),
      assistantTextLine(1, "subagent done"),
      userPromptLine(2),
    ];
    const contaminated = [...parentLines, ...subagentLines];
    const ctx = makeCtxWithCandidates(contaminated, [PARENT_PATH, SUBAGENT_PATH]);
    const deps: RunDeps = {
      parseTranscriptFn: (path) => (path === PARENT_PATH ? parentLines : []),
      readCalibrationLogTextFn: () => undefined,
    };
    const input: ClaudeHookInput = { ...HOOK_INPUT, transcript_path: PARENT_PATH };
    const outcome = run(input, ctx, deps);
    expect(outcome?.calibration).toBeDefined();
    expect(outcome?.calibration?.toolCallCount).toBe(20);
  });

  test("<=1 candidate -> unaffected, uses ctx.transcriptLines directly (no parseTranscriptFn call)", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20),
      userPromptLine(1 + 20 * 5 + 30),
    ];
    const ctx = makeCtxWithCandidates(transcriptLines, [PARENT_PATH]);
    const poisoned: RunDeps = {
      parseTranscriptFn: () => {
        throw new Error("parseTranscriptFn must not be called for a single candidate");
      },
      readCalibrationLogTextFn: () => undefined,
    };
    const outcome = run(HOOK_INPUT, ctx, poisoned);
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
      ...toolCallChain(1, 20), // genuine 20-tool-call stretch -> crosses TOOL_CALL_THRESHOLD
      userPromptLine(1 + 20 * 5 + 30, "why so long?"),
    ];
    const ctx = makeCtx(transcriptLines);

    // Firing 1: no prior record for this session -> logs.
    const outcome1 = run(HOOK_INPUT, ctx, { readCalibrationLogTextFn: () => undefined });
    expect(outcome1?.calibration).toBeDefined();
    const anchor1 = (outcome1?.calibration as Record<string, unknown>).turnAnchor as string;
    expect(typeof anchor1).toBe("string");

    // Simulate the framework having appended firing 1's record — firings
    // 2-5 read it back and see the SAME anchor for this session, because
    // it's genuinely the same (frozen or re-observed) turn.
    const priorLogText = `${JSON.stringify({ session_id: HOOK_INPUT.session_id, turnAnchor: anchor1 })}\n`;
    const deps: RunDeps = { readCalibrationLogTextFn: () => priorLogText };

    expect(run(HOOK_INPUT, ctx, deps)).toBeNull();
    expect(run(HOOK_INPUT, ctx, deps)).toBeNull();
    expect(run(HOOK_INPUT, ctx, deps)).toBeNull();
    expect(run(HOOK_INPUT, ctx, deps)).toBeNull();
  });

  test("a DIFFERENT turn for the same session (changed anchor) is NOT deduped", () => {
    const firstTurn = [
      userPromptLine(0),
      ...toolCallChain(1, 20),
      userPromptLine(1 + 20 * 5 + 30, "still going?"),
    ];
    const outcome1 = run(HOOK_INPUT, makeCtx(firstTurn), {
      readCalibrationLogTextFn: () => undefined,
    });
    const anchor1 = (outcome1?.calibration as Record<string, unknown>).turnAnchor as string;
    const priorLogText = `${JSON.stringify({ session_id: HOOK_INPUT.session_id, turnAnchor: anchor1 })}\n`;

    // A genuinely NEW turn (different boundary timestamps) must still fire,
    // even though a (stale, different-anchor) prior record exists.
    const secondTurnStart = 1 + 20 * 5 + 30;
    const secondTurn = [
      userPromptLine(secondTurnStart, "still going?"),
      ...toolCallChain(secondTurnStart + 1, 20),
      userPromptLine(secondTurnStart + 1 + 20 * 5 + 30, "and now?"),
    ];
    const outcome2 = run(HOOK_INPUT, makeCtx(secondTurn), {
      readCalibrationLogTextFn: () => priorLogText,
    });
    expect(outcome2?.calibration).toBeDefined();
  });

  test("A -> B -> A sequence: the repeat A is deduped even though B is the most recent record", () => {
    const turnA = [
      userPromptLine(0),
      ...toolCallChain(1, 20),
      userPromptLine(1 + 20 * 5 + 30, "A"),
    ];
    const anchorA = buildTurnAnchor(findTurnBoundaryTimestamps(turnA));
    const turnBStart = 1 + 20 * 5 + 30;
    const turnB = [
      userPromptLine(turnBStart, "A"),
      ...toolCallChain(turnBStart + 1, 20),
      userPromptLine(turnBStart + 1 + 20 * 5 + 30, "B"),
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

  test("AT3: 40 min between last text and last tool_use, next prompt 5 min after -> fires with gap ~40 (not ~45)", () => {
    const textOffset = 0;
    const lastToolOffset = textOffset + 40 * 60; // 40 minutes after the text
    const nextPromptOffset = lastToolOffset + 5 * 60; // 5 minutes after the last tool call
    const transcriptLines = [
      userPromptLine(-10),
      assistantTextLine(textOffset, "Starting the check now."),
      assistantToolUseLine(lastToolOffset, "Read"),
      toolResultLine(lastToolOffset + 1),
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
