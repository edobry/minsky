/**
 * Tests for rewind detection (mt#3323).
 *
 * The load-bearing case is AT1/AT2: a parallel tool batch forks the parentUuid
 * tree at every call site with BOTH forks live (4,187 such branch points across
 * 207 local transcripts, vs 25 genuine rewinds). A detector that fires on
 * generic branching would delete real tool results, so the parallel-tool-call
 * cases here are regression guards, not edge cases.
 */

import { describe, expect, test } from "bun:test";

import {
  applyAbandonedBlockIds,
  computeAbandonedBlockIds,
  markAbandonedRewindBranches,
  isOperatorPrompt,
} from "./rewind-detection";
import type { SessionContextSnapshotBlock } from "../context/types";

let clock = 0;

/** Build a turn block. `content` mirrors the JSONL line's inner `message`. */
function block(
  uuid: string,
  parentUuid: string | undefined,
  rawJsonlType: "user" | "assistant" | "attachment",
  content: unknown,
  timestamp?: string
): SessionContextSnapshotBlock {
  clock += 1;
  return {
    id: `s:turn:${uuid}`,
    type: rawJsonlType === "assistant" ? "assistant-text" : "user-prompt",
    source: "observed",
    content,
    ...(uuid === "" ? {} : { uuid }),
    parentUuid,
    timestamp: timestamp ?? `2026-07-29T16:00:${String(clock).padStart(2, "0")}.000Z`,
    rawJsonlType,
  };
}

const prompt = (text: string) => ({ role: "user", content: text });
const toolUse = (id: string) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "t" }],
});
const toolResult = (id: string) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
});
const text = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });

const marked = (blocks: SessionContextSnapshotBlock[]) =>
  blocks.filter((b) => b.isAbandonedBranch === true).map((b) => b.uuid);

