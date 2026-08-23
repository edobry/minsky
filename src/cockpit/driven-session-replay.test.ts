/**
 * Driven-session replay tests (mt#3453).
 *
 * The tailer is injected throughout — no test reads `~/.claude/projects`, and
 * none constructs a real `JsonlTailer`.
 */
/* eslint-disable custom/no-real-fs-in-tests -- mt#3397: the host preflights its spawn cwd against the REAL filesystem, so a record built for the gate assertions below needs a real directory. A per-run mkdtemp dir keeps the "fixed mock path" race the rule guards against from applying. */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildDrivenReplayBlocks,
  MAX_REPLAY_BLOCKS,
  type ReplayTailerLike,
} from "./driven-session-replay";

const HOST_MODULE = "./driven-session-host";
const REAL_CWD = mkdtempSync(join(tmpdir(), "driven-replay-"));

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

/**
 * The replay GATE (mt#3453) — which records get history, keyed on origin.
 *
 * These assert the record-shape contract the WS channel branches on. The first
 * implementation gated on `eventLog.length === 0` and passed every unit test,
 * because a test controls the log directly; live verification showed it never
 * fired in production, since the session driver emits frames within milliseconds of
 * attach and every real client connects after that. The property below is the
 * one that survives real timing.
 */
describe("needsHistoryReplay gate (mt#3453)", () => {
  test("a fresh spawn does NOT request replay — it starts the conversation", async () => {
    const { startDrivenSession, DrivenSessionRegistry } = await import(HOST_MODULE);
    const { EventEmitter } = await import("events");
    const { PassThrough } = await import("stream");
    class Fake extends EventEmitter {
      readonly pid = 1;
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly stdin = new PassThrough();
      kill() {
        return true;
      }
    }
    const { record } = startDrivenSession({
      cwd: REAL_CWD,
      permissionMode: "default",
      spawnFn: () => new Fake() as never,
      registry: new DrivenSessionRegistry(),
    });
    expect(record.needsHistoryReplay).toBe(false);
  });

  test("a resumed/attached record DOES request replay, and keeps requesting it", async () => {
    const { resumeDrivenSession, DrivenSessionRegistry } = await import(HOST_MODULE);
    const { EventEmitter } = await import("events");
    const { PassThrough } = await import("stream");
    class Fake extends EventEmitter {
      readonly pid = 2;
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly stdin = new PassThrough();
      kill() {
        return true;
      }
    }
    const { record } = resumeDrivenSession({
      previous: {
        localId: "sessionDriver-x",
        cwd: REAL_CWD,
        permissionMode: "default",
        harnessSessionId: "conv-x",
        taskId: null,
        minskySessionId: null,
        startedAt: new Date().toISOString(),
        driverGeneration: 0,
        model: null,
      },
      spawnFn: () => new Fake() as never,
      registry: new DrivenSessionRegistry(),
    });

    expect(record.needsHistoryReplay).toBe(true);
    // The flag must NOT be a function of the log: a second client connecting
    // after the session driver has emitted frames still needs the history.
    record.eventLog.push({ seq: 0, receivedAt: new Date().toISOString(), payload: { type: "x" } });
    expect(record.needsHistoryReplay).toBe(true);
  });

  test("a boot-rehydrated placeholder requests replay — its predecessor's log is gone", async () => {
    const { buildReconnectingDrivenSessionRecord } = await import(HOST_MODULE);
    const record = buildReconnectingDrivenSessionRecord({
      localId: "sessionDriver-y",
      harnessSessionId: "conv-y",
      cwd: "/tmp",
      permissionMode: "default",
      taskId: null,
      minskySessionId: null,
      status: "reconnecting",
      driverGeneration: 0,
      startedAt: new Date().toISOString(),
    });
    expect(record.needsHistoryReplay).toBe(true);
  });
});

afterAll(() => {
  rmSync(REAL_CWD, { recursive: true, force: true });
});

/**
 * Locator equivalence (mt#3453, PR #2482 R1).
 *
 * `locateConversationTranscript` was private to the attach path and is now
 * exported so the WS replay channel resolves a conversation's transcript
 * through the SAME lookup. Equivalence is currently by construction — one
 * function, two callers — but nothing PINNED it, so a future change giving the
 * attach path its own default would let the two surfaces disagree about where a
 * conversation lives, with no test failing. These pin it.
 */
describe("locateConversationTranscript equivalence (mt#3453)", () => {
  const UNKNOWN = "00000000-0000-4000-8000-000000000000";

  test("returns null for a conversation with no transcript on disk", async () => {
    const { locateConversationTranscript } = await import("./driven-session-launch");
    expect(await locateConversationTranscript(UNKNOWN)).toBeNull();
  });

  test("the attach path's DEFAULT locator resolves the same unknown id to no-transcript", async () => {
    const { orchestrateDrivenSessionAttach } = await import("./driven-session-launch");
    // No `locateConversation` dep — this exercises the production default. If
    // that default ever stops being the exported locator (or stops reading the
    // real transcript tree), this stops reporting `no-transcript`.
    const outcome = await orchestrateDrivenSessionAttach(UNKNOWN, {
      getDb: async () => ({}) as never,
      readPresence: async () => "IDLE",
      withResumeLock: async (_db, _c, fn) => ({ acquired: true, result: await fn() }),
      spawnFn: () => {
        throw new Error("must not spawn — the id has no transcript");
      },
    });
    expect(outcome).toEqual({ outcome: "no-transcript" });
  });
});
