/**
 * Tests for the driven-session actuator (mt#3228).
 *
 * Uses the same injected-`spawnFn` discipline as driven-session-host.test.ts —
 * no test spawns a real `claude`. The cases worth having are the ones about
 * conversation CONTINUITY, since that is the actuator's whole reason to exist.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import {
  DrivenSessionRegistry,
  type ProcessLike,
  type SpawnFn,
  type SpawnOptions,
} from "./driven-session-host";
import { createDrivenSessionActuator, resultText } from "./principal-channel-actuator";

const CWD = "/tmp/channel";
const BLOCKED_Q = "what is blocked?";

class FakeClaudeProcess extends EventEmitter implements ProcessLike {
  readonly pid: number | undefined = 424242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  /** Everything written to stdin, accumulated (the stream is in flowing mode). */
  written = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      this.written += String(chunk);
    });
  }

  kill(): boolean {
    return true;
  }

  emitLine(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  /**
   * Emit the `init` event — the child saying "I am up".
   *
   * The host records `harnessSessionId` from this. Wired to fire only ON INPUT
   * (see `fakeSpawn`), because that is what the real binary does — and a fake
   * that emitted it unprompted is exactly what let mt#3234 ship a deadlock:
   * the code waited for init before writing, the real child waits for a write
   * before init, and no test could see it (mt#3238).
   */
  emitInit(sessionId = "fake-harness-session"): void {
    this.emitLine({ type: "system", subtype: "init", session_id: sessionId });
  }

  /** Emit the terminal `result` event that ends one turn. */
  finishTurn(text: string): void {
    this.emitLine({ type: "result", subtype: "success", result: text });
  }

  exit(code: number | null): void {
    this.emit("exit", code, null);
  }
}

interface SpawnCapture {
  args: string[];
  options: SpawnOptions;
  proc: FakeClaudeProcess;
}

/**
 * Build a spawnFn whose children behave like the real binary.
 *
 * The load-bearing detail (mt#3238): a child emits `init` only AFTER it
 * receives input on stdin. `claude -p --input-format stream-json` works that
 * way, and the previous fake did not — it emitted on a timer regardless of
 * input, which made a deadlocked ordering (wait for init, then write) look
 * correct in every test while failing every real message.
 *
 * `neverReady: true` produces a child that takes input and still never reports
 * init — the mt#3234 incident, where a conversation sat `running` with a null
 * harness id while messages routed into it vanished.
 */
function fakeSpawn(opts: { neverReady?: boolean } = {}): {
  spawnFn: SpawnFn;
  calls: SpawnCapture[];
} {
  const calls: SpawnCapture[] = [];
  const spawnFn: SpawnFn = (_command, args, options) => {
    const proc = new FakeClaudeProcess();
    const index = calls.length + 1;
    calls.push({ args, options, proc });
    if (!opts.neverReady) {
      proc.stdin.once("data", () => {
        // Async, mirroring a real child's startup latency after the write.
        setTimeout(() => proc.emitInit(`harness-${index}`), 1);
      });
    }
    return proc;
  };
  return { spawnFn, calls };
}

function makeActuator(
  overrides: {
    respondToAsk?: (ref: string, text: string) => Promise<string>;
    turnTimeoutMs?: number;
    readyTimeoutMs?: number;
    permissionMode?: "default" | "bypassPermissions";
    neverReady?: boolean;
  } = {}
) {
  const { spawnFn, calls } = fakeSpawn(
    overrides.neverReady === undefined ? {} : { neverReady: overrides.neverReady }
  );
  const registry = new DrivenSessionRegistry();
  const actuator = createDrivenSessionActuator({
    cwd: CWD,
    registry,
    spawnFn,
    respondToAsk: overrides.respondToAsk ?? (async (ref, text) => `answered ${ref}: ${text}`),
    // Short by default: every test here drives a fake, so a real-world budget
    // would only buy slow failures.
    readyTimeoutMs: overrides.readyTimeoutMs ?? 500,
    readyPollMs: 1,
    ...(overrides.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: overrides.turnTimeoutMs }),
    ...(overrides.permissionMode === undefined ? {} : { permissionMode: overrides.permissionMode }),
  });
  return { actuator, calls, registry };
}