describe("markAbandonedRewindBranches", () => {
  test("AT: a linear conversation is returned untouched, same array reference", () => {
    const blocks = [
      block("a", undefined, "user", prompt("hello")),
      block("b", "a", "assistant", text("hi")),
      block("c", "b", "user", prompt("more")),
      block("d", "c", "assistant", text("sure")),
    ];

    const result = markAbandonedRewindBranches(blocks);

    expect(result).toBe(blocks);
    expect(marked(result)).toEqual([]);
  });

  test("AT: a parallel tool batch keeps BOTH branches — the tool_result is not dropped", () => {
    // assistant emits tool_use A; its children are A's tool_result AND the next
    // parallel tool_use row. This is the dominant branch shape in the corpus.
    const blocks = [
      block("root", undefined, "user", prompt("do two things")),
      block("callA", "root", "assistant", toolUse("A")),
      block("resultA", "callA", "user", toolResult("A")),
      block("callB", "callA", "assistant", toolUse("B")),
      block("resultB", "callB", "user", toolResult("B")),
      block("answer", "callB", "assistant", text("done")),
    ];

    const result = markAbandonedRewindBranches(blocks);

    expect(result).toBe(blocks);
    expect(marked(result)).toEqual([]);
  });

  test("AT: a batched parent whose children are ONLY tool results keeps them all", () => {
    const blocks = [
      block("callAll", undefined, "assistant", {
        role: "assistant",
        content: [
          { type: "tool_use", id: "A", name: "t" },
          { type: "tool_use", id: "B", name: "t" },
        ],
      }),
      block("r1", "callAll", "user", toolResult("A")),
      block("r2", "callAll", "user", toolResult("B")),
    ];

    const result = markAbandonedRewindBranches(blocks);

    expect(marked(result)).toEqual([]);
  });

  test("AT: sibling operator prompts where only one was answered — the unanswered one is marked", () => {
    const blocks = [
      block("root", undefined, "assistant", text("go ahead")),
      block("rewound", "root", "user", prompt("first draft")),
      block("live", "root", "user", prompt("second draft")),
      block("reply", "live", "assistant", text("answering the second")),
    ];

    const result = markAbandonedRewindBranches(blocks);

    expect(marked(result)).toEqual(["rewound"]);
    // The live branch and its reply are untouched.
    expect(result.find((b) => b.uuid === "live")?.isAbandonedBranch).toBeUndefined();
    expect(result.find((b) => b.uuid === "reply")?.isAbandonedBranch).toBeUndefined();
  });

  test("AT: descendants of a rewound prompt are marked too", () => {
    const blocks = [
      block("root", undefined, "assistant", text("go ahead")),
      block("rewound", "root", "user", prompt("first draft")),
      block("attach", "rewound", "attachment", { note: "deferred tools" }),
      block("live", "root", "user", prompt("second draft")),
      block("reply", "live", "assistant", text("answering")),
    ];

    const result = markAbandonedRewindBranches(blocks);

    expect(marked(result).sort()).toEqual(["attach", "rewound"]);
  });

  test("AT: neither sibling answered — the rule picks the latest, stably across runs", () => {
    const build = () => [
      block("root", undefined, "assistant", text("go ahead"), "2026-07-29T16:00:00.000Z"),
      block("earlier", "root", "user", prompt("first"), "2026-07-29T16:00:10.000Z"),
      block("later", "root", "user", prompt("second"), "2026-07-29T16:00:20.000Z"),
    ];

    const first = marked(markAbandonedRewindBranches(build()));
    const second = marked(markAbandonedRewindBranches(build()));

    expect(first).toEqual(["earlier"]);
    expect(second).toEqual(first);
  });

  test("AT: a dangling parentUuid does not crash and marks nothing", () => {
    const blocks = [
      block("a", "nonexistent-parent", "user", prompt("orphan")),
      block("b", "a", "assistant", text("reply")),
    ];

    expect(() => markAbandonedRewindBranches(blocks)).not.toThrow();
    expect(marked(markAbandonedRewindBranches(blocks))).toEqual([]);
  });

  test("AT: a cyclic parentUuid chain terminates instead of looping", () => {
    // x -> y -> x, plus a genuine rewind hanging off the cycle so the walk is
    // actually entered rather than short-circuited.
    const blocks = [
      block("x", "y", "user", prompt("a")),
      block("y", "x", "user", prompt("b")),
      block("p", undefined, "assistant", text("parent")),
      block("r1", "p", "user", prompt("draft one")),
      block("r2", "p", "user", prompt("draft two")),
      block("cyc", "r1", "user", prompt("into the cycle")),
      block("back", "cyc", "user", prompt("loop")),
    ];
    // close the loop
    (blocks.find((b) => b.uuid === "cyc") as SessionContextSnapshotBlock).parentUuid = "back";

    expect(() => markAbandonedRewindBranches(blocks)).not.toThrow();
  });

  test("blocks without a uuid can be children but never parents", () => {
    const attachment: SessionContextSnapshotBlock = {
      id: "s:attachment:0",
      type: "deferred-tool-catalog",
      source: "observed",
      content: { note: "catalog" },
      parentUuid: "rewound",
      timestamp: "2026-07-29T16:00:11.000Z",
      rawJsonlType: "attachment",
    };
    const blocks = [
      block("root", undefined, "assistant", text("go")),
      block("rewound", "root", "user", prompt("first")),
      attachment,
      block("live", "root", "user", prompt("second")),
      block("reply", "live", "assistant", text("answer")),
    ];

    const result = markAbandonedRewindBranches(blocks);

    expect(result.find((b) => b.id === "s:attachment:0")?.isAbandonedBranch).toBe(true);
  });

  test("no block is ever removed and turnIndex is never rewritten", () => {
    const blocks = [
      block("root", undefined, "assistant", text("go")),
      block("rewound", "root", "user", prompt("first")),
      block("live", "root", "user", prompt("second")),
      block("reply", "live", "assistant", text("answer")),
    ].map((b, i) => ({ ...b, turnIndex: i }));

    const result = markAbandonedRewindBranches(blocks);

    expect(result).toHaveLength(blocks.length);
    expect(result.map((b) => b.turnIndex)).toEqual([0, 1, 2, 3]);
    expect(result.map((b) => b.id)).toEqual(blocks.map((b) => b.id));
  });

  test("a rewind AFTER the agent started working marks the whole abandoned attempt", () => {
    // Both siblings have assistant descendants, so the assistant-descendant
    // rule cannot discriminate and the latest-by-timestamp fallback applies.
    // The abandoned attempt carries a tool_use + tool_result of its own.
    const blocks = [
      block("root", undefined, "assistant", text("go ahead"), "2026-07-29T16:00:00.000Z"),
      block("rewound", "root", "user", prompt("first draft"), "2026-07-29T16:00:10.000Z"),
      block("abandonedCall", "rewound", "assistant", toolUse("A"), "2026-07-29T16:00:11.000Z"),
      block(
        "abandonedResult",
        "abandonedCall",
        "user",
        toolResult("A"),
        "2026-07-29T16:00:12.000Z"
      ),
      block("live", "root", "user", prompt("second draft"), "2026-07-29T16:00:20.000Z"),
      block("liveReply", "live", "assistant", text("answering"), "2026-07-29T16:00:21.000Z"),
    ];

    const result = markAbandonedRewindBranches(blocks);

    expect(marked(result).sort()).toEqual(["abandonedCall", "abandonedResult", "rewound"]);

    // The render surface counts PROMPTS: of the three marked blocks only one is
    // an operator prompt — the tool result must not inflate the count.
    const markedPrompts = result.filter((b) => b.isAbandonedBranch === true && isOperatorPrompt(b));
    expect(markedPrompts.map((b) => b.uuid)).toEqual(["rewound"]);
  });

  test("each block is marked exactly once — no duplicate subtree entries", () => {
    const blocks = [
      block("root", undefined, "assistant", text("go")),
      block("rewound", "root", "user", prompt("first")),
      block("kid", "rewound", "assistant", text("partial")),
      block("grandkid", "kid", "user", prompt("deeper")),
      block("live", "root", "user", prompt("second")),
      block("liveReply", "live", "assistant", text("answer")),
    ];

    const result = markAbandonedRewindBranches(blocks);
    const markedIds = marked(result);

    expect(markedIds).toHaveLength(new Set(markedIds).size);
    expect(markedIds.sort()).toEqual(["grandkid", "kid", "rewound"]);
  });
});

