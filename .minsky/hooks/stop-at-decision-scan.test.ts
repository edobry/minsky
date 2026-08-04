/* eslint-disable custom/no-real-fs-in-tests -- the dedup store (turn-end-scan-store.ts) writes real per-session JSON files; these tests exercise the real store roundtrip (write -> dedup-read) in an isolated mkdtemp dir, mirroring turn-end-unwalked-task-scan.test.ts's precedent */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectBoundTaskIds,
  detectDecisionStop,
  run,
  EVIDENCE_TOOL,
  EVIDENCE_COMPANION_TOOL,
} from "./stop-at-decision-scan";
import type { RunDeps } from "./stop-at-decision-scan";
import type { TranscriptLine } from "./transcript";
import type { DispatchContext } from "./registry";
import type { StopHookInput } from "./turn-end-retro-scan";

/** The originating incident's ids: conversation bound to mt#3639, evidence into mt#3521. */
const BOUND_TASK = "mt#3639";
const TARGET_TASK = "mt#3521";

/** The R5 closing message — a factual bound, no commitment phrase, no recommendation. */
const R5_FINAL_MESSAGE =
  "Both detector misses are now documented in the task record, and the measurement premise " +
  "was false: a Rung-1 miss wrote no record at all.";

function userPrompt(text: string, timestamp?: string): TranscriptLine {
  return { type: "user", message: { role: "user", content: text }, timestamp };
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  };
}

/** User-role by construction (the real transcript shape) but not a real prompt. */
function toolResult(useId: string, payload: unknown): TranscriptLine {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: useId, content: JSON.stringify(payload) }],
    },
  };
}

/** An earlier working turn that BINDS the conversation to mt#3639 via a session tool. */
function bindingPrefix(): TranscriptLine[] {
  return [
    userPrompt("fix the asks page rendering"),
    toolUse("toolu_bind", "mcp__minsky__session_commit", {
      task: BOUND_TASK,
      message: "fix rendering",
    }),
    toolResult("toolu_bind", { success: true }),
  ];
}

/**
 * The final turn of the originating incident: a spec-patch writing evidence
 * into TARGET_TASK (not the bound task), tool-interleaved (the tool_result
 * user-role line falls INSIDE the turn — the mem a3e60471 fixture shape),
 * ending with no discharge call.
 */
function evidenceOnlyFinalTurn(): TranscriptLine[] {
  return [
    userPrompt("why did no retrospective fire on that correction?", "2026-08-03T23:00:00Z"),
    toolUse("toolu_patch", EVIDENCE_TOOL, {
      taskId: TARGET_TASK,
      content: "## Evidence\n\nRung-1 misses wrote no record.",
    }),
    toolResult("toolu_patch", { success: true }),
  ];
}

function incidentTranscript(extraFinalTurnLines: TranscriptLine[] = []): TranscriptLine[] {
  return [...bindingPrefix(), ...evidenceOnlyFinalTurn(), ...extraFinalTurnLines];
}

function ctxFor(lines: TranscriptLine[]): DispatchContext {
  return { transcriptLines: lines } as unknown as DispatchContext;
}

function inputWith(finalMessage: string): StopHookInput {
  return {
    session_id: "mt3653-test",
    last_assistant_message: finalMessage,
    cwd: process.cwd(),
  } as StopHookInput;
}

/** Slice the final turn out of a full transcript the way run() does. */
function finalTurnOf(lines: TranscriptLine[]): TranscriptLine[] {
  let lastPrompt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as TranscriptLine;
    const content = line.message?.content;
    if (line.type === "user" && typeof content === "string") lastPrompt = i;
  }
  return lines.slice(lastPrompt + 1);
}