/**
 * Wait until `predicate` holds, rather than sleeping a guessed interval.
 *
 * The suite previously slept a fixed 25ms and hoped the spawn had become ready
 * and the input written by then (PR #2329 R1 flagged the fragility). Polling a
 * condition removes the guess: it returns as soon as the state is true, and
 * fails with a named reason instead of a confusing downstream assertion.
 */
async function waitUntil(predicate: () => boolean, what: string, attempts = 2000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/**
 * Wait until input has been written to the child, optionally containing `needle`.
 *
 * Matches on CONTENT rather than growth: the write usually lands before this is
 * called, so waiting for the buffer to grow would wait for a second write that
 * never comes.
 */
async function waitForWrite(proc: FakeClaudeProcess, needle?: string): Promise<string> {
  await waitUntil(
    () => proc.written.length > 0 && (needle === undefined || proc.written.includes(needle)),
    `input${needle === undefined ? "" : ` containing "${needle}"`} to be written to the child`
  );
  return proc.written;
}

/** Wait until a spawn has been recorded. */
const waitForSpawn = (calls: SpawnCapture[], n: number): Promise<void> =>
  waitUntil(() => calls.length >= n, `${n} spawn(s)`);

describe("createDrivenSessionActuator — conversing", () => {
  test("spawns a conversation on the first message and returns the turn's text", async () => {
    const { actuator, calls } = makeActuator();

    const reply = actuator.converse(BLOCKED_Q);
    await waitForSpawn(calls, 1);
    expect(await waitForWrite(calls[0]?.proc as FakeClaudeProcess)).toContain(BLOCKED_Q);

    calls[0]?.proc.finishTurn("nothing is blocked");
    expect(await reply).toBe("nothing is blocked");
  });

  test("REUSES the conversation across messages", async () => {
    // The whole point: "focus on that one" only resolves against what was
    // just said, so a second message must not get a fresh session.
    const { actuator, calls } = makeActuator();

    const first = actuator.converse("list the tasks");
    await waitForSpawn(calls, 1);
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess);
    calls[0]?.proc.finishTurn("three tasks");
    await first;

    const second = actuator.converse("focus on the second one");
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess, "focus on the second one");
    calls[0]?.proc.finishTurn("focusing");
    await second;

    expect(calls).toHaveLength(1);
  });

  test("starts a new conversation transparently after the old one exits", async () => {
    // The principal should never have to know a process died.
    const { actuator, calls } = makeActuator();

    const first = actuator.converse("hi");
    await waitForSpawn(calls, 1);
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess);
    calls[0]?.proc.finishTurn("hello");
    await first;

    calls[0]?.proc.exit(1);

    const second = actuator.converse("still there?");
    await waitForSpawn(calls, 2);
    await waitForWrite(calls[1]?.proc as FakeClaudeProcess);
    calls[1]?.proc.finishTurn("yes");
    expect(await second).toBe("yes");
  });

  test("spawns with the requested permission mode", async () => {
    const { actuator, calls } = makeActuator({ permissionMode: "default" });
    void actuator.converse("hi");
    await waitForSpawn(calls, 1);
    expect(calls[0]?.args).not.toContain("--dangerously-skip-permissions");
  });

  test("defaults to the same permission mode as every other driven session", async () => {
    const { actuator, calls } = makeActuator();
    void actuator.converse("hi");
    await waitForSpawn(calls, 1);
    expect(calls[0]?.args).toContain("--dangerously-skip-permissions");
  });

  test("runs in the configured working directory", async () => {
    const { actuator, calls } = makeActuator();
    void actuator.converse("hi");
    await waitForSpawn(calls, 1);
    expect(calls[0]?.options.cwd).toBe(CWD);
  });

  test("answers rather than hanging when a turn overruns", async () => {
    const { actuator } = makeActuator({ turnTimeoutMs: 10 });
    const reply = await actuator.converse("something slow");
    expect(reply).toContain("longer than expected");
  });
});

