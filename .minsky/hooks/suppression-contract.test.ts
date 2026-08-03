/**
 * Producer → consumer contract for `suppressionReasons` (mt#3207).
 *
 * Every per-detector test in this repo asserts the record a detector BUILDS.
 * None of them asserted that the sweep — the only consumer that matters —
 * actually reads it, which is exactly how `untaken-action` shipped a
 * suppression outcome the sweep could not see for a full review cycle
 * (`detectorFields.suppressedByAskRoutingDeferral`; 18 of 24 records in the
 * 2026-08-01 pass counted as injected).
 *
 * So these tests take the REAL record each detector writes, serialize it the
 * way the log does, and run it through `computeLogResult` under that log's own
 * registry kind. A field renamed, nested, or written on only one of a
 * detector's two entry points fails here.
 *
 * @see mt#3207 — the task that populated the field in five detectors
 * @see mt#3197 — the shared contract + suppression-aware counting
 */
/* eslint-disable custom/no-real-fs-in-tests -- turn-end-untaken-action-scan's dedup store writes real per-session JSON; this exercises it in an isolated mkdtemp dir, per turn-end-untaken-action-scan.test.ts's precedent */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeLogResult,
  type CalibrationLogEntry,
} from "../../src/domain/calibration/calibration-sweep";
import {
  buildPreNarrationRecord,
  detectPreNarrationWithSuppression,
  SUPPRESSION_SAME_TURN_TOOL_CALL,
} from "./pre-narration-detector";
import {
  buildCalibrationRecord as buildKnowledgeRecord,
  SUPPRESSION_PROPAGATION_IN_WINDOW,
  type KnowledgeAcquisitionDetection,
} from "./knowledge-acquisition-detector";
import {
  run as runUntakenAction,
  SUPPRESSION_DEDUPED_BY_ASK_ROUTING_DEFERRAL,
} from "./turn-end-untaken-action-scan";
import { SUPPRESSION_ASKS_CREATE_THIS_TURN } from "./ask-routing-deferral-detector";
import { SUPPRESSION_DEPTH_REQUEST } from "./wall-of-text-detector";
import type { ClaudeHookInput } from "./types";
import type { StopHookInput } from "./turn-end-retro-scan";
import type { DispatchContext } from "./registry";

function entryFor(name: CalibrationLogEntry["kind"]): CalibrationLogEntry {
  return { path: `.minsky/${name}-calibration.jsonl`, name, kind: name };
}

/** One record per line, exactly as `appendCalibrationRecord` writes it. */
function asLogContent(records: Array<Record<string, unknown>>): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

const CTX = { transcriptLines: [] } as unknown as DispatchContext;

let storeDir: string;
beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "mt3207-contract-"));
});
afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

describe("mt#3207 — the sweep sees each detector's suppression outcome", () => {
  test("pre-narration: a suppressed record counts as suppressed, not injected", () => {
    const turn = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "mcp__minsky__session_pr_create", input: {} }],
        },
      },
      { type: "assistant", message: { role: "assistant", content: "Created PR #4242." } },
    ];
    const record = buildPreNarrationRecord("s1", detectPreNarrationWithSuppression(turn as never));
    expect(record.suppressionReasons).toEqual([SUPPRESSION_SAME_TURN_TOOL_CALL]);

    const result = computeLogResult(
      entryFor("pre-narration"),
      asLogContent([record]),
      true,
      undefined
    );
    expect(result.firesSinceLastReview).toBe(1);
    expect(result.suppressedSinceLastReview).toBe(1);
    expect(result.injectedFiresSinceLastReview).toBe(0);
  });

  test("knowledge-acquisition: a propagation-suppressed record counts as suppressed", () => {
    const detection: KnowledgeAcquisitionDetection = {
      result: {
        matched: true,
        detectionRung: "1+2-lite",
        researchTools: ["WebSearch"],
        loadedSkills: ["engineering-writing"],
        matchedSkill: "engineering-writing",
        matchedKeyword: "argumentative",
        hadPropagation: true,
      },
      dedupeKey: "3:WebSearch",
      suppressionReasons: [SUPPRESSION_PROPAGATION_IN_WINDOW],
    };
    const record = buildKnowledgeRecord({ session_id: "s1" } as ClaudeHookInput, detection);

    const result = computeLogResult(
      entryFor("knowledge-acquisition"),
      asLogContent([record]),
      true,
      undefined
    );
    expect(result.suppressedSinceLastReview).toBe(1);
    expect(result.injectedFiresSinceLastReview).toBe(0);
  });

  test("untaken-action: the record the 2026-08-01 pass miscounted now reads as suppressed", () => {
    // Verbatim shape of the miscount: "say the word" matches BOTH detectors,
    // so mt#3336's dedup withholds the injection. The record carried only the
    // bespoke boolean, so the sweep read all 24 such fires as injected.
    const input = {
      session_id: "mt3207-contract",
      last_assistant_message: "Everything is staged and green. Say the word and it ships.",
    } as StopHookInput;
    const outcome = runUntakenAction(input, CTX, storeDir);
    const record = outcome?.calibration as Record<string, unknown>;
    expect(record.suppressedByAskRoutingDeferral).toBe(true);
    expect(record.suppressionReasons).toEqual([SUPPRESSION_DEDUPED_BY_ASK_ROUTING_DEFERRAL]);

    const result = computeLogResult(
      entryFor("untaken-action"),
      asLogContent([record]),
      true,
      undefined
    );
    expect(result.suppressedSinceLastReview).toBe(1);
    expect(result.injectedFiresSinceLastReview).toBe(0);
  });

  test("a mixed log reports both counts — suppression never hides an injected fire", () => {
    const suppressed = {
      timestamp: "2026-08-01T00:00:00.000Z",
      session_id: "s1",
      injection_enabled: true,
      matches: [{ class: "principal-reserved", phrase: "needs your call" }],
      suppressionReasons: [SUPPRESSION_ASKS_CREATE_THIS_TURN],
    };
    const injected = { ...suppressed, session_id: "s2", suppressionReasons: [] };

    const result = computeLogResult(
      entryFor("ask-routing-deferral"),
      asLogContent([suppressed, injected]),
      true,
      undefined
    );
    expect(result.firesSinceLastReview).toBe(2);
    expect(result.suppressedSinceLastReview).toBe(1);
    expect(result.injectedFiresSinceLastReview).toBe(1);
  });

  test("wall-of-text: the depth-request override is finally measurable", () => {
    const suppressed = {
      timestamp: "2026-08-01T00:00:00.000Z",
      session_id: "s1",
      wordCount: 400,
      lineCount: 30,
      trigger: "word-count",
      textHash: "abc123",
      suppressedByDepthRequest: true,
      suppressionReasons: [SUPPRESSION_DEPTH_REQUEST],
    };
    const result = computeLogResult(
      entryFor("wall-of-text"),
      asLogContent([suppressed]),
      true,
      undefined
    );
    expect(result.suppressedSinceLastReview).toBe(1);
  });
});