describe("collectBoundTaskIds", () => {
  test("collects task ids from session-tool calls anywhere in the transcript", () => {
    expect(collectBoundTaskIds(incidentTranscript())).toEqual(new Set([BOUND_TASK]));
  });

  test("ignores non-session tools and non-task-shaped values", () => {
    const lines = [
      toolUse("t1", "mcp__minsky__tasks_status_set", { taskId: "mt#1" }),
      toolUse("t2", "mcp__minsky__session_start", { task: "not-a-task-id" }),
    ];
    expect(collectBoundTaskIds(lines)).toEqual(new Set());
  });
});

describe("detectDecisionStop (pure core)", () => {
  test("AT1 signature: evidence-write to a non-bound task, no discharge, no marker", () => {
    const full = incidentTranscript();
    const detection = detectDecisionStop(finalTurnOf(full), full, R5_FINAL_MESSAGE);
    expect(detection).not.toBeNull();
    expect(detection?.candidateTaskIds).toEqual([TARGET_TASK]);
    expect(detection?.suppressionReasons).toEqual([]);
  });

  test("returns null when the turn has no spec-patch at all", () => {
    const full = [...bindingPrefix(), userPrompt("status?"), toolUse("t", "Bash", {})];
    expect(detectDecisionStop(finalTurnOf(full), full, "all quiet")).toBeNull();
  });

  // AT2 — the same evidence-write turn, discharged. Each consumer call must silence it.
  test.each([
    ["mcp__minsky__asks_create", { question: "Rung-2 disposition?", parentTaskId: TARGET_TASK }],
    ["mcp__minsky__tasks_status_set", { taskId: TARGET_TASK, status: "READY" }],
    ["mcp__minsky__tasks_dispatch", { taskId: TARGET_TASK }],
    ["mcp__minsky__tasks_create", { title: "follow-up" }],
    ["Skill", { skill: "plan-task", args: TARGET_TASK }],
  ])("suppresses when the turn also called %s", (tool, input) => {
    const full = incidentTranscript([
      toolUse("toolu_discharge", tool as string, input as Record<string, unknown>),
    ]);
    const detection = detectDecisionStop(finalTurnOf(full), full, R5_FINAL_MESSAGE);
    expect(detection?.suppressionReasons.some((r) => r.startsWith("discharged:"))).toBe(true);
  });

  // AT3 — evidence into the conversation's OWN task is progress recording.
  test("suppresses when the spec-patch targets the bound task", () => {
    const full = [
      ...bindingPrefix(),
      userPrompt("record the outcome", "2026-08-03T23:30:00Z"),
      toolUse("toolu_own", EVIDENCE_TOOL, { taskId: BOUND_TASK, content: "## Outcome" }),
      toolResult("toolu_own", { success: true }),
    ];
    const detection = detectDecisionStop(finalTurnOf(full), full, R5_FINAL_MESSAGE);
    expect(detection?.candidateTaskIds).toEqual([]);
    expect(detection?.suppressionReasons).toContain("bound-task-target");
  });

  test("suppresses a working turn (code/session mutations beside the spec-patch)", () => {
    const full = incidentTranscript([
      toolUse("toolu_work", "mcp__minsky__session_write_file", { path: "src/x.ts" }),
    ]);
    const detection = detectDecisionStop(finalTurnOf(full), full, R5_FINAL_MESSAGE);
    expect(detection?.suppressionReasons).toContain("working-turn");
  });

  test("suppresses when the closing message carries a recommendation marker", () => {
    const full = incidentTranscript();
    const detection = detectDecisionStop(
      finalTurnOf(full),
      full,
      "Evidence recorded. My recommendation: escalate to Rung 3."
    );
    expect(detection?.suppressionReasons).toContain("recommendation-marker");
  });

  test("counts memory_create as evidence, not as discharge", () => {
    const full = incidentTranscript([
      toolUse("toolu_mem", EVIDENCE_COMPANION_TOOL, { name: "finding", content: "x" }),
    ]);
    const detection = detectDecisionStop(finalTurnOf(full), full, R5_FINAL_MESSAGE);
    expect(detection?.suppressionReasons).toEqual([]);
    expect(detection?.memoryCreateCount).toBe(1);
  });
});

