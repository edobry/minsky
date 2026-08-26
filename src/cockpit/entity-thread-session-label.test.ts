/**
 * Production-wiring tests for the entity-thread harness session label (mt#4621).
 *
 * These are deliberately NOT unit tests of `writeHarnessSessionLabel` — that
 * module has its own file. What is asserted here is the WIRING: that
 * `startEntityThreadSession` actually reaches the writer when the child's
 * `system/init` frame arrives, with the entity's own ref and title.
 *
 * That distinction is the whole point. The originating defect was not a broken
 * helper; it was a helper that existed (`.minsky/hooks/auto-session-title.ts`,
 * shipped by mt#843) with no caller on this path. A test of the helper alone
 * would have passed throughout, exactly as it did for the year the threads
 * launched untitled.
 *
 * No `claude` binary is spawned — per ./driven-session-host.ts's docblock that
 * would spend real credit and run a headless skip-permissions agent. The fake
 * process below emits the one stream-json frame the host needs.
 *
 * @see ./harness-session-label.ts — the writer
 * @see ./entity-thread-launch.ts — the caller under test
 */

/* eslint-disable custom/no-real-fs-in-tests -- mt#3397: the host preflights its spawn cwd against the REAL filesystem, so these launches need a real directory as their cwd — there is no fs to inject through the code path under test. The label WRITE itself is injected and touches nothing. */
import { describe, expect, test, afterAll } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";

const TEST_CWD = mkdtempSync(join(tmpdir(), "entity-thread-label-"));

import { DrivenSessionRegistry, type ProcessLike, type SpawnFn } from "./driven-session-host";
import {
  askToEntitySeed,
  composeInitObservers,
  startEntityThreadSession,
  taskToEntitySeed,
} from "./entity-thread-launch";
import type { WriteHarnessSessionLabelInput } from "./harness-session-label";

const ASK_ID = "38b1c0de-1111-2222-3333-444455556666";
const CHILD_CONVERSATION = "3a61b3a8-67a2-4536-8461-741a6c7f1b15";

afterAll(() => rmSync(TEST_CWD, { recursive: true, force: true }));

/**
 * Fake child that emits the `system/init` frame and nothing else.
 *
 * The frame is what makes `onHarnessSessionLinked` fire at all — it is the
 * only moment the child's conversation id exists, and therefore the only
 * moment the label can be keyed correctly.
 */
