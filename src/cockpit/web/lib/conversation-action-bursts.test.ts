/**
 * Action-burst grouping and summary tests (mt#4250).
 *
 * The grouping pass is pure and returns a plain data structure, so everything
 * the spec's acceptance tests ask about the RULE is asserted here directly
 * rather than through a rendered DOM. The render-level half — that a fold
 * actually hides its rows and gives them back on click — lives in
 * `widgets/ConversationView.action-burst.test.tsx`, because that is a claim
 * about the component, not about this function.
 */
import { describe, test, expect } from "bun:test";
import {
  MIN_BURST_TURNS,
  groupActionBursts,
  summarizeBurst,
  turnIsFoldable,
} from "./conversation-action-bursts";
import type { PreparedElement } from "../components/ConversationElementRenderers";
import type { PreparedTurn } from "./conversation-turn-assembly";

let seq = 0;

function ts(secondsFromStart: number): string {
  return new Date(Date.UTC(2026, 7, 18, 12, 0, secondsFromStart)).toISOString();
}

function turn(elements: PreparedElement[], overrides: Partial<PreparedTurn> = {}): PreparedTurn {
  seq += 1;
  return {
    blockId: `block-${seq}`,
    role: "assistant",
    timestamp: ts(seq),
    elements,
    isSpawnBoundary: false,
    ...overrides,
  };
}

function toolCall(name: string, id = `call-${++seq}`): PreparedElement {
  return {
    kind: "tool-invocation",
    call: { kind: "tool-call", id, name, input: {} },
  } as PreparedElement;
}

function failedToolCall(name: string, id = `call-${++seq}`): PreparedElement {
  return {
    kind: "tool-invocation",
    call: { kind: "tool-call", id, name, input: {} },
    result: { kind: "tool-result", toolUseId: id, content: "boom", isError: true },
  } as PreparedElement;
}

function thinking(): PreparedElement {
  return { kind: "thinking", thinking: "considering the options" };
}

function prose(text = "Reading the auth module now."): PreparedElement {
  return { kind: "text", text };
}

// Named rather than repeated inline: these two are the read-only tools the
// summary tests lean on, and a typo in one copy would silently change what the
// classifier returns — `classifyTool` answers `unclassified` for an unknown
// name, so the test would still pass while asserting something else.
const READ_TOOL = "mcp__minsky__tasks_get";
const OTHER_READ_TOOL = "mcp__minsky__git_log";

/** Every turn the grouping returned, in order — the losslessness witness. */
function flatten(nodes: ReturnType<typeof groupActionBursts>): PreparedTurn[] {
  return nodes.flatMap((node) => (node.kind === "turn" ? [node.turn] : node.turns));
}

describe("groupActionBursts (mt#4250)", () => {
  test("folds a stretch of machinery turns between two speech blocks", () => {
    const turns = [
      turn([prose("Starting.")]),
      turn([thinking()]),
      turn([toolCall("Read")]),
      turn([toolCall("Bash")]),
      turn([toolCall("Grep")]),
      turn([toolCall("Read")]),
      turn([toolCall("Bash")]),
      turn([prose("Done.")]),
    ];

    const nodes = groupActionBursts(turns);

    expect(nodes.map((n) => n.kind)).toEqual(["turn", "burst", "turn"]);
    const burst = nodes[1];
    if (burst?.kind !== "burst") throw new Error("expected a burst");
    expect(burst.turns).toHaveLength(6);
  });

  test("is lossless: the grouped turns concatenate back to the input, in order", () => {
    const turns = [
      turn([prose()]),
      turn([thinking()]),
      turn([toolCall("Read")]),
      turn([toolCall("Bash")]),
      turn([failedToolCall("Bash")]),
      turn([toolCall("Read")]),
      turn([toolCall("Read")]),
      turn([toolCall("Grep")]),
      turn([prose()]),
    ];

    const flat = flatten(groupActionBursts(turns));

    expect(flat.map((t) => t.blockId)).toEqual(turns.map((t) => t.blockId));
  });

  test("a failure splits the burst instead of hiding inside it", () => {
    const turns = [
      turn([toolCall("Read")]),
      turn([toolCall("Read")]),
      turn([toolCall("Read")]),
      turn([failedToolCall("Bash")]),
      turn([toolCall("Read")]),
      turn([toolCall("Read")]),
      turn([toolCall("Read")]),
    ];

    const nodes = groupActionBursts(turns);

    // burst, the error on its own, burst — never one burst spanning the error.
    expect(nodes.map((n) => n.kind)).toEqual(["burst", "turn", "burst"]);
    const failed = nodes[1];
    if (failed?.kind !== "turn") throw new Error("expected the failure to stand alone");
    expect(failed.turn.elements[0]).toMatchObject({ kind: "tool-invocation" });
  });

  test(`a stretch shorter than ${MIN_BURST_TURNS} turns does not fold`, () => {
    const turns = [turn([toolCall("Read")]), turn([toolCall("Bash")])];

    const nodes = groupActionBursts(turns);

    expect(nodes.map((n) => n.kind)).toEqual(["turn", "turn"]);
  });

  test("a spawn is never folded away", () => {
    const turns = [
      turn([toolCall("Read")]),
      turn([toolCall("Read")]),
      turn([toolCall("Task")], { isSpawnBoundary: true, spawnAgentKind: "general-purpose" }),
      turn([toolCall("Read")]),
      turn([toolCall("Read")]),
    ];

    const nodes = groupActionBursts(turns);
    const spawnNode = nodes.find((n) => n.kind === "turn" && n.turn.isSpawnBoundary === true);

    expect(spawnNode).toBeDefined();
  });

  test("prose is never folded away", () => {
    const turns = [
      turn([toolCall("Read")]),
      turn([toolCall("Read")]),
      turn([prose("A sentence the reader came for.")]),
      turn([toolCall("Read")]),
      turn([toolCall("Read")]),
    ];

    const flat = flatten(groupActionBursts(turns));
    const proseNode = groupActionBursts(turns).find(
      (n) => n.kind === "turn" && n.turn.elements.some((e) => e.kind === "text")
    );

    expect(proseNode).toBeDefined();
    expect(flat).toHaveLength(5);
  });

  test("a turn holding both prose and a tool call stays out of the fold", () => {
    const mixed = turn([prose("Here is what I found."), toolCall("Read")]);
    expect(turnIsFoldable(mixed)).toBe(false);
  });

  test("the standalone tools keep their own row", () => {
    for (const name of ["WebSearch", "WebFetch", "Skill"]) {
      expect(turnIsFoldable(turn([toolCall(name)]))).toBe(false);
    }
    // Contrast: an ordinary tool of the same shape does fold.
    expect(turnIsFoldable(turn([toolCall("Read")]))).toBe(true);
  });

  test("a user turn is never foldable", () => {
    expect(turnIsFoldable(turn([toolCall("Read")], { role: "user" }))).toBe(false);
  });

  test("a compaction boundary is never foldable", () => {
    expect(turnIsFoldable(turn([toolCall("Read")], { isCompactSummary: true }))).toBe(false);
  });
});