describe("run — status filter, dedup, evaluation stream (AT1-AT3 end-to-end)", () => {
  let storeDir: string;
  let evaluations: Array<Record<string, unknown>>;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "mt3653-"));
    evaluations = [];
  });
  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  function depsWith(statusByTask: Record<string, string | undefined>): RunDeps {
    return {
      readTaskStatusFn: (taskId: string) => statusByTask[taskId],
      appendEvaluationRecordFn: (_cwd, record) => {
        evaluations.push(record);
      },
      storeDir,
    };
  }

  test("AT1: the originating incident produces one calibration record naming the target", () => {
    const outcome = run(
      inputWith(R5_FINAL_MESSAGE),
      ctxFor(incidentTranscript()),
      depsWith({ [TARGET_TASK]: "TODO" })
    );
    expect(outcome).not.toBeNull();
    expect(outcome?.additionalContext).toBeUndefined();
    const targets = outcome?.calibration?.["targets"] as Array<{ taskId: string; status: string }>;
    expect(targets).toEqual([{ taskId: TARGET_TASK, status: "TODO" }]);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.["fired"]).toBe(true);
  });

  test("AT2: an asks_create in the same turn produces no record, and the evaluation says why", () => {
    const outcome = run(
      inputWith(R5_FINAL_MESSAGE),
      ctxFor(incidentTranscript([toolUse("toolu_ask", "mcp__minsky__asks_create", {})])),
      depsWith({ [TARGET_TASK]: "TODO" })
    );
    expect(outcome).toBeNull();
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.["fired"]).toBe(false);
  });

  test("AT3: a spec-patch to the bound task produces no record", () => {
    const full = [
      ...bindingPrefix(),
      userPrompt("record the outcome", "2026-08-03T23:30:00Z"),
      toolUse("toolu_own", EVIDENCE_TOOL, { taskId: BOUND_TASK, content: "## Outcome" }),
      toolResult("toolu_own", { success: true }),
    ];
    const outcome = run(inputWith(R5_FINAL_MESSAGE), ctxFor(full), depsWith({}));
    expect(outcome).toBeNull();
    expect(evaluations[0]?.["suppressionReasons"]).toContain("bound-task-target");
  });

  test("a closed target suppresses (target-not-open); an unknown status fails open", () => {
    const closed = run(
      inputWith(R5_FINAL_MESSAGE),
      ctxFor(incidentTranscript()),
      depsWith({ [TARGET_TASK]: "DONE" })
    );
    expect(closed).toBeNull();
    expect(evaluations[0]?.["suppressionReasons"]).toContain("target-not-open");

    const unknown = run(
      inputWith(R5_FINAL_MESSAGE),
      ctxFor(incidentTranscript()),
      depsWith({ [TARGET_TASK]: undefined })
    );
    expect(unknown).not.toBeNull();
    const targets = unknown?.calibration?.["targets"] as Array<{ taskId: string; status: string }>;
    expect(targets).toEqual([{ taskId: TARGET_TASK, status: "unknown" }]);
  });

  test("dedup: a Stop re-entry for the same turn writes neither a second record nor a second evaluation", () => {
    const deps = depsWith({ [TARGET_TASK]: "TODO" });
    const first = run(inputWith(R5_FINAL_MESSAGE), ctxFor(incidentTranscript()), deps);
    expect(first).not.toBeNull();
    const second = run(inputWith(R5_FINAL_MESSAGE), ctxFor(incidentTranscript()), deps);
    expect(second).toBeNull();
    expect(evaluations).toHaveLength(1);
  });

  test("returns null (no evaluation write) on a turn with no spec-patch", () => {
    const full = [...bindingPrefix(), userPrompt("thanks"), toolUse("t", "Bash", {})];
    const outcome = run(inputWith("done"), ctxFor(full), depsWith({}));
    expect(outcome).toBeNull();
    expect(evaluations).toHaveLength(0);
  });
});