class InitEmittingProcess extends EventEmitter implements ProcessLike {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  constructor(private readonly conversationId: string) {
    super();
    queueMicrotask(() => {
      this.stdout.write(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: this.conversationId })}\n`
      );
    });
  }

  kill(): boolean {
    return true;
  }
}

function initEmittingSpawn(conversationId = CHILD_CONVERSATION): SpawnFn {
  return () => new InitEmittingProcess(conversationId);
}

/** Let the queued stdout frame flush through the host's line parser. */
async function flushInit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function labelRecorder(): {
  labels: WriteHarnessSessionLabelInput[];
  write: (input: WriteHarnessSessionLabelInput) => boolean;
} {
  const labels: WriteHarnessSessionLabelInput[] = [];
  return {
    labels,
    write: (input) => {
      labels.push(input);
      return true;
    },
  };
}

describe("startEntityThreadSession — harness session label (production wiring)", () => {
  test("labels an ask thread with the ask's short ref and title", async () => {
    const io = labelRecorder();
    await startEntityThreadSession({
      seed: askToEntitySeed({
        id: ASK_ID,
        question: "Should we adopt X?",
        title: "Adopt X for the reviewer",
        shortId: "ask#9257",
      }),
      cwd: TEST_CWD,
      spawnFn: initEmittingSpawn(),
      registry: new DrivenSessionRegistry(),
      command: "fake-claude",
      onStateChange: () => {},
      onResultSummary: () => {},
      onHarnessSessionLinked: () => {},
      writeSessionLabel: io.write,
    });
    await flushInit();

    expect(io.labels).toHaveLength(1);
    expect(io.labels[0]).toEqual({
      harnessSessionId: CHILD_CONVERSATION,
      ref: "ask#9257",
      title: "Adopt X for the reviewer",
    });
  });

  test("labels a task thread with the task id as its ref", async () => {
    const io = labelRecorder();
    await startEntityThreadSession({
      seed: taskToEntitySeed({ id: "mt#4621", title: "Title the threads", spec: "body" }),
      cwd: TEST_CWD,
      spawnFn: initEmittingSpawn(),
      registry: new DrivenSessionRegistry(),
      command: "fake-claude",
      onStateChange: () => {},
      onResultSummary: () => {},
      onHarnessSessionLinked: () => {},
      writeSessionLabel: io.write,
    });
    await flushInit();

    expect(io.labels[0]?.ref).toBe("mt#4621");
    expect(io.labels[0]?.title).toBe("Title the threads");
  });

  test("keys the label on the CHILD's conversation id, not the entity's", async () => {
    // The defect this whole task exists to fix: the shipped relay keys on the
    // caller's own session id, which for a cockpit spawn is the daemon, not
    // the child that will render the title.
    const io = labelRecorder();
    const otherConversation = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    await startEntityThreadSession({
      seed: askToEntitySeed({ id: ASK_ID, question: "q", shortId: "ask#1" }),
      cwd: TEST_CWD,
      spawnFn: initEmittingSpawn(otherConversation),
      registry: new DrivenSessionRegistry(),
      command: "fake-claude",
      onStateChange: () => {},
      onResultSummary: () => {},
      onHarnessSessionLinked: () => {},
      writeSessionLabel: io.write,
    });
    await flushInit();

    expect(io.labels[0]?.harnessSessionId).toBe(otherConversation);
    expect(io.labels[0]?.harnessSessionId).not.toBe(ASK_ID);
  });

  test("does not write a label when no init frame ever arrives", async () => {
    // `spawn-died-before-init` is a documented terminal state. Writing a label
    // under a guessed id would leave an unconsumable file in /tmp forever.
    class SilentProcess extends EventEmitter implements ProcessLike {
      readonly pid = 4243;
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly stdin = new PassThrough();
      kill(): boolean {
        return true;
      }
    }

    const io = labelRecorder();
    await startEntityThreadSession({
      seed: askToEntitySeed({ id: ASK_ID, question: "q", shortId: "ask#1" }),
      cwd: TEST_CWD,
      spawnFn: () => new SilentProcess(),
      registry: new DrivenSessionRegistry(),
      command: "fake-claude",
      onStateChange: () => {},
      onResultSummary: () => {},
      onHarnessSessionLinked: () => {},
      writeSessionLabel: io.write,
    });
    await flushInit();

    expect(io.labels).toHaveLength(0);
  });
});

describe("composeInitObservers", () => {
  test("runs every observer", () => {
    const seen: string[] = [];
    composeInitObservers<string>(
      (r) => seen.push(`a:${r}`),
      (r) => seen.push(`b:${r}`)
    )("x");
    expect(seen).toEqual(["a:x", "b:x"]);
  });

  test("propagates a throw to the host, which owns the single error boundary", () => {
    // PR #3379 R1: this used to swallow and log a WARN, duplicating the host's
    // own catch (driven-session-host.ts:1089-1097, which logs at ERROR) and
    // producing two logging surfaces at two levels for one failure.
    expect(() =>
      composeInitObservers<string>(() => {
        throw new Error("boom");
      })("x")
    ).toThrow("boom");
  });

  test("a throw DOES skip later observers — which is what makes call-site order load-bearing", () => {
    // Not a defect, but the reason the call site puts the throw-incapable
    // observer first. Pinned so a future reader cannot mistake the ordering for
    // arbitrary and reverse it.
    const seen: string[] = [];
    expect(() =>
      composeInitObservers<string>(
        () => {
          throw new Error("first exploded");
        },
        (r) => seen.push(`after:${r}`)
      )("x")
    ).toThrow();
    expect(seen).toEqual([]);
  });
});

describe("call-site observer ordering (PR #3379 R1)", () => {
  test("the label write runs BEFORE the adoption observer, so a throwing adoption cannot suppress it", async () => {
    // The property the removed try/catch was protecting, now carried by order.
    const order: string[] = [];
    await startEntityThreadSession({
      seed: askToEntitySeed({ id: ASK_ID, question: "q", shortId: "ask#1" }),
      cwd: TEST_CWD,
      spawnFn: initEmittingSpawn(),
      registry: new DrivenSessionRegistry(),
      command: "fake-claude",
      onStateChange: () => {},
      onResultSummary: () => {},
      onHarnessSessionLinked: () => {
        order.push("adoption");
        throw new Error("adoption exploded");
      },
      writeSessionLabel: () => {
        order.push("label");
        return true;
      },
    });
    await flushInit();

    // The label ran, and ran first — despite the adoption throwing after it.
    expect(order).toEqual(["label", "adoption"]);
  });
});
