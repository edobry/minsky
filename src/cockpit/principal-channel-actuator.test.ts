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

class FakeClaudeProcess extends EventEmitter implements ProcessLike {
  readonly pid: number | undefined = 424242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  kill(): boolean {
    return true;
  }

  emitLine(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
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

function fakeSpawn(): { spawnFn: SpawnFn; calls: SpawnCapture[] } {
  const calls: SpawnCapture[] = [];
  const spawnFn: SpawnFn = (_command, args, options) => {
    const proc = new FakeClaudeProcess();
    calls.push({ args, options, proc });
    return proc;
  };
  return { spawnFn, calls };
}

function readStdin(proc: FakeClaudeProcess): string {
  const chunk = proc.stdin.read();
  return chunk === null ? "" : String(chunk);
}

function makeActuator(
  overrides: {
    respondToAsk?: (ref: string, text: string) => Promise<string>;
    turnTimeoutMs?: number;
    permissionMode?: "default" | "bypassPermissions";
  } = {}
) {
  const { spawnFn, calls } = fakeSpawn();
  const registry = new DrivenSessionRegistry();
  const actuator = createDrivenSessionActuator({
    cwd: CWD,
    registry,
    spawnFn,
    respondToAsk: overrides.respondToAsk ?? (async (ref, text) => `answered ${ref}: ${text}`),
    ...(overrides.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: overrides.turnTimeoutMs }),
    ...(overrides.permissionMode === undefined ? {} : { permissionMode: overrides.permissionMode }),
  });
  return { actuator, calls, registry };
}

/** Yield to the event loop so piped stdout data is parsed into events. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("createDrivenSessionActuator — conversing", () => {
  test("spawns a conversation on the first message and returns the turn's text", async () => {
    const { actuator, calls } = makeActuator();

    const reply = actuator.converse("what is blocked?");
    await flush();
    expect(calls).toHaveLength(1);
    expect(readStdin(calls[0]?.proc as FakeClaudeProcess)).toContain("what is blocked?");

    calls[0]?.proc.finishTurn("nothing is blocked");
    expect(await reply).toBe("nothing is blocked");
  });

  test("REUSES the conversation across messages", async () => {
    // The whole point: "focus on that one" only resolves against what was
    // just said, so a second message must not get a fresh session.
    const { actuator, calls } = makeActuator();

    const first = actuator.converse("list the tasks");
    await flush();
    calls[0]?.proc.finishTurn("three tasks");
    await first;

    const second = actuator.converse("focus on the second one");
    await flush();
    calls[0]?.proc.finishTurn("focusing");
    await second;

    expect(calls).toHaveLength(1);
  });

  test("starts a new conversation transparently after the old one exits", async () => {
    // The principal should never have to know a process died.
    const { actuator, calls } = makeActuator();

    const first = actuator.converse("hi");
    await flush();
    calls[0]?.proc.finishTurn("hello");
    await first;

    calls[0]?.proc.exit(1);
    await flush();

    const second = actuator.converse("still there?");
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]?.proc.finishTurn("yes");
    expect(await second).toBe("yes");
  });

  test("spawns with the requested permission mode", async () => {
    const { actuator, calls } = makeActuator({ permissionMode: "default" });
    void actuator.converse("hi");
    await flush();
    expect(calls[0]?.args).not.toContain("--dangerously-skip-permissions");
  });

  test("defaults to the same permission mode as every other driven session", async () => {
    const { actuator, calls } = makeActuator();
    void actuator.converse("hi");
    await flush();
    expect(calls[0]?.args).toContain("--dangerously-skip-permissions");
  });

  test("runs in the configured working directory", async () => {
    const { actuator, calls } = makeActuator();
    void actuator.converse("hi");
    await flush();
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
    await flush();
    calls[0]?.proc.finishTurn("hello");
    await first;

    await actuator.interrupt();
    void actuator.converse("again");
    await flush();
    expect(calls).toHaveLength(2);
  });

  test("reset drops the conversation even when idle", async () => {
    const { actuator, calls } = makeActuator();
    expect(await actuator.reset()).toContain("Starting fresh");
    void actuator.converse("hi");
    await flush();
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
