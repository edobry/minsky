#!/usr/bin/env bun
/**
 * Unit tests for silent-stretch-detector.ts
 *
 * Covers (mt#2824 acceptance tests):
 * - Synthetic 20-tool-call silent transcript -> fires (matched, calibration record)
 * - Synthetic 5-call short chain -> does NOT fire
 * - Text output mid-stretch resets the tool-call counter
 * - Wall-clock gap threshold (10 min) fires independently of tool-call count
 * - Override env var suppresses detection and returns an audit line
 * - No transcript_path / empty transcript -> null (silent allow)
 *
 * @see mt#2824
 */

import { describe, test, expect } from "bun:test";
import {
  measureSilentStretch,
  findTurnBoundaryTimestamps,
  GAP_MINUTES_THRESHOLD,
  TOOL_CALL_THRESHOLD,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  run,
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

// ---------------------------------------------------------------------------
// measureSilentStretch — pure function
// ---------------------------------------------------------------------------

describe("measureSilentStretch", () => {
  test("20 consecutive tool calls, no text -> matched (tool-call threshold)", () => {
    const turnLines = toolCallChain(0, 20);
    const measurement = measureSilentStretch(turnLines, ts(0), ts(20 * 5 + 30));
    expect(measurement.toolCallCount).toBe(20);
    expect(measurement.hadTextInTurn).toBe(false);
    expect(measurement.matched).toBe(true);
    expect(measurement.toolCallCount).toBeGreaterThanOrEqual(TOOL_CALL_THRESHOLD);
  });

  test("5 consecutive tool calls, no text, short wall-clock gap -> NOT matched", () => {
    const turnLines = toolCallChain(0, 5);
    // 5 calls * 5s apart + a little = well under 10 minutes and under 15 calls
    const measurement = measureSilentStretch(turnLines, ts(0), ts(5 * 5 + 10));
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

    const currentPromptTs = ts(textOffset + 5 + 5 * 5 + 10); // just after the trailing chain
    const measurement = measureSilentStretch(turnLines, ts(0), currentPromptTs);

    expect(measurement.hadTextInTurn).toBe(true);
    // Counter only reflects tool calls AFTER the reset point.
    expect(measurement.toolCallCount).toBe(5);
    expect(measurement.matched).toBe(false);
  });

  test("wall-clock gap threshold fires independently of tool-call count", () => {
    // Only 3 tool calls, but the gap between the turn start (no text at all
    // in the turn) and the current prompt exceeds 10 minutes.
    const turnLines = toolCallChain(0, 3);
    const elevenMinutesLater = ts(11 * 60);
    const measurement = measureSilentStretch(turnLines, ts(0), elevenMinutesLater);

    expect(measurement.toolCallCount).toBe(3);
    expect(measurement.gapMinutes).toBeGreaterThanOrEqual(GAP_MINUTES_THRESHOLD);
    expect(measurement.matched).toBe(true);
  });

  test("narration immediately before the current prompt -> gap measured from that text, not turn start", () => {
    const turnLines = [
      ...toolCallChain(0, 3),
      assistantTextLine(20, "Done — summary of findings."),
    ];
    // Turn started 11 minutes before the current prompt, but the text line
    // landed only 30s before it — gap must be measured from the TEXT line.
    const measurement = measureSilentStretch(turnLines, ts(-11 * 60), ts(50));
    expect(measurement.hadTextInTurn).toBe(true);
    expect(measurement.toolCallCount).toBe(0);
    expect(measurement.gapMinutes).toBeLessThan(1);
    expect(measurement.matched).toBe(false);
  });

  test("missing timestamps degrade to gapMinutes=0 rather than throwing", () => {
    const turnLines = toolCallChain(0, 2);
    const measurement = measureSilentStretch(turnLines, undefined, undefined);
    expect(measurement.gapMinutes).toBe(0);
    expect(measurement.toolCallCount).toBe(2);
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

describe("run() (dispatcher-compatible)", () => {
  test("20-tool-call silent turn -> calibration record, NO additionalContext (INJECTION_ENABLED=false)", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20),
      userPromptLine(1 + 20 * 5 + 30, "why has nothing happened?"),
    ];
    const outcome = run(HOOK_INPUT, makeCtx(transcriptLines));
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
    expect(run(HOOK_INPUT, makeCtx(transcriptLines))).toBeNull();
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
    expect(run(input, makeCtx(transcriptLines))).toBeNull();
  });

  test("empty transcript -> null", () => {
    expect(run(HOOK_INPUT, makeCtx([]))).toBeNull();
  });

  test("override env var suppresses detection and returns an audit line", () => {
    const transcriptLines = [
      userPromptLine(0),
      ...toolCallChain(1, 20),
      userPromptLine(1 + 20 * 5 + 30),
    ];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const outcome = run(HOOK_INPUT, makeCtx(transcriptLines));
      expect(outcome?.calibration).toBeUndefined();
      expect(outcome?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      delete process.env[OVERRIDE_ENV_VAR];
    }
  });
});
