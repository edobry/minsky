/* eslint-disable custom/no-real-fs-in-tests -- the dedup store (turn-end-scan-store.ts) writes real per-session JSON files; these tests exercise the real store roundtrip (write -> dedup-read) in an isolated mkdtemp dir, mirroring turn-end-untaken-action-scan.test.ts's precedent */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectUnwalkedTasks,
  run,
  MINTING_TOOL,
  MAX_LISTED_IDS,
} from "./turn-end-unwalked-task-scan";
import type { TranscriptLine } from "./transcript";
import type { DispatchContext } from "./registry";
import { GUARD_REGISTRY } from "./registry";
import type { StopHookInput } from "./turn-end-retro-scan";

const CREATED_ID = "mt#9999";

/** A walk-forward tool named by more than one case. */
const SESSION_START_TOOL = "mcp__minsky__session_start";

/** The operator prompt the CLI-transport cases open on. */
const INCIDENT_PROMPT = "the cockpit isn't loading";

/** The CLI mint invocation, in its `--json` form. */
const CLI_CREATE_JSON = "bun src/cli.ts tasks create --title X --json";

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
    userPrompt(INCIDENT_PROMPT),
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
    [SESSION_START_TOOL, { task: CREATED_ID }],
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
      toolUse("toolu_walk", SESSION_START_TOOL, { task: "mt#1" }),
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

/** A turn that mints `n` tasks and walks none of them. */
function turnThatFiles(n: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [userPrompt("file these")];
  for (let i = 0; i < n; i++) {
    lines.push(toolUse(`toolu_${i}`, MINTING_TOOL, { title: `t${i}` }));
    lines.push(toolResult(`toolu_${i}`, { success: true, taskId: `mt#${9000 + i}` }));
  }
  return lines;
}

describe("the injected guidance text (mt#3699)", () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "mt3699-"));
  });
  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  function render(taskCount: number): string {
    const outcome = run(inputWith("filed them"), ctxFor(turnThatFiles(taskCount)), storeDir);
    const text = outcome?.additionalContext;
    if (typeof text !== "string") throw new Error("guard produced no advisory text");
    return text;
  }

  /** The closing paragraph — pushed as one element, so it is the last line. */
  function closingParagraph(taskCount: number): string {
    return render(taskCount).split("\n").at(-1) ?? "";
  }

  // The carve-out must name the shape that caused mt#3699: the principal has
  // claimed ROUTING of the filed work. That is not a deferral of the WORK, so
  // it had no branch to land in before this.
  test("names principal-claimed dispatch/routing as a valid end state", () => {
    const text = render(1);
    expect(text).toContain("has claimed its dispatch/routing");
    expect(text).toContain("tell me what to farm out");
    expect(text).toContain("I'll dispatch these");
  });

  // A single-task fire is the common case in the calibration log, so the
  // header has to read correctly there and not only in the multi-id case that
  // motivated the wording (PR #2628 R1).
  test.each([
    [1, "You filed this and"],
    [2, "You filed these and"],
  ])("agrees in number when the turn minted %i task(s)", (count, expected) => {
    expect(render(count as number)).toContain(expected as string);
  });

  // The walk imperative keeps full force (that is the R4 containment this guard
  // shipped for) but must not LEAD — the agent is asked which branch holds
  // before it is told to walk.
  test("asks which branch holds before naming the walk action", () => {
    const closing = closingParagraph(1);
    expect(closing.startsWith("Say in one line which holds")).toBe(true);
    expect(closing).toContain("continue to /plan-task now");
    // Pins the regression directly: the pre-mt#3699 text opened with the
    // incident-response imperative.
    expect(closing).not.toMatch(/^If this was incident response/);
  });

  // The budget. The registry canary is a ONE-task fire, so
  // `guard-feedback-shape.test.ts` never renders the multi-task case — which is
  // exactly where the ceiling is tight, and where the originating incident sat
  // (a five-id fire). Pin the worst case here, reading the declared ceiling
  // from the registry so the number cannot drift out of sync with it.
  test("the worst-case render stays inside the declared attentionCost ceiling", () => {
    const declared = GUARD_REGISTRY.find((r) => r.name === "turn-end-unwalked-task-scan")
      ?.attentionCost?.denialMessageSizeChars;
    expect(declared).toBeGreaterThan(0);

    // MAX_LISTED_IDS named ids plus the "…and N more" overflow line is the
    // largest this message can ever be.
    const text = render(MAX_LISTED_IDS + 2);
    expect(text).toContain("…and 2 more");
    expect(text.length).toBeLessThanOrEqual(declared as number);
  });
});

