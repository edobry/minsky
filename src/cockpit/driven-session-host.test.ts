/**
 * Tests for the driven-session host (mt#2750, Rung 2A).
 *
 * CRITICAL TESTING CONSTRAINT: every test here spawns a `FakeClaudeProcess`
 * (an in-memory EventEmitter + PassThrough double implementing
 * `ProcessLike`) via an injected `spawnFn` — NO test spawns the real `claude`
 * binary. Spawning the genuine binary spends the user's Agent SDK credit
 * (real money) and runs a headless skip-permissions agent; the live spawn is
 * explicitly out of scope here (main-agent verification, see the PR body's
 * "## Live verification" section).
 */
/* eslint-disable custom/no-real-fs-in-tests -- the "no Agent SDK" test's contract IS reading this module's OWN real source file to statically verify its import statements; there is nothing to inject here */
import { describe, test, expect } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { readFileSync } from "fs";
import {
  startDrivenSession,
  sendDrivenSessionInput,
  stopDrivenSession,
  buildDrivenSessionArgs,
  parseStreamJsonLine,
  NewlineSplitter,
  DrivenSessionRegistry,
  CLAUDE_BINARY,
  type ProcessLike,
  type SpawnFn,
  type SpawnOptions,
} from "./driven-session-host";

// ---------------------------------------------------------------------------
// Fake process double
// ---------------------------------------------------------------------------

class FakeClaudeProcess extends EventEmitter implements ProcessLike {
  readonly pid: number | undefined = 424242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }

  /** Simulate the child writing one stream-json line to stdout. */
  emitLine(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  /** Simulate the child writing raw (possibly malformed) text to stdout. */
  emitRaw(text: string): void {
    this.stdout.write(text);
  }

  emitStderr(text: string): void {
    this.stderr.write(text);
  }

  /** Simulate the child process exiting. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

interface SpawnCapture {
  command: string;
  args: string[];
  options: SpawnOptions;
  proc: FakeClaudeProcess;
}

/** Builds a spawnFn that records the call and returns a fresh fake process. */
function makeFakeSpawnFn(): { spawnFn: SpawnFn; calls: SpawnCapture[] } {
  const calls: SpawnCapture[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    const proc = new FakeClaudeProcess();
    calls.push({ command, args, options, proc });
    return proc;
  };
  return { spawnFn, calls };
}

/** Read everything written to a fake's stdin so far, as a UTF-8 string. */
function readStdinWrites(proc: FakeClaudeProcess): string {
  const chunk = proc.stdin.read();
  return chunk === null ? "" : chunk.toString("utf-8");
}

/** Safe array-head accessor — avoids `arr[0]!` non-null assertions (project
 * convention: proper narrowing over `!`, per CLAUDE.md §Error Investigation). */
function first<T>(arr: T[]): T {
  const item = arr[0];
  if (item === undefined) throw new Error("expected at least one element in array");
  return item;
}

const SCRATCH_CWD = "/tmp/scratch-workspace";
const SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";
const PARSE_ERROR_TYPE = "minsky_parse_error";

// ---------------------------------------------------------------------------
// 1. Spawns with the documented flags
// ---------------------------------------------------------------------------

describe("startDrivenSession — spawns with the documented flags", () => {
  test("default (bypassPermissions) argv matches the documented headless invocation", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    startDrivenSession({ cwd: SCRATCH_CWD, spawnFn });

    expect(calls.length).toBe(1);
    const call = first(calls);
    expect(call.command).toBe(CLAUDE_BINARY);
    expect(call.args).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      SKIP_PERMISSIONS_FLAG,
    ]);
    expect(call.options.cwd).toBe(SCRATCH_CWD);
  });

  test("permissionMode 'default' omits --dangerously-skip-permissions", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    startDrivenSession({ cwd: SCRATCH_CWD, permissionMode: "default", spawnFn });

    const call = first(calls);
    expect(call.args).not.toContain(SKIP_PERMISSIONS_FLAG);
    expect(call.args).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ]);
  });

  test("buildDrivenSessionArgs is the same function argv is derived from (no drift)", () => {
    expect(buildDrivenSessionArgs("bypassPermissions")).toContain(SKIP_PERMISSIONS_FLAG);
    expect(buildDrivenSessionArgs("default")).not.toContain(SKIP_PERMISSIONS_FLAG);
  });

  test("a custom command override is honored (test seam)", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    startDrivenSession({ cwd: "/tmp/x", command: "/fake/bin/claude", spawnFn });
    expect(first(calls).command).toBe("/fake/bin/claude");
  });
});