describe("createDrivenSessionActuator — control verbs", () => {
  test("interrupt reports that nothing is running when idle", async () => {
    const { actuator } = makeActuator();
    expect(await actuator.interrupt()).toContain("Nothing is running");
  });

  test("interrupt drops the conversation so the next message starts fresh", async () => {
    const { actuator, calls } = makeActuator();
    const first = actuator.converse("hi");
    await waitForSpawn(calls, 1);
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess);
    calls[0]?.proc.finishTurn("hello");
    await first;

    await actuator.interrupt();
    void actuator.converse("again");
    await waitForSpawn(calls, 2);
    expect(calls).toHaveLength(2);
  });

  test("reset drops the conversation even when idle", async () => {
    const { actuator, calls } = makeActuator();
    expect(await actuator.reset()).toContain("Starting fresh");
    void actuator.converse("hi");
    await waitForSpawn(calls, 1);
    expect(calls).toHaveLength(1);
  });

  test("answerAsk delegates without touching a conversation", async () => {
    const { actuator, calls } = makeActuator({
      respondToAsk: async (ref, text) => `ok ${ref}/${text}`,
    });
    expect(await actuator.answerAsk("abc", "yes")).toBe("ok abc/yes");
    expect(calls).toHaveLength(0);
  });
});

describe("resultText", () => {
  test("returns the turn's text", () => {
    expect(resultText({ type: "result", result: "the answer" })).toBe("the answer");
  });

  test("reports a failed turn rather than going silent", () => {
    // The principal needs to know it failed and why, not receive nothing.
    expect(resultText({ type: "result", subtype: "error_max_turns", is_error: true })).toContain(
      "error_max_turns"
    );
  });

  test("falls back to a placeholder for an empty successful turn", () => {
    expect(resultText({ type: "result", subtype: "success", result: "  " })).toContain("no text");
  });
});

describe("createDrivenSessionActuator — readiness (mt#3234)", () => {
  test("a conversation that never starts is reported, not silently swallowed", async () => {
    // The live incident: the child spawned, never emitted init, and every
    // message routed into it vanished for twenty minutes.
    const { actuator } = makeActuator({ neverReady: true, readyTimeoutMs: 100 });

    await expect(actuator.converse(BLOCKED_Q)).rejects.toThrow(/did not finish starting/);
  });

  test("a failed start is abandoned, so the NEXT message spawns fresh", async () => {
    // Otherwise the dead session is reused forever and the channel never
    // recovers on its own.
    const { actuator, calls } = makeActuator({ neverReady: true, readyTimeoutMs: 100 });

    await expect(actuator.converse("first")).rejects.toThrow();
    await expect(actuator.converse("second")).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  test("input is written BEFORE readiness — the write is what causes init", async () => {
    // The inverse of what mt#3234 asserted, and the reason it deadlocked
    // (mt#3238): `claude -p --input-format stream-json` emits `init` only after
    // it receives input, so gating the write on init means neither ever
    // happens. Measured live: input withheld -> no init, ever; input written
    // -> init at 3006ms.
    const { actuator, calls } = makeActuator({ neverReady: true, readyTimeoutMs: 200 });
    const pending = actuator.converse(BLOCKED_Q);

    await waitForSpawn(calls, 1);
    const spawned = calls[0]?.proc as FakeClaudeProcess;
    // The write lands even though this child will never report ready.
    expect(await waitForWrite(spawned)).toContain(BLOCKED_Q);

    // Readiness is still verified — after the write — so a child that never
    // comes up is abandoned rather than swallowing every future message.
    await expect(pending).rejects.toThrow(/did not finish starting/);
  });

  test("a ready conversation is reused without waiting again", async () => {
    const { actuator, calls } = makeActuator();

    const first = actuator.converse("one");
    await waitForSpawn(calls, 1);
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess);
    calls[0]?.proc.finishTurn("a");
    await first;

    const second = actuator.converse("two");
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess, "two");
    calls[0]?.proc.finishTurn("b");
    expect(await second).toBe("b");
    expect(calls).toHaveLength(1);
  });

  test("concurrent first messages share ONE conversation (PR #2329 R1)", async () => {
    // The poller is sequential today, so this cannot race in practice — but two
    // concurrent starts must still not spawn two children for one standing
    // conversation.
    const { actuator, calls } = makeActuator();

    const a = actuator.converse("one");
    const b = actuator.converse("two");
    await waitForSpawn(calls, 1);
    await waitForWrite(calls[0]?.proc as FakeClaudeProcess);

    expect(calls).toHaveLength(1);
    calls[0]?.proc.finishTurn("answered");
    expect(await a).toBe("answered");
    expect(await b).toBe("answered");
  });
});