/**
 * CLI-transport coverage (mt#3730).
 *
 * The guard originally keyed on `MINTING_TOOL` alone, so a task filed with
 * `bun src/cli.ts tasks create` — a `Bash` tool_use — was invisible to it.
 * That is the path an agent takes when the MCP daemon is down, which made the
 * blind spot anti-correlated with the risk: R5 of `family:stop-at-handoff`
 * ran it one day after mt#3536 shipped as the family's R4 fix.
 */
describe("detectUnwalkedTasks — CLI transport", () => {
  /** A `Bash` tool_use, the shape a CLI invocation actually arrives as. */
  function bash(id: string, command: string): TranscriptLine {
    return toolUse(id, "Bash", { command });
  }

  /**
   * A tool_result carrying RAW text rather than JSON — what the CLI prints
   * without `--json`. Distinct from `toolResult`, which stringifies a payload.
   */
  function toolResultText(useId: string, text: string): TranscriptLine {
    return {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: useId, content: text }],
      },
    };
  }

  const ids = (lines: TranscriptLine[]): string[] =>
    detectUnwalkedTasks(lines).map((u) => u.taskId);

  test("a CLI mint with --json is detected", () => {
    expect(
      ids([
        userPrompt(INCIDENT_PROMPT),
        bash("toolu_a", CLI_CREATE_JSON),
        toolResult("toolu_a", { success: true, taskId: CREATED_ID }),
      ])
    ).toEqual([CREATED_ID]);
  });

  test("a CLI mint WITHOUT --json is detected from its success line", () => {
    // Both output shapes occur in real turns; reading only the JSON one would
    // reproduce this guard's original defect one layer down.
    expect(
      ids([
        userPrompt(INCIDENT_PROMPT),
        bash("toolu_b", "bun src/cli.ts tasks create --title X"),
        toolResultText(
          "toolu_b",
          `✅ Task ${CREATED_ID} created successfully\n  ID: ${CREATED_ID}`
        ),
      ])
    ).toEqual([CREATED_ID]);
  });

  test("a CLI walk on the minted id suppresses the fire", () => {
    // Shipping the mint half alone would make the guard fire on tasks that
    // WERE walked — a false-positive class it does not have today.
    expect(
      ids([
        userPrompt(INCIDENT_PROMPT),
        bash("toolu_c", CLI_CREATE_JSON),
        toolResult("toolu_c", { success: true, taskId: CREATED_ID }),
        bash("toolu_d", `bun src/cli.ts tasks status set ${CREATED_ID} PLANNING`),
        toolResult("toolu_d", { success: true }),
      ])
    ).toEqual([]);
  });

  test("the two transports interoperate: a CLI mint walked via MCP is suppressed", () => {
    expect(
      ids([
        userPrompt(INCIDENT_PROMPT),
        bash("toolu_e", CLI_CREATE_JSON),
        toolResult("toolu_e", { success: true, taskId: CREATED_ID }),
        toolUse("toolu_f", SESSION_START_TOOL, { task: CREATED_ID }),
        toolResult("toolu_f", { success: true }),
      ])
    ).toEqual([]);
  });

  test("a read that merely NAMES a task id is not a mint", () => {
    expect(
      ids([
        userPrompt("what's the status"),
        bash("toolu_g", `bun src/cli.ts tasks get ${CREATED_ID}`),
        toolResult("toolu_g", { success: true, taskId: CREATED_ID }),
      ])
    ).toEqual([]);
  });

  test("a git commit naming a task id is not a mint", () => {
    expect(
      ids([
        userPrompt("commit that"),
        bash("toolu_h", `git commit -m "fix(${CREATED_ID}): widen the detector"`),
        toolResultText("toolu_h", "[main abc1234] fix"),
      ])
    ).toEqual([]);
  });

  test("a FAILED CLI mint minted nothing, so there is nothing to walk", () => {
    expect(
      ids([
        userPrompt("file it"),
        bash("toolu_i", CLI_CREATE_JSON),
        toolResult("toolu_i", { success: false, error: "backend unavailable" }),
      ])
    ).toEqual([]);
  });

  test("a failed bare-output CLI mint prints no success line, so nothing is read", () => {
    expect(
      ids([
        userPrompt("file it"),
        bash("toolu_j", "bun src/cli.ts tasks create --title X"),
        toolResultText("toolu_j", "error: backend unavailable"),
      ])
    ).toEqual([]);
  });

  test("the same id minted on both transports is reported once", () => {
    expect(
      ids([
        userPrompt("file it"),
        toolUse("toolu_k", MINTING_TOOL, { title: "X" }),
        toolResult("toolu_k", { success: true, taskId: CREATED_ID }),
        bash("toolu_l", CLI_CREATE_JSON),
        toolResult("toolu_l", { success: true, taskId: CREATED_ID }),
      ])
    ).toEqual([CREATED_ID]);
  });
});
