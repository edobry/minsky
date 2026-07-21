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
 * - `hashText` / `findLastHashForSession` dedupe-key primitives
 * - `run()`: five 100-word interstitial notes + a 150-word final report does NOT fire
 * - `run()`: the same over-budget report logged across 3 successive turns logs ONCE
 * - `run()`: a genuine 1,500-word final report still fires despite the dedupe check
 *
 * @see mt#2870
 * @see mt#3028
 */

import { describe, test, expect } from "bun:test";
import {
  measureWallOfText,
  extractFinalAssistantText,
  resolveTurnLines,
  hashText,
  findLastHashForSession,
  WORD_COUNT_THRESHOLD,
  LEAD_WINDOW_WORDS,
  INJECTION_ENABLED,
  OVERRIDE_ENV_VAR,
  run,
  type RunDeps,
} from "./wall-of-text-detector";
import type { TranscriptLine } from "./transcript";
import type { ClaudeHookInput } from "./types";
import type { DispatchContext } from "./registry";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// Shared path constants (custom/no-magic-string-duplication).
const FAKE_TRANSCRIPT_PATH = "/tmp/fake-transcript.jsonl";
const PARENT_TRANSCRIPT_PATH = "/tmp/parent.jsonl";
const SUBAGENT_TRANSCRIPT_PATH = "/tmp/subagents/agent-fake.jsonl";

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
    // v1 is calibration-only: no injected context while INJECTION_ENABLED=false.
    expect(INJECTION_ENABLED).toBe(false);
    expect(outcome?.additionalContext).toBeUndefined();
  });

  test("contract-conforming report -> null", () => {
    const lines = transcriptWithFinalReport(conformingReport());
    expect(run(makeInput(), makeCtx(lines), noDedupeDeps())).toBeNull();
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
// resolveTurnLines — mt#3028 fix (1): cross-transcript contamination defense
// ---------------------------------------------------------------------------

describe("resolveTurnLines", () => {
  test("<=1 transcript candidate -> trusts ctx.transcriptLines as-is (no re-parse)", () => {
    const lines = transcriptWithFinalReport(conformingReport());
    const ctx = makeCtxWithCandidates(lines, [FAKE_TRANSCRIPT_PATH]);
    // The injected parse function returns something OBVIOUSLY different —
    // if it were called, the assertion below would fail. It must NOT be
    // called when there is only one candidate.
    const poisoned = () => {
      throw new Error("parseTranscriptFn must not be called for a single candidate");
    };
    expect(resolveTurnLines(makeInput(), ctx, poisoned)).toBe(lines);
  });

  test("undefined transcriptCandidates -> trusts ctx.transcriptLines as-is (existing-test compatibility)", () => {
    const lines = transcriptWithFinalReport(conformingReport());
    const ctx = makeCtx(lines); // no transcriptCandidates field at all
    const poisoned = () => {
      throw new Error("parseTranscriptFn must not be called with no candidates array");
    };
    expect(resolveTurnLines(makeInput(), ctx, poisoned)).toBe(lines);
  });

  test(">1 transcript candidates -> re-parses the PARENT candidate, ignoring the merged array", () => {
    // Simulate the empirically-confirmed contamination: ctx.transcriptLines
    // is "parent + subagent" concatenated, and the subagent's own final
    // report (label-heavy, over-budget) lands last in the flat array — the
    // exact shape that misattributed a subagent's report as the parent's
    // turn-end report in session e1a0c941.
    const parentLines = transcriptWithFinalReport(conformingReport());
    const subagentLines = transcriptWithFinalReport(labelHeavyReport());
    const contaminated = [...parentLines, ...subagentLines];
    const ctx = makeCtxWithCandidates(contaminated, [
      PARENT_TRANSCRIPT_PATH,
      SUBAGENT_TRANSCRIPT_PATH,
    ]);
    const parseTranscriptFn = (path: string): TranscriptLine[] => {
      expect(path).toBe(PARENT_TRANSCRIPT_PATH); // always candidates[0] / input.transcript_path
      return parentLines;
    };
    const input = makeInput({ transcript_path: PARENT_TRANSCRIPT_PATH });
    expect(resolveTurnLines(input, ctx, parseTranscriptFn)).toBe(parentLines);
  });
});

// ---------------------------------------------------------------------------
// hashText / findLastHashForSession — mt#3028 fix (2): dedupe primitives
// ---------------------------------------------------------------------------

describe("hashText", () => {
  test("stable and deterministic for identical input", () => {
    expect(hashText("the same report")).toBe(hashText("the same report"));
  });

  test("differs for different input", () => {
    expect(hashText("report A")).not.toBe(hashText("report B"));
  });
});

describe("findLastHashForSession", () => {
  test("undefined log text -> undefined", () => {
    expect(findLastHashForSession(undefined, "session-a")).toBeUndefined();
  });

  test("undefined session id -> undefined", () => {
    const log = `${JSON.stringify({ session_id: "session-a", textHash: "abc123" })}\n`;
    expect(findLastHashForSession(log, undefined)).toBeUndefined();
  });

  test("no record for this session -> undefined", () => {
    const log = `${JSON.stringify({ session_id: "session-a", textHash: "abc123" })}\n`;
    expect(findLastHashForSession(log, "session-b")).toBeUndefined();
  });

  test("returns the MOST RECENT record's hash for this session, ignoring other sessions", () => {
    const lines = [
      { session_id: "session-a", textHash: "first" },
      { session_id: "session-b", textHash: "other-session" },
      { session_id: "session-a", textHash: "second" },
    ];
    const log = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
    expect(findLastHashForSession(log, "session-a")).toBe("second");
  });

  test("tolerates blank lines and malformed JSON lines", () => {
    const log = [
      "",
      "not valid json",
      JSON.stringify({ session_id: "session-a", textHash: "ok" }),
      "",
    ].join("\n");
    expect(findLastHashForSession(log, "session-a")).toBe("ok");
  });

  test("most recent record lacking textHash (pre-mt#3028 record) -> undefined", () => {
    const log = `${JSON.stringify({ session_id: "session-a" })}\n`;
    expect(findLastHashForSession(log, "session-a")).toBeUndefined();
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
      userPromptLine(0, "please do the thing"),
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

  test("subagent-contaminated ctx (>1 candidates) does NOT fire on the subagent's report when the parent's own report is conforming", () => {
    // End-to-end version of the resolveTurnLines contamination test, run
    // through run() itself. The naive ctx.transcriptLines (parent + a
    // dispatched subagent's own label-heavy final report appended after)
    // WOULD fire if used directly; run() must measure only the parent.
    const parentLines = transcriptWithFinalReport(conformingReport());
    const subagentLines = transcriptWithFinalReport(labelHeavyReport());
    const contaminated = [...parentLines, ...subagentLines];
    const ctx = makeCtxWithCandidates(contaminated, [
      FAKE_TRANSCRIPT_PATH,
      SUBAGENT_TRANSCRIPT_PATH,
    ]);
    const deps: RunDeps = {
      parseTranscriptFn: (path) => {
        expect(path).toBe(FAKE_TRANSCRIPT_PATH);
        return parentLines;
      },
      readCalibrationLogTextFn: () => undefined,
    };
    expect(run(makeInput(), ctx, deps)).toBeNull();
  });
});