// ---------------------------------------------------------------------------
// 2. Stream-json parsing (init / assistant / stream_event / result / unknown)
// ---------------------------------------------------------------------------

describe("stream-json parsing", () => {
  test("parseStreamJsonLine tolerates malformed JSON without throwing", () => {
    const parsed = parseStreamJsonLine("{not valid json");
    expect(parsed["type"]).toBe(PARSE_ERROR_TYPE);
    expect(parsed["raw"]).toBe("{not valid json");
  });

  test("parseStreamJsonLine tolerates a valid-JSON non-object (e.g. a bare array)", () => {
    const parsed = parseStreamJsonLine("[1,2,3]");
    expect(parsed["type"]).toBe(PARSE_ERROR_TYPE);
  });

  test("NewlineSplitter buffers partial lines across chunks", () => {
    const splitter = new NewlineSplitter();
    expect(splitter.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(splitter.push("2}\n")).toEqual(['{"b":2}']);
  });

  test("init/assistant/stream_event/result events are all forwarded and the init event links the harness session id", () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: "/tmp/x", registry, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    proc.emitLine({ type: "system", subtype: "init", session_id: "harness-abc-123", tools: [] });
    proc.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    proc.emitLine({ type: "stream_event", event: { type: "content_block_delta" } });
    proc.emitLine({ type: "result", subtype: "success", total_cost_usd: 0.01, duration_ms: 10 });

    expect(record.harnessSessionId).toBe("harness-abc-123");
    expect(registry.get("harness-abc-123")).toBe(record);
    expect(registry.get(record.localId)).toBe(record);

    const types = record.eventLog.map((e) => e.payload["type"]);
    expect(types).toEqual(["system", "assistant", "stream_event", "result"]);
    expect(record.status).toBe("running");
  });

  test("an unrecognized event type is tolerated (defensive parsing) and still forwarded", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: "/tmp/x", spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    proc.emitLine({ type: "some_future_event_type_not_yet_documented", weird: true });

    expect(record.eventLog.length).toBe(1);
    expect(first(record.eventLog).payload["type"]).toBe(
      "some_future_event_type_not_yet_documented"
    );
  });

  test("a malformed line does not crash the parser loop — subsequent valid lines still arrive", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: "/tmp/x", spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    proc.emitRaw("not json at all\n");
    proc.emitLine({ type: "assistant", message: {} });

    const types = record.eventLog.map((e) => e.payload["type"]);
    expect(types).toEqual([PARSE_ERROR_TYPE, "assistant"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Input forwarding
// ---------------------------------------------------------------------------

describe("sendDrivenSessionInput", () => {
  test("writes a stream-json user-message line to the fake's stdin", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: "/tmp/x", spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    const ok = sendDrivenSessionInput(record, "hello, driven session");
    expect(ok).toBe(true);

    const written = readStdinWrites(proc).trim();
    const parsed = JSON.parse(written);
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content[0].text).toBe("hello, driven session");
  });

  test("returns false and does not write once the session has exited", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: "/tmp/x", spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;
    proc.exit(0, null);

    const ok = sendDrivenSessionInput(record, "too late");
    expect(ok).toBe(false);
    expect(readStdinWrites(proc)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 4. Registry transitions on exit / crash
// ---------------------------------------------------------------------------

describe("registry lifecycle transitions", () => {
  test("clean exit (code 0) transitions status to 'exited'", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: "/tmp/x", spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    proc.exit(0, null);

    expect(record.status).toBe("exited");
    expect(record.exitCode).toBe(0);
    const terminalEvent = record.eventLog.at(-1);
    expect(terminalEvent?.payload["type"]).toBe("minsky_exit");
    expect(terminalEvent?.payload["status"]).toBe("exited");
  });

  test("nonzero exit code with no stop requested transitions status to 'crashed'", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: "/tmp/x", spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    proc.emitStderr("--dangerously-skip-permissions is not allowed by managed policy\n");
    proc.exit(1, null);

    expect(record.status).toBe("crashed");
    expect(record.exitCode).toBe(1);
    expect(record.crashError).toContain("exited with code=1");
    expect(record.crashError).toContain("managed policy");
    expect(record.crashError).toContain("no init event was ever observed");
  });

  test("a spawn-level error (e.g. ENOENT) transitions status to 'crashed' with a readable message", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: "/tmp/x", spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    proc.emit("error", new Error("spawn claude ENOENT"));

    expect(record.status).toBe("crashed");
    expect(record.crashError).toContain("ENOENT");
    const errorEvent = record.eventLog.find((e) => e.payload["type"] === "minsky_error");
    expect(errorEvent).toBeDefined();
    expect(String(errorEvent?.payload["message"])).toContain("ENOENT");
  });

  test("stopDrivenSession closes stdin and a subsequent exit classifies as 'exited', not 'crashed'", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: "/tmp/x", spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    stopDrivenSession(record, { graceMs: 50 });
    expect(record.stopRequested).toBe(true);
    expect(proc.stdin.writableEnded).toBe(true);

    // The child sees stdin EOF and exits — even via a signal, this is a
    // requested stop, not a crash.
    proc.exit(null, "SIGTERM");
    expect(record.status).toBe("exited");
  });

  test("stopDrivenSession is idempotent on an already-exited record", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: "/tmp/x", spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;
    proc.exit(0, null);

    expect(() => stopDrivenSession(record)).not.toThrow();
    expect(record.status).toBe("exited");
  });
});

// ---------------------------------------------------------------------------
// 5. Nested MCP tool-use event doesn't deadlock (SC5 / acceptance test 4)
// ---------------------------------------------------------------------------

describe("nested MCP tool-use event does not deadlock the host", () => {
  test("a tool_use/tool_result pair mid-stream is just forwarded like any other event", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: "/tmp/x", spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    proc.emitLine({ type: "system", subtype: "init", session_id: "harness-nested-1" });
    proc.emitLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_01",
            name: "mcp__minsky__tasks_get",
            input: { taskId: "mt#2750" },
          },
        ],
      },
    });
    proc.emitLine({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "ok" }],
      },
    });
    proc.emitLine({ type: "result", subtype: "success", total_cost_usd: 0.02 });
    proc.exit(0, null);

    // Reaching this line at all (synchronously, no hang) IS the deadlock
    // assertion — nothing in the host's event handling blocks on a tool_use
    // event or waits for anything outside this synchronous data-push chain.
    expect(record.status).toBe("exited");
    const types = record.eventLog.map((e) => e.payload["type"]);
    expect(types).toEqual(["system", "assistant", "user", "result", "minsky_exit"]);
  });
});

// ---------------------------------------------------------------------------
// 6. Static assertion — NO Agent SDK import anywhere in the host module
// ---------------------------------------------------------------------------

describe("no Agent SDK on the drive path", () => {
  test("driven-session-host.ts has no import/require statement referencing @anthropic-ai/*", () => {
    const source = readFileSync(new URL("./driven-session-host.ts", import.meta.url), "utf-8");
    // Matches actual import/require statements only — NOT doc-comment prose
    // that mentions the package name (this module's own docblock explains
    // the invariant using that string, which a bare substring match would
    // self-defeatingly flag).
    const importStatementPattern = /(?:from|require\()\s*["']@anthropic-ai/;
    expect(source).not.toMatch(importStatementPattern);
  });
});