describe("the window split (mt#4263)", () => {
  /**
   * A rewind whose two sibling branches sit far apart in the transcript, so a
   * tail window can contain the abandoned prompt while the live branch that
   * supersedes it falls outside.
   */
  function rewindWithDistantSiblings() {
    const rewound = block("rewound", "root", "user", prompt("first draft"));
    const live = block("live", "root", "user", prompt("second draft"));
    const liveReply = block("liveReply", "live", "assistant", text("answer"));
    return {
      full: [block("root", undefined, "assistant", text("root")), rewound, live, liveReply],
      // The tail a 2-turn window would return: the abandoned prompt is present,
      // the live sibling that outranks it is not.
      windowed: [rewound, liveReply],
    };
  }

  test("AT9: the verdict computed over the FULL transcript still marks a windowed block", () => {
    const { full, windowed } = rewindWithDistantSiblings();
    const abandoned = computeAbandonedBlockIds(full);
    const marked = applyAbandonedBlockIds(windowed, abandoned);
    expect(marked.find((b) => b.uuid === "rewound")?.isAbandonedBranch).toBe(true);
  });

  test("AT9 NEGATIVE CONTROL: computed over the WINDOW alone, the same block is NOT marked", () => {
    // This is the defect the split exists to prevent, and without this control
    // the assertion above passes just as well against an implementation that
    // marks everything. The rule picks the live branch by comparing SIBLING
    // subtrees; truncate one side away and there is no sibling pair left to
    // compare, so the rewind is invisible and the superseded prompt renders as
    // an ordinary turn — mt#3323's original defect, reintroduced by windowing.
    const { windowed } = rewindWithDistantSiblings();
    const abandonedFromWindow = computeAbandonedBlockIds(windowed);
    const marked = applyAbandonedBlockIds(windowed, abandonedFromWindow);
    expect(marked.find((b) => b.uuid === "rewound")?.isAbandonedBranch).toBeUndefined();
  });

  test("ids, not object identity — the set crosses the window boundary", () => {
    // The projection the windowed assembler runs the detector over builds
    // DIFFERENT block objects from the ones it returns, so an identity-keyed set
    // would silently mark nothing.
    const { full, windowed } = rewindWithDistantSiblings();
    const abandoned = computeAbandonedBlockIds(full);
    const clones = windowed.map((b) => ({ ...b }));
    expect(applyAbandonedBlockIds(clones, abandoned).some((b) => b.isAbandonedBranch)).toBe(true);
  });

  test("applying an empty set returns the SAME array reference", () => {
    const blocks = [block("a", undefined, "user", prompt("hello"))];
    expect(applyAbandonedBlockIds(blocks, new Set())).toBe(blocks);
  });

  test("applying a set that names nothing in this window returns the SAME reference", () => {
    // The common path on a windowed page: the conversation HAS a rewind, but
    // not in the fifty turns being rendered. Copying every block there would
    // discard the memo-stability the unwindowed path relies on.
    const blocks = [block("a", undefined, "user", prompt("hello"))];
    expect(applyAbandonedBlockIds(blocks, new Set(["s:turn:elsewhere"]))).toBe(blocks);
  });
});
