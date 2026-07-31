/**
 * Driven-session replay tests (mt#3453).
 *
 * The tailer is injected throughout — no test reads `~/.claude/projects`, and
 * none constructs a real `JsonlTailer`.
 */
import { describe, test, expect } from "bun:test";
import {
  buildDrivenReplayBlocks,
  MAX_REPLAY_BLOCKS,
  type ReplayTailerLike,
} from "./driven-session-replay";

const CONVERSATION = "conv-replay-1";
const PATH = "/tmp/fake/conv-replay-1.jsonl";

/**
 * A tailer double whose first read returns `lines`. Annotated with the exported
 * seam type so the fake is checked against the real generic signature rather
 * than an inline shape that can drift from it.
 */
function fakeTailer(lines: unknown[]): ReplayTailerLike {
  return { readNew: async <T = unknown>() => ({ lines: lines as T[] }) };
}

function userLine(text: string, ts = "2026-07-31T00:00:00.000Z") {
  return {
    type: "user",
    timestamp: ts,
    uuid: `u-${text}`,
    message: { role: "user", content: text },
  };
}

function assistantLine(text: string, ts = "2026-07-31T00:00:01.000Z") {
  return {
    type: "assistant",
    timestamp: ts,
    uuid: `a-${text}`,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

describe("buildDrivenReplayBlocks (mt#3453)", () => {
  test("converts user and assistant turns into blocks, in file order", async () => {
    const blocks = await buildDrivenReplayBlocks(PATH, CONVERSATION, {
      tailer: fakeTailer([userLine("hello"), assistantLine("hi back")]),
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.rawJsonlType).toBe("user");
    expect(blocks[1]?.rawJsonlType).toBe("assistant");
  });

  test("blocks carry a :replay: id namespace so they cannot collide with live blocks", async () => {
    const blocks = await buildDrivenReplayBlocks(PATH, CONVERSATION, {
      tailer: fakeTailer([userLine("hello")]),
    });
    expect(blocks[0]?.id).toBe(`${CONVERSATION}:replay:0`);
    // The live path mints `driven:turn:N` / `<id>:live:N`; overlap would make
    // the SPA treat a replayed turn and a live turn as one block.
    expect(blocks[0]?.id).not.toContain(":live:");
    expect(blocks[0]?.id).not.toContain("driven:turn:");
  });

  test.each([
    ["system", { type: "system", timestamp: "2026-07-31T00:00:00.000Z" }],
    ["attachment", { type: "attachment", timestamp: "2026-07-31T00:00:00.000Z" }],
    ["queue-operation", { type: "queue-operation", timestamp: "2026-07-31T00:00:00.000Z" }],
  ])("skips %s lines rather than rendering a block type live never produces", async (_n, line) => {
    const blocks = await buildDrivenReplayBlocks(PATH, CONVERSATION, {
      tailer: fakeTailer([userLine("kept"), line]),
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.rawJsonlType).toBe("user");
  });

  test("skips malformed entries without throwing", async () => {
    const blocks = await buildDrivenReplayBlocks(PATH, CONVERSATION, {
      tailer: fakeTailer([null, 42, "not an object", {}, userLine("survivor")]),
    });
    expect(blocks).toHaveLength(1);
  });

  test("a line with no timestamp is skipped (the converter requires one)", async () => {
    const blocks = await buildDrivenReplayBlocks(PATH, CONVERSATION, {
      tailer: fakeTailer([{ type: "user", message: { role: "user", content: "no ts" } }]),
    });
    expect(blocks).toHaveLength(0);
  });

  test("an empty transcript yields no blocks", async () => {
    const blocks = await buildDrivenReplayBlocks(PATH, CONVERSATION, { tailer: fakeTailer([]) });
    expect(blocks).toEqual([]);
  });

  // Degrading to an empty pane is the PRE-EXISTING behavior, so a read failure
  // must not take down the WS attach for an otherwise-drivable conversation.
  test("a read failure degrades to no blocks instead of throwing", async () => {
    const blocks = await buildDrivenReplayBlocks(PATH, CONVERSATION, {
      tailer: {
        readNew: async <T = unknown>(): Promise<{ lines: T[] }> => {
          throw new Error("ENOENT");
        },
      },
    });
    expect(blocks).toEqual([]);
  });

  test("caps at maxBlocks and keeps the TAIL, not the head", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => userLine(`turn-${i}`));
    const blocks = await buildDrivenReplayBlocks(PATH, CONVERSATION, {
      tailer: fakeTailer(lines),
      maxBlocks: 3,
    });
    expect(blocks).toHaveLength(3);
    // The last three turns — an operator opening a conversation needs what it
    // just said, not what it said first.
    expect(blocks.map((b) => b.id)).toEqual([
      `${CONVERSATION}:replay:7`,
      `${CONVERSATION}:replay:8`,
      `${CONVERSATION}:replay:9`,
    ]);
  });

  test("an under-cap transcript is returned whole", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => userLine(`turn-${i}`));
    const blocks = await buildDrivenReplayBlocks(PATH, CONVERSATION, {
      tailer: fakeTailer(lines),
      maxBlocks: 100,
    });
    expect(blocks).toHaveLength(5);
  });

  // The cap is measured (see the constant's docblock: median 522 turns across
  // 305 local transcripts). A cap at or below the median would truncate typical
  // conversations, which is routine truncation rather than an outlier bound —
  // this pins that the constant stays above the measured median.
  test("the default cap sits above the measured median conversation length", () => {
    expect(MAX_REPLAY_BLOCKS).toBeGreaterThan(522);
  });
});