describe("summarizeBurst (mt#4250)", () => {
  test("counts match the actions actually in the burst", () => {
    const turns = [
      turn([thinking()]),
      turn([toolCall("Read")]),
      turn([toolCall("Read")]),
      turn([toolCall("Bash")]),
      turn([toolCall("Grep")]),
    ];

    const summary = summarizeBurst(turns);

    expect(summary).toContain("thought");
    expect(summary).toContain("read 2 files");
    expect(summary).toContain("ran 1 shell command");
    expect(summary).toContain("searched 1 time");
  });

  test("singular and plural are not the same string", () => {
    const one = summarizeBurst([turn([toolCall("Read")])]);
    const many = summarizeBurst([turn([toolCall("Read")]), turn([toolCall("Read")])]);

    expect(one).toContain("read 1 file");
    expect(many).toContain("read 2 files");
  });

  test("NAMES mutating MCP tools and reduces reads to a count (mt#3845 SC6)", () => {
    const turns = [
      turn([toolCall(READ_TOOL)]), // reads
      turn([toolCall("mcp__minsky__tasks_spec_patch")]), // mutates
      turn([toolCall(OTHER_READ_TOOL)]), // reads
    ];

    const summary = summarizeBurst(turns);

    // The deviation from the reference terminal: it renders "called minsky",
    // which is exactly what SC6 names as discarding "which tool ran" — and
    // `tasks_spec_patch mt#3842` is SC6's own example of what a supervisor
    // needs to see.
    expect(summary).toContain("tasks_spec_patch");
    // Reads carry no such claim on the reader's attention; they become a number.
    expect(summary).toContain("2 reads");
    expect(summary).not.toContain("tasks_get");
  });

  test("a mutation is NAMED however many reads surround it — no cap can drop it", () => {
    // Regression guard for PR #3125 R1. The first implementation named up to
    // three distinct tools by parsing, so a burst with four or more could push
    // the mutation past the cap while reads survived — the exact inversion of
    // what SC6 asks for. The mutation here is deliberately LAST.
    const turns = [
      turn([toolCall(READ_TOOL)]),
      turn([toolCall(OTHER_READ_TOOL)]),
      turn([toolCall("mcp__minsky__memory_search")]),
      turn([toolCall("mcp__minsky__tasks_list")]),
      turn([toolCall("mcp__minsky__session_commit")]), // mutates
    ];

    const summary = summarizeBurst(turns);

    expect(summary).toContain("session_commit");
  });

  test("every mutation is named, not just the first", () => {
    const turns = [
      turn([toolCall("mcp__minsky__tasks_spec_patch")]),
      turn([toolCall("mcp__minsky__tasks_status_set")]),
      turn([toolCall("mcp__minsky__session_commit")]),
    ];

    const summary = summarizeBurst(turns);

    expect(summary).toContain("tasks_spec_patch");
    expect(summary).toContain("tasks_status_set");
    expect(summary).toContain("session_commit");
  });

  test("an UNCLASSIFIED tool is named, never silently counted as a read", () => {
    // `classifyTool`'s contract is that unknown is never coerced into a
    // positive verdict. Rendering it as a read would be that coercion, and
    // would hide a tool that may well mutate.
    const summary = summarizeBurst([
      turn([toolCall("mcp__minsky__some_unregistered_tool")]),
      turn([toolCall(READ_TOOL)]),
      turn([toolCall(OTHER_READ_TOOL)]),
    ]);

    expect(summary).toContain("some_unregistered_tool");
    expect(summary).toContain("2 reads");
  });

  test("leads with the burst's own elapsed span", () => {
    const a = turn([toolCall("Read")], { timestamp: ts(0) });
    const b = turn([toolCall("Read")], { timestamp: ts(30) });

    expect(summarizeBurst([a, b])).toMatch(/^30s · /);
  });

  test("omits the span when it rounds to nothing rather than rendering 0s", () => {
    const a = turn([toolCall("Read")], { timestamp: ts(0) });
    const b = turn([toolCall("Read")], { timestamp: ts(0) });

    expect(summarizeBurst([a, b])).not.toContain("0s");
  });
});
