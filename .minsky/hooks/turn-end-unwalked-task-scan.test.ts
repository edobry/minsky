/* eslint-disable custom/no-real-fs-in-tests -- the dedup store (turn-end-scan-store.ts) writes real per-session JSON files; these tests exercise the real store roundtrip (write -> dedup-read) in an isolated mkdtemp dir, mirroring turn-end-untaken-action-scan.test.ts's precedent */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectUnwalkedTasks, run, MINTING_TOOL } from "./turn-end-unwalked-task-scan";
import type { TranscriptLine } from "./transcript";
import type { DispatchContext } from "./registry";
import type { StopHookInput } from "./turn-end-retro-scan";

const CREATED_ID = "mt#9999";

/**
 * A real user prompt — the boundary `extractFinalTurn` slices on. Everything
 * after it is the completed turn.
 */
function userPrompt(text: string): TranscriptLine {
  return { type: "user", message: { role: "user", content: text } };
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  };
}

/**
 * A tool_result line. User-role by construction (that is the real transcript
 * shape) but NOT a real user prompt — its content is a tool_result block, not
 * a text block — so it falls inside the turn rather than splitting it.
 */
function toolResult(useId: string, payload: unknown): TranscriptLine {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: useId, content: JSON.stringify(payload) }],
    },
  };
}

/** A turn that mints a task id and does nothing further with it. */
function turnThatFilesATask(): TranscriptLine[] {
  return [
    userPrompt("the cockpit isn't loading"),
    toolUse("toolu_mint", MINTING_TOOL, { title: "Cockpit daemon crash-loops" }),
    toolResult("toolu_mint", { success: true, taskId: CREATED_ID }),
  ];
}

function ctxFor(lines: TranscriptLine[]): DispatchContext {
  return { transcriptLines: lines } as unknown as DispatchContext;
}

function inputWith(finalMessage: string): StopHookInput {
  return {
    session_id: "mt3536-test",
    last_assistant_message: finalMessage,
  } as StopHookInput;
}

describe("detectUnwalkedTasks", () => {
  // AT1 — the R4 shape: a task minted, nothing done with it.
  test("flags a task minted with no walk-forward call", () => {
    const unwalked = detectUnwalkedTasks(turnThatFilesATask());
    expect(unwalked).toEqual([{ taskId: CREATED_ID }]);
  });

  // AT2 — the same turn, walked. Must be silent.
  test.each([
    ["mcp__minsky__tasks_status_set", { taskId: CREATED_ID, status: "PLANNING" }],
    ["mcp__minsky__session_start", { task: CREATED_ID }],
    ["mcp__minsky__tasks_dispatch", { taskId: CREATED_ID }],
    ["mcp__minsky__asks_create", { parentTaskId: CREATED_ID, question: "which approach?" }],
  ])("stays silent when the turn walked the task via %s", (tool, input) => {
    const lines = [
      ...turnThatFilesATask(),
      toolUse("toolu_walk", tool as string, input as Record<string, unknown>),
    ];
    expect(detectUnwalkedTasks(lines)).toEqual([]);
  });

  test("stays silent when the tasks_create errored — nothing was minted", () => {
    const lines = [
      userPrompt("file something"),
      toolUse("toolu_mint", MINTING_TOOL, { title: "x" }),
      toolResult("toolu_mint", { success: false, error: "validation failed" }),
    ];
    expect(detectUnwalkedTasks(lines)).toEqual([]);
  });

  test("walking a DIFFERENT task does not excuse the unwalked one", () => {
    const lines = [
      ...turnThatFilesATask(),
      toolUse("toolu_walk", "mcp__minsky__tasks_status_set", {
        taskId: "mt#1111",
        status: "PLANNING",
      }),
    ];
    expect(detectUnwalkedTasks(lines)).toEqual([{ taskId: CREATED_ID }]);
  });

  test("flags each unwalked task when a turn mints several", () => {
    const lines = [
      userPrompt("file both of these"),
      toolUse("toolu_a", MINTING_TOOL, { title: "a" }),
      toolResult("toolu_a", { success: true, taskId: "mt#1" }),
      toolUse("toolu_b", MINTING_TOOL, { title: "b" }),
      toolResult("toolu_b", { success: true, taskId: "mt#2" }),
      toolUse("toolu_walk", "mcp__minsky__session_start", { task: "mt#1" }),
    ];
    expect(detectUnwalkedTasks(lines)).toEqual([{ taskId: "mt#2" }]);
  });
});

describe("run — phrase independence and dedup", () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "mt3536-"));
  });
  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  // AT3 — the load-bearing property. This guard exists because the phrase-keyed
  // sibling could not see the R4 stop. Its verdict must not move when the
  // message text changes, in EITHER direction.
  test.each([
    [
      "names no next action at all (the R4 shape)",
      "Filed as mt#9999. The daemon is crash-looping.",
    ],
    ["explicitly announces the walk", "I'm taking mt#9999 forward now — that's the next step."],
    ["is empty", ""],
  ])("fires identically when the final message %s", (_label, finalMessage) => {
    const outcome = run(inputWith(finalMessage), ctxFor(turnThatFilesATask()), storeDir);
    expect(outcome?.additionalContext).toContain("[turn-end-unwalked-task]");
    expect(outcome?.additionalContext).toContain(CREATED_ID);
  });

  test("dedups the same task across a re-entered Stop", () => {
    const first = run(inputWith("filed it"), ctxFor(turnThatFilesATask()), storeDir);
    expect(first?.additionalContext).toBeDefined();

    const second = run(inputWith("filed it"), ctxFor(turnThatFilesATask()), storeDir);
    expect(second).toBeNull();
  });

  test("records a live calibration entry naming the unwalked ids", () => {
    const outcome = run(inputWith("filed it"), ctxFor(turnThatFilesATask()), storeDir);
    expect(outcome?.calibration?.["source"]).toBe("live");
    expect(outcome?.calibration?.["unwalkedTaskIds"]).toEqual([CREATED_ID]);
  });

  test("returns null when the transcript holds no resolvable turn", () => {
    expect(run(inputWith("hi"), ctxFor([]), storeDir)).toBeNull();
  });
});
