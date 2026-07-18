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
 * @see mt#2870
 */

import { describe, test, expect } from "bun:test";
import {
  measureWallOfText,
  extractFinalAssistantText,
  WORD_COUNT_THRESHOLD,
  LEAD_WINDOW_WORDS,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  run,
} from "./wall-of-text-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

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
    transcript_path: "/tmp/fake-transcript.jsonl",
    cwd: "/tmp",
    hook_event_name: "UserPromptSubmit",
    ...overrides,
  } as ClaudeHookInput;
}

function makeCtx(transcriptLines: TranscriptLine[]): DispatchContext {
  return { transcriptLines } as DispatchContext;
}

/** A full synthetic transcript: prompt, report line(s), closing prompt. */
function transcriptWithFinalReport(reportText: string): TranscriptLine[] {
  return [
    userPromptLine(0, "please do the thing"),
    assistantToolUseLine(10),
    assistantTextLine(60, reportText),
    userPromptLine(120, "next prompt"),
  ];
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

  test("over-budget alone (clean prose at 2x budget) -> trigger 'over-budget'", () => {
    const m = measureWallOfText(words(WORD_COUNT_THRESHOLD));
    expect(m.matched).toBe(true);
    expect(m.trigger).toBe("over-budget");
    expect(m.leadLabelHits).toEqual([]);
  });

  test("under budget but 'gate (l)' in the lead -> trigger 'lead-labels'", () => {
    const m = measureWallOfText(`Gate (l) blocked promotion. ${words(50)}`);
    expect(m.matched).toBe(true);
    expect(m.trigger).toBe("lead-labels");
    expect(m.leadLabelHits).toEqual(["gate-letter"]);
  });

  test("SC#N ref in the lead -> 'sc-ref' hit", () => {
    const m = measureWallOfText(`SC#3 is unmet. ${words(20)}`);
    expect(m.leadLabelHits).toEqual(["sc-ref"]);
    expect(m.matched).toBe(true);
  });

  test("'(i.e.' does not false-positive the premise-label pattern", () => {
    const m = measureWallOfText(`The fallback (i.e. keychain) is expected. ${words(20)}`);
    expect(m.leadLabelHits).toEqual([]);
    expect(m.matched).toBe(false);
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
  test("label-heavy over-budget report -> calibration outcome, no injection (v1)", () => {
    const lines = transcriptWithFinalReport(labelHeavyReport());
    const outcome = run(makeInput(), makeCtx(lines));
    expect(outcome).not.toBeNull();
    expect(outcome?.calibration).toBeDefined();
    const cal = outcome?.calibration as Record<string, unknown>;
    expect(cal.trigger).toBe("both");
    expect(cal.wordCount as number).toBeGreaterThanOrEqual(900);
    expect(cal.session_id).toBe("wall-of-text-test-session");
    // v1 is calibration-only: no injected context while INJECTION_ENABLED=false.
    expect(INJECTION_ENABLED).toBe(false);
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("contract-conforming report -> null", () => {
    const lines = transcriptWithFinalReport(conformingReport());
    expect(run(makeInput(), makeCtx(lines))).toBeNull();
  });

  test("override env var -> audit line, no measurement", () => {
    const prev = process.env[OVERRIDE_ENV_VAR];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const lines = transcriptWithFinalReport(labelHeavyReport());
      const outcome = run(makeInput(), makeCtx(lines));
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
    expect(run(input, makeCtx(lines))).toBeNull();
  });

  test("empty transcript -> null", () => {
    expect(run(makeInput(), makeCtx([]))).toBeNull();
  });
});
