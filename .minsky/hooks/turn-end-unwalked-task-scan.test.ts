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

/**
 * Named by both questions this guard asks and answered differently by each: any
 * status counts as a WALK, only IN-PROGRESS counts as a PRIMARY THREAD. Extracted
 * at mt#3784, when the primary-thread cases took its occurrences past the
 * duplication rule's threshold.
 */
const STATUS_SET_TOOL = "mcp__minsky__tasks_status_set";

/** The operator prompt the CLI-transport cases open on. */
const INCIDENT_PROMPT = "the cockpit isn't loading";

/** The CLI mint invocation, in its `--json` form. */
const CLI_CREATE_JSON = "bun src/cli.ts tasks create --title X --json";

/** The same invocation without `--json`, which prints a plain success line. */
const CLI_CREATE_BARE = "bun src/cli.ts tasks create --title X";

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
    [STATUS_SET_TOOL, { taskId: CREATED_ID, status: "PLANNING" }],
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
      toolUse("toolu_walk", STATUS_SET_TOOL, {
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
  //
  // mt#3784 narrowed the ILLUSTRATION, not the carve-out. The branch still names
  // claimed routing explicitly, which is mt#3699's actual criterion, and keeps
  // one of its two quoted examples; the second ("I'll dispatch these") was cut
  // for the ceiling, which the restructure left 15 chars of headroom on. Both
  // quotes plus the new awaiting-answer clause measured 619 against 620 — one
  // character, which a five-digit task id (three of them in the saturated
  // render) would have blown straight through. Cutting the redundant second
  // example was the cheapest thing available that did not cost a carve-out.
  test("names principal-claimed dispatch/routing as a valid end state", () => {
    const text = render(1);
    expect(text).toContain("claimed its dispatch/routing");
    expect(text).toContain("tell me what to farm out");
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
  // before it is told to walk. mt#3784 kept the ask-first shape and replaced
  // the "continue to /plan-task now" imperative with a WALK branch the agent has
  // to satisfy a condition to select.
  test("asks which branch holds before naming the walk action", () => {
    const closing = closingParagraph(1);
    expect(closing.startsWith("Say which holds")).toBe(true);
    expect(closing).toContain("WALK:");
    expect(closing).toContain("STOP:");
    // Pins the regression directly: the pre-mt#3699 text opened with the
    // incident-response imperative.
    expect(closing).not.toMatch(/^If this was incident response/);
  });

  // AT3 / SC1. The retired text inferred what the agent was ASKED TO DO from
  // where the problem was RAISED — "incident response — a problem raised or
  // found in this conversation — filing is not the deliverable". The advisory
  // must no longer carry that inference anywhere, and must say so outright,
  // because the inference is what an agent supplies unprompted when the text is
  // merely silent about it.
  test("does not infer the deliverable from where the problem was raised", () => {
    const text = render(1);
    expect(text).not.toContain("filing is not the deliverable");
    expect(text).not.toContain("incident response");
    expect(text).toContain("Where it was raised settles neither");
  });

  // AT1 / SC2. The originating incident's principal said "file a task to
  // investigate X" — the verb aimed at the AGENT was *file*. That end state has
  // to be selectable WITHOUT claiming the principal deferred the work or that
  // the task needs decomposition, which were the only escapes the old list
  // offered and neither of which was true.
  test("names request-scope — being asked only to file it — as an end state", () => {
    const closing = closingParagraph(1);
    expect(closing).toContain("you were asked to file it");
    expect(closing).toContain("file a task to");
    expect(closing).toContain("track this");
  });

  // SC3's fallback, chosen over detection. A turn that ends by asking the
  // principal how to route the task has handed them a decision, not stopped
  // silently — and the guard fires on tool-call state, so it cannot see that.
  test("names an unanswered routing question as a reason to wait", () => {
    expect(closingParagraph(1)).toContain("if you asked how to route it, wait");
  });

  // AT2 — the MIRROR failure, and the specific way a naive rewrite of this text
  // fails. Making the STOP branch safer must not make it easier to park work the
  // principal already approved: an ask answered in this conversation authorizes
  // the WORK and names filing only as its record-keeping step. It belongs under
  // WALK, on the same side as the blocking-correctness case.
  test("keeps an answered ask on the WALK side, not the STOP side", () => {
    const closing = closingParagraph(1);
    expect(closing).toContain("an ask answered here authorized the work");
    const walkAt = closing.indexOf("WALK:");
    const stopAt = closing.indexOf("STOP:");
    const askAt = closing.indexOf("an ask answered here");
    expect(walkAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(walkAt);
    // The clause sits between the two labels — i.e. inside WALK, not STOP.
    expect(askAt).toBeGreaterThan(walkAt);
    expect(askAt).toBeLessThan(stopAt);
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
        bash("toolu_b", CLI_CREATE_BARE),
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
        bash("toolu_j", CLI_CREATE_BARE),
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

/**
 * Multi-backend id coverage (PR #2645 R1).
 *
 * The first cut pinned both CLI regexes to `mt#`. The MCP path reads ids from a
 * PARAM, so it covers every backend prefix for free; pinning the CLI path to
 * one prefix would have left the two transports covering different id-spaces —
 * a narrower instance of the defect this guard's widening exists to fix.
 */
describe("detectUnwalkedTasks — multi-backend ids over the CLI transport", () => {
  function bash(id: string, command: string): TranscriptLine {
    return toolUse(id, "Bash", { command });
  }
  const ids = (lines: TranscriptLine[]): string[] =>
    detectUnwalkedTasks(lines).map((u) => u.taskId);

  test.each([["md#283"], ["gh#123"]])("flags an unwalked %s minted over the CLI", (taskId) => {
    expect(
      ids([
        userPrompt(INCIDENT_PROMPT),
        bash("toolu_m", CLI_CREATE_JSON),
        toolResult("toolu_m", { success: true, taskId }),
      ])
    ).toEqual([taskId]);
  });

  test.each([["md#283"], ["gh#123"]])("a CLI walk on %s suppresses the fire", (taskId) => {
    expect(
      ids([
        userPrompt(INCIDENT_PROMPT),
        bash("toolu_n", CLI_CREATE_JSON),
        toolResult("toolu_n", { success: true, taskId }),
        bash("toolu_o", `bun src/cli.ts tasks status set ${taskId} PLANNING`),
        toolResult("toolu_o", { success: true }),
      ])
    ).toEqual([]);
  });

  test("the bare-output success line is read for a non-mt backend too", () => {
    expect(
      ids([
        userPrompt(INCIDENT_PROMPT),
        bash("toolu_p", CLI_CREATE_BARE),
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_p",
                content: "✅ Task gh#123 created successfully",
              },
            ],
          },
        } as TranscriptLine,
      ])
    ).toEqual(["gh#123"]);
  });
});

describe("the primary-thread branch (mt#3784)", () => {
  let storeDir: string;
  let sessionCounter = 0;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "mt3784-"));
  });
  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  const PRIMARY = "mt#4502";
  const SIDE_FINDING = "mt#4512";

  /**
   * The 2026-08-24 incident's shape, and the one a final-turn implementation
   * cannot see: the conversation opened a session on the primary task and
   * created its PR in EARLIER turns, then a later turn filed a side-finding and
   * ended. `extractFinalTurn` slices at the last real user prompt, so everything
   * before `laterPrompt` is invisible to every turn-scoped read in this guard.
   */
  function conversationWithEarlierPrimaryWork(): TranscriptLine[] {
    return [
      userPrompt("the ingest is running behind"),
      toolUse("toolu_start", SESSION_START_TOOL, { task: PRIMARY }),
      toolResult("toolu_start", { success: true }),
      toolUse("toolu_pr", "mcp__minsky__session_pr_create", { task: PRIMARY }),
      toolResult("toolu_pr", { success: true }),
      userPrompt("what did the retrospective turn up?"),
      toolUse("toolu_side", MINTING_TOOL, { title: "Skill text addition" }),
      toolResult("toolu_side", { success: true, taskId: SIDE_FINDING }),
    ];
  }

  function render(lines: TranscriptLine[]): string {
    const input = {
      session_id: `mt3784-test-${sessionCounter++}`,
      last_assistant_message: "filed it",
    } as StopHookInput;
    const text = run(input, ctxFor(lines), storeDir)?.additionalContext;
    if (typeof text !== "string") throw new Error("guard produced no advisory text");
    return text;
  }

  // THE regression test for this task. A final-turn-scoped implementation
  // passes every other test in this file and fails this one — which is exactly
  // what happened to the mechanism the spec originally proposed. Replayed
  // against 210 real fires, the final-turn window found this signal in 34% of
  // them and in NEITHER of the two fires from the incident above; the
  // whole-conversation window found it in 76% and in both.
  test("detects a primary thread established in an EARLIER turn", () => {
    const text = render(conversationWithEarlierPrimaryWork());
    expect(text).toContain(`while ${PRIMARY} is this conversation's active thread`);
    expect(text).toContain(`keep working ${PRIMARY} and surface this at the close for routing`);
    expect(text).toContain(`  - ${SIDE_FINDING}`);
  });

  // The inversion itself. On this branch the guard must NOT ask the agent to
  // pick between walking and stopping — it asserts the default the principal
  // named, and puts the burden of argument on walking instead.
  test("asserts continue-and-surface as the default, not a choice to justify", () => {
    const text = render(conversationWithEarlierPrimaryWork());
    expect(text).toContain("Default: keep working");
    expect(text).toContain("Walk it now only if you can name which holds");
    // The open branch's ask-which-holds framing must not leak into this one.
    expect(text).not.toContain("Say which holds");
    expect(text).not.toContain("STOP:");
  });

  // The prose/doc corollary settles the originating case on its own, so it has
  // to survive in the rendered text rather than living only in the docblock.
  test("names the prose/doc corollary on the walk test", () => {
    expect(render(conversationWithEarlierPrimaryWork())).toContain(
      "A prose/doc fix meets neither: you already hold the lesson"
    );
  });

  // Without a primary thread the guard falls back to the two-way branch, so a
  // conversation whose only task activity is this turn's mint reads as the open
  // case. This is the 24% the detector cannot classify.
  test("falls back to the open branch when no other task is in play", () => {
    const text = render([
      userPrompt("something looks off in the parser"),
      toolUse("toolu_only", MINTING_TOOL, { title: "Parser defect" }),
      toolResult("toolu_only", { success: true, taskId: SIDE_FINDING }),
    ]);
    expect(text).toContain("ended the turn with no status/session/dispatch/ask call");
    expect(text).toContain("Say which holds");
    expect(text).not.toContain("active thread");
  });

  // A task minted THIS turn is the new work, not a pre-existing thread — so a
  // turn that files two tasks and starts a session on one must not describe the
  // just-minted id as the conversation's established thread when it is itself
  // one of the ids being reported.
  test("never names a reported task as the conversation's own primary thread", () => {
    const text = render([
      userPrompt("file these"),
      toolUse("toolu_a", MINTING_TOOL, { title: "a" }),
      toolResult("toolu_a", { success: true, taskId: SIDE_FINDING }),
      toolUse("toolu_self", SESSION_START_TOOL, { task: SIDE_FINDING }),
      toolResult("toolu_self", { success: true }),
      toolUse("toolu_b", MINTING_TOOL, { title: "b" }),
      toolResult("toolu_b", { success: true, taskId: "mt#4513" }),
    ]);
    // mt#4512 was minted AND walked, so only mt#4513 is reported — and mt#4512
    // is a legitimate active thread for it, having been session-started here.
    expect(text).toContain("  - mt#4513");
    expect(text).not.toContain("  - mt#4512");
    expect(text).toContain(`while ${SIDE_FINDING} is this conversation's active thread`);
  });

  // PLANNING is a walk for this guard (mt#4228) but is NOT evidence of an
  // active thread — somebody starting to plan a task is not a conversation
  // working one. The two questions read the same tool and diverge here.
  test("a PLANNING transition on another task is not a primary thread", () => {
    const text = render([
      userPrompt("look at this"),
      toolUse("toolu_plan", STATUS_SET_TOOL, {
        taskId: PRIMARY,
        status: "PLANNING",
      }),
      toolResult("toolu_plan", { success: true }),
      toolUse("toolu_mint2", MINTING_TOOL, { title: "side" }),
      toolResult("toolu_mint2", { success: true, taskId: SIDE_FINDING }),
    ]);
    expect(text).not.toContain("active thread");
    expect(text).toContain("Say which holds");
  });

  // IN-PROGRESS, by contrast, IS the thread signal — same tool, different status.
  test("an IN-PROGRESS transition on another task IS a primary thread", () => {
    const text = render([
      userPrompt("look at this"),
      toolUse("toolu_ip", STATUS_SET_TOOL, {
        taskId: PRIMARY,
        status: "IN-PROGRESS",
      }),
      toolResult("toolu_ip", { success: true }),
      toolUse("toolu_mint3", MINTING_TOOL, { title: "side" }),
      toolResult("toolu_mint3", { success: true, taskId: SIDE_FINDING }),
    ]);
    expect(text).toContain(`while ${PRIMARY} is this conversation's active thread`);
  });

  // The calibration record carries the classification so a future tuning pass
  // can measure branch distribution without replaying transcripts by hand,
  // which is what this task's own planning pass had to do.
  test("records the detected primary thread on the calibration record", () => {
    const input = {
      session_id: `mt3784-calib-${sessionCounter++}`,
      last_assistant_message: "filed it",
    } as StopHookInput;
    const outcome = run(input, ctxFor(conversationWithEarlierPrimaryWork()), storeDir);
    expect(outcome?.calibration?.["primaryThreadIds"]).toContain(PRIMARY);
  });
});
