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
import { describe, test, expect, afterAll } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  startDrivenSession,
  sendDrivenSessionInput,
  DRIVEN_OPERATOR_INPUT_EVENT_TYPE,
  stopDrivenSession,
  buildDrivenSessionArgs,
  buildResumeSessionArgs,
  resumeDrivenSession,
  INTERRUPTION_NOTICE_TEXT,
  buildReconnectingDrivenSessionRecord,
  parseStreamJsonLine,
  extractResultSummary,
  isDrivenSessionMidTurn,
  NewlineSplitter,
  DrivenSessionRegistry,
  CLAUDE_BINARY,
  probeSpawnCwd,
  probeSpawnCwdAsync,
  type ProcessLike,
  type SpawnFn,
  type SpawnOptions,
  type DrivenSessionCostSummary,
  type DrivenSessionRecord,
  type DrivenSessionSubscriber,
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

// mt#3397 — the host preflights the spawn cwd, so a test cwd has to be a REAL
// directory: a made-up path would silently divert every spawn assertion below
// into the missing-cwd branch. One temp dir per run serves as both the scratch
// workspace and the generic working directory; MISSING_CWD is its deliberately
// never-created sibling, for the tests that DO exercise that branch.
const TEST_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "driven-session-host-"));
const SCRATCH_CWD = TEST_WORKSPACE_ROOT;
const TEST_CWD = TEST_WORKSPACE_ROOT;
const MISSING_CWD = join(TEST_WORKSPACE_ROOT, "deleted-workspace");
const SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";
const PARSE_ERROR_TYPE = "minsky_parse_error";
const BYPASS_PERMISSIONS_MODE = "bypassPermissions";
const RESUME_HARNESS_SESSION_ID = "harness-resume-1";
const MCP_CONFIG_FLAG = "--mcp-config";
const STRICT_MCP_CONFIG_FLAG = "--strict-mcp-config";

// ---------------------------------------------------------------------------
// 1. Spawns with the documented flags
// ---------------------------------------------------------------------------

describe("startDrivenSession — spawns with the documented flags", () => {
  test("default (bypassPermissions) argv matches the documented headless invocation", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    // mcpConfig: null keeps this assertion scoped to the permission-mode flags —
    // the mt#3377 default would otherwise inject a machine-dependent binary path.
    startDrivenSession({ cwd: SCRATCH_CWD, spawnFn, mcpConfig: null });

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
    startDrivenSession({ cwd: SCRATCH_CWD, permissionMode: "default", spawnFn, mcpConfig: null });

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

  // -------------------------------------------------------------------------
  // mt#3377 — a driven session must be provisioned with the minsky MCP server.
  // Before this, the child resolved MCP servers against its cwd (a session
  // workspace, which carries no .mcp.json) and booted with ZERO servers.
  // -------------------------------------------------------------------------

  test("mt#3377: production default provisions the minsky MCP server", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    startDrivenSession({ cwd: SCRATCH_CWD, spawnFn });

    const call = first(calls);
    const configIndex = call.args.indexOf(MCP_CONFIG_FLAG);
    expect(configIndex).toBeGreaterThanOrEqual(0);

    const parsed = JSON.parse(call.args[configIndex + 1] as string);
    expect(Object.keys(parsed.mcpServers)).toEqual(["minsky"]);
    // The server's --repo is the workspace the agent actually works in, so its
    // repo-scoped tools don't resolve against the operator's main checkout.
    expect(parsed.mcpServers.minsky.args).toContain(SCRATCH_CWD);
  });

  test("mt#3377: --strict-mcp-config pins the server set to exactly what we declare", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    startDrivenSession({ cwd: SCRATCH_CWD, spawnFn });

    // Without this the child ALSO loads the operator's ambient claude.ai
    // connectors and plugin servers, making the tool surface machine-dependent.
    expect(first(calls).args).toContain(STRICT_MCP_CONFIG_FLAG);
  });

  test("mt#3377: an explicit null spawns with no MCP config at all", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    startDrivenSession({ cwd: SCRATCH_CWD, spawnFn, mcpConfig: null });

    expect(first(calls).args).not.toContain(MCP_CONFIG_FLAG);
    expect(first(calls).args).not.toContain(STRICT_MCP_CONFIG_FLAG);
  });

  test("buildDrivenSessionArgs is the same function argv is derived from (no drift)", () => {
    expect(buildDrivenSessionArgs(BYPASS_PERMISSIONS_MODE)).toContain(SKIP_PERMISSIONS_FLAG);
    expect(buildDrivenSessionArgs("default")).not.toContain(SKIP_PERMISSIONS_FLAG);
  });

  test("buildDrivenSessionArgs appends --model <alias> when a model is provided (mt#3040)", () => {
    const args = buildDrivenSessionArgs("default", "fable");
    const i = args.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("fable");
  });

  test("buildDrivenSessionArgs omits --model when no model is provided (mt#3040)", () => {
    expect(buildDrivenSessionArgs("default")).not.toContain("--model");
  });

  test("a custom command override is honored (test seam)", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    startDrivenSession({ cwd: TEST_CWD, command: "/fake/bin/claude", spawnFn });
    expect(first(calls).command).toBe("/fake/bin/claude");
  });

  // mt#3243: the principal channel needs ONE durable row it can find again
  // after a restart. A caller-chosen localId gives it a stable upsert key
  // without a schema change or a lookup heuristic.
  test("uses a caller-supplied localId instead of generating one", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({
      cwd: SCRATCH_CWD,
      localId: "principal-channel-standing",
      spawnFn,
    });

    expect(record.localId).toBe("principal-channel-standing");
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
    const { record } = startDrivenSession({ cwd: TEST_CWD, registry, spawnFn });
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
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    proc.emitLine({ type: "some_future_event_type_not_yet_documented", weird: true });

    expect(record.eventLog.length).toBe(1);
    expect(first(record.eventLog).payload["type"]).toBe(
      "some_future_event_type_not_yet_documented"
    );
  });

  test("a malformed line does not crash the parser loop — subsequent valid lines still arrive", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    proc.emitRaw("not json at all\n");
    proc.emitLine({ type: "assistant", message: {} });

    const types = record.eventLog.map((e) => e.payload["type"]);
    expect(types).toEqual([PARSE_ERROR_TYPE, "assistant"]);
  });
});

// ---------------------------------------------------------------------------
// 2b. Cost/usage extraction from the terminal `result` event (mt#2753)
// ---------------------------------------------------------------------------

describe("extractResultSummary", () => {
  test("returns null for a non-result payload", () => {
    expect(extractResultSummary({ type: "assistant" }, 0)).toBeNull();
  });

  test("extracts the full documented shape (live-proof fixture values)", () => {
    // Values from the 2026-07-14 live drive proof (memory 107bce98): a
    // trivial 1-turn prompt dominated by system-prompt/MCP-tool-def cache load.
    const summary = extractResultSummary(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "PONG",
        duration_ms: 7008,
        duration_api_ms: 6500,
        num_turns: 1,
        total_cost_usd: 0.254156,
        usage: {
          input_tokens: 2,
          output_tokens: 26,
          cache_creation_input_tokens: 11861,
          cache_read_input_tokens: 15008,
        },
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 2,
            outputTokens: 26,
            cacheCreationInputTokens: 11861,
            cacheReadInputTokens: 15008,
            costUSD: 0.254156,
          },
        },
      },
      3
    );

    expect(summary).not.toBeNull();
    expect(summary?.turnIndex).toBe(3);
    expect(summary?.subtype).toBe("success");
    expect(summary?.isError).toBe(false);
    expect(summary?.totalCostUsd).toBe(0.254156);
    expect(summary?.durationMs).toBe(7008);
    expect(summary?.durationApiMs).toBe(6500);
    expect(summary?.numTurns).toBe(1);
    expect(summary?.usage).toEqual({
      inputTokens: 2,
      outputTokens: 26,
      cacheCreationInputTokens: 11861,
      cacheReadInputTokens: 15008,
    });
    expect(summary?.modelUsage).toEqual({
      "claude-fable-5": {
        inputTokens: 2,
        outputTokens: 26,
        cacheCreationInputTokens: 11861,
        cacheReadInputTokens: 15008,
        costUsd: 0.254156,
      },
    });
  });

  test("isError is true when is_error is true OR subtype is 'error'", () => {
    expect(extractResultSummary({ type: "result", is_error: true }, 0)?.isError).toBe(true);
    expect(extractResultSummary({ type: "result", subtype: "error" }, 0)?.isError).toBe(true);
    expect(extractResultSummary({ type: "result", subtype: "success" }, 0)?.isError).toBe(false);
  });

  test("missing/malformed fields yield null, never a synthesized zero (no estimation)", () => {
    const summary = extractResultSummary({ type: "result" }, 0);
    expect(summary?.totalCostUsd).toBeNull();
    expect(summary?.durationMs).toBeNull();
    expect(summary?.usage).toBeNull();
    expect(summary?.modelUsage).toBeNull();
    expect(summary?.subtype).toBeNull();
  });

  test("tolerates a non-numeric total_cost_usd (thin upstream schema) without throwing", () => {
    const summary = extractResultSummary({ type: "result", total_cost_usd: "not-a-number" }, 0);
    expect(summary?.totalCostUsd).toBeNull();
  });

  test("tolerates a malformed modelUsage entry (non-object value) by skipping it", () => {
    const summary = extractResultSummary(
      { type: "result", modelUsage: { "model-a": "not-an-object", "model-b": { inputTokens: 5 } } },
      0
    );
    expect(summary?.modelUsage).toEqual({
      "model-b": {
        inputTokens: 5,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        costUsd: null,
      },
    });
  });

  test("an empty modelUsage object yields null, not {}", () => {
    expect(extractResultSummary({ type: "result", modelUsage: {} }, 0)?.modelUsage).toBeNull();
  });
});

describe("cost history + onResultSummary observer (mt#2753)", () => {
  test("each result event appends to record.costHistory with an incrementing turnIndex", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    proc.emitLine({ type: "result", subtype: "success", total_cost_usd: 0.01 });
    proc.emitLine({ type: "result", subtype: "success", total_cost_usd: 0.02 });

    expect(record.costHistory.length).toBe(2);
    expect(record.costHistory[0]?.turnIndex).toBe(0);
    expect(record.costHistory[0]?.totalCostUsd).toBe(0.01);
    expect(record.costHistory[1]?.turnIndex).toBe(1);
    expect(record.costHistory[1]?.totalCostUsd).toBe(0.02);
  });

  test("onResultSummary fires once per result event with the record and summary", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const calls: Array<{ record: DrivenSessionRecord; summary: DrivenSessionCostSummary }> = [];
    const { record } = startDrivenSession({
      cwd: TEST_CWD,
      spawnFn,
      onResultSummary: (rec, summary) => calls.push({ record: rec, summary }),
    });
    const proc = record.proc as unknown as FakeClaudeProcess;

    proc.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    proc.emitLine({ type: "result", subtype: "success", total_cost_usd: 0.03 });

    expect(calls.length).toBe(1);
    expect(calls[0]?.record).toBe(record);
    expect(calls[0]?.summary.totalCostUsd).toBe(0.03);
  });

  test("a throwing onResultSummary observer does not disturb the event loop", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({
      cwd: TEST_CWD,
      spawnFn,
      onResultSummary: () => {
        throw new Error("boom");
      },
    });
    const proc = record.proc as unknown as FakeClaudeProcess;

    expect(() => {
      proc.emitLine({ type: "result", subtype: "success", total_cost_usd: 0.04 });
      proc.emitLine({ type: "assistant", message: { content: [] } });
    }).not.toThrow();

    // The throwing observer still fired (and the extraction still happened),
    // subsequent events still process normally.
    expect(record.costHistory.length).toBe(1);
    const types = record.eventLog.map((e) => e.payload["type"]);
    expect(types).toEqual(["result", "assistant"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Input forwarding
// ---------------------------------------------------------------------------

describe("sendDrivenSessionInput", () => {
  test("writes a stream-json user-message line to the fake's stdin", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
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
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;
    proc.exit(0, null);

    const ok = sendDrivenSessionInput(record, "too late");
    expect(ok).toBe(false);
    expect(readStdinWrites(proc)).toBe("");
  });

  // mt#3235 (PR #2483 R1): an observable behaviour change, pinned so it stays a
  // decision. Blank text used to be written as an empty text block, which the
  // Messages API rejects — the turn failed at the child instead of here. The
  // websocket path can reach this with an empty `text` field.
  test("content-less input is refused rather than written as an empty text block", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    expect(sendDrivenSessionInput(record, "   ")).toBe(false);
    expect(readStdinWrites(proc)).toBe("");
  });

  test("attaches images as Messages API image blocks alongside the text", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    const ok = sendDrivenSessionInput(record, "what is wrong here?", {
      images: [{ base64: "AQID", mediaType: "image/png" }],
    });
    expect(ok).toBe(true);

    const parsed = JSON.parse(readStdinWrites(proc).trim());
    expect(parsed.message.content).toEqual([
      { type: "text", text: "what is wrong here?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ]);
  });

  test("an image with no text sends the image alone, not an empty text block", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    expect(
      sendDrivenSessionInput(record, "", { images: [{ base64: "AQID", mediaType: "image/png" }] })
    ).toBe(true);

    const parsed = JSON.parse(readStdinWrites(proc).trim());
    expect(parsed.message.content).toHaveLength(1);
    expect(parsed.message.content[0].type).toBe("image");
  });

  // mt#3372 — the child never echoes stdin back, so the operator's own turn
  // only reaches the view if the host appends it to the event log itself.
  test("appends exactly one operator-input event to the replayable log", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
    const before = record.eventLog.length;

    expect(sendDrivenSessionInput(record, "what changed in the last hour?")).toBe(true);

    const appended = record.eventLog.slice(before);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.payload["type"]).toBe(DRIVEN_OPERATOR_INPUT_EVENT_TYPE);
    expect(appended[0]?.payload["text"]).toBe("what changed in the last hour?");
    expect(typeof appended[0]?.payload["timestamp"]).toBe("string");
  });

  test("broadcasts the operator-input event to live subscribers", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
    const seen: Record<string, unknown>[] = [];
    record.subscribers.add({ onEvent: (event) => seen.push(event.payload), onSwap: () => {} });

    sendDrivenSessionInput(record, "first");
    sendDrivenSessionInput(record, "second");

    const operatorFrames = seen.filter((p) => p["type"] === DRIVEN_OPERATOR_INPUT_EVENT_TYPE);
    expect(operatorFrames.map((p) => p["text"])).toEqual(["first", "second"]);

    // Same two turns must also survive in the REPLAY source (the event log a
    // reconnecting client is replayed from), in the same order — a subscriber
    // broadcast alone would vanish on reload.
    const replayed = record.eventLog
      .filter((e) => e.payload["type"] === DRIVEN_OPERATOR_INPUT_EVENT_TYPE)
      .map((e) => e.payload["text"]);
    expect(replayed).toEqual(["first", "second"]);
  });

  test("appends nothing when the session has already exited", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;
    proc.exit(0, null);
    const before = record.eventLog.length;

    sendDrivenSessionInput(record, "too late");

    expect(record.eventLog.length).toBe(before);
  });

  test("echo:false delivers the text without attributing it to the operator", () => {
    // The resume path sends a host-authored interruption notice through this
    // same function; echoing it would put words in the operator's mouth.
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;

    expect(sendDrivenSessionInput(record, "a system notice", { echo: false })).toBe(true);

    expect(JSON.parse(readStdinWrites(proc).trim()).message.content[0].text).toBe(
      "a system notice"
    );
    expect(
      record.eventLog.filter((e) => e.payload["type"] === DRIVEN_OPERATOR_INPUT_EVENT_TYPE)
    ).toHaveLength(0);
  });

  test("refuses a reconnecting placeholder rather than rendering a phantom turn", () => {
    // PR #2433 R1. A `reconnecting` record is non-terminal but its proc is the
    // dead placeholder, whose stdin is an inert PassThrough — the write lands
    // nowhere. Echoing there would show the operator a turn that was never
    // delivered, which is worse than the pre-existing silent loss.
    const record = buildReconnectingDrivenSessionRecord({
      localId: "reconnecting-local-id",
      harnessSessionId: "harness-id",
      cwd: TEST_CWD,
      permissionMode: "bypassPermissions",
      taskId: null,
      minskySessionId: null,
      status: "reconnecting",
      unrecoverableReason: null,
      driverGeneration: 1,
      startedAt: new Date().toISOString(),
    });

    expect(sendDrivenSessionInput(record, "into the void")).toBe(false);
    expect(record.eventLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Registry transitions on exit / crash
// ---------------------------------------------------------------------------

describe("registry lifecycle transitions", () => {
  test("clean exit (code 0) transitions status to 'exited'", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
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
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
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
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
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
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
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
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
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
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn });
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

// ---------------------------------------------------------------------------
// 7. Session driver swap / resume-respawn (mt#3038 R1 deltas #2/#3/#5)
// ---------------------------------------------------------------------------

describe("buildResumeSessionArgs", () => {
  test("inserts --resume <harnessSessionId> right after -p", () => {
    const args = buildResumeSessionArgs(BYPASS_PERMISSIONS_MODE, "harness-xyz");
    expect(args.slice(0, 3)).toEqual(["-p", "--resume", "harness-xyz"]);
    expect(args).toContain(SKIP_PERMISSIONS_FLAG);
  });

  test("omits the skip-permissions flag under default permission mode", () => {
    const args = buildResumeSessionArgs("default", "harness-xyz");
    expect(args).not.toContain(SKIP_PERMISSIONS_FLAG);
  });

  // mt#3040 preservation (interaction fix) — a resume must keep the
  // originally-selected model, not silently fall back to default.
  test("embeds --model <alias> when a model is provided", () => {
    const args = buildResumeSessionArgs("default", "harness-xyz", "fable");
    const i = args.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("fable");
  });

  test("omits --model when none is provided", () => {
    expect(buildResumeSessionArgs("default", "harness-xyz")).not.toContain("--model");
  });
});

describe("resumeDrivenSession — replaces the dead record for the SAME localId", () => {
  test("spawns claude --resume with the previous cwd/permissionMode and a fresh proc", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const registry = new DrivenSessionRegistry();
    const { record: original } = startDrivenSession({ cwd: SCRATCH_CWD, spawnFn, registry });
    const originalProc = original.proc as unknown as FakeClaudeProcess;
    originalProc.emitLine({
      type: "system",
      subtype: "init",
      session_id: RESUME_HARNESS_SESSION_ID,
    });
    originalProc.exit(1, null); // simulate the daemon-restart kill

    const { record: resumed } = resumeDrivenSession({
      previous: {
        localId: original.localId,
        cwd: original.cwd,
        permissionMode: original.permissionMode,
        harnessSessionId: RESUME_HARNESS_SESSION_ID,
        taskId: original.taskId,
        minskySessionId: original.minskySessionId,
        startedAt: original.startedAt,
        driverGeneration: original.driverGeneration,
      },
      spawnFn,
      registry,
    });

    expect(resumed.localId).toBe(original.localId);
    expect(resumed.harnessSessionId).toBe(RESUME_HARNESS_SESSION_ID);
    expect(resumed.driverGeneration).toBe(1);
    expect(resumed.status).toBe("spawned");
    expect(registry.get(original.localId)).toBe(resumed);

    const resumeCall = calls[1];
    expect(resumeCall).toBeDefined();
    expect(resumeCall?.args.slice(0, 3)).toEqual(["-p", "--resume", RESUME_HARNESS_SESSION_ID]);
    expect(resumeCall?.options.cwd).toBe(SCRATCH_CWD);
  });

  test("mt#3377: a resume re-provisions the MCP config rather than dropping it", () => {
    // The conversation is durable and the session driver is disposable — so a resume
    // that forgot the servers would silently strip the whole MCP tool surface
    // at the first daemon restart, mid-conversation.
    const { spawnFn, calls } = makeFakeSpawnFn();
    const registry = new DrivenSessionRegistry();
    const { record: original } = startDrivenSession({ cwd: SCRATCH_CWD, spawnFn, registry });
    const originalProc = original.proc as unknown as FakeClaudeProcess;
    originalProc.emitLine({
      type: "system",
      subtype: "init",
      session_id: RESUME_HARNESS_SESSION_ID,
    });
    originalProc.exit(1, null);

    resumeDrivenSession({
      previous: {
        localId: original.localId,
        cwd: original.cwd,
        permissionMode: original.permissionMode,
        harnessSessionId: RESUME_HARNESS_SESSION_ID,
        taskId: original.taskId,
        minskySessionId: original.minskySessionId,
        startedAt: original.startedAt,
        driverGeneration: original.driverGeneration,
      },
      spawnFn,
      registry,
    });

    const resumeArgs = calls[1]?.args ?? [];
    const configIndex = resumeArgs.indexOf(MCP_CONFIG_FLAG);
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(resumeArgs).toContain(STRICT_MCP_CONFIG_FLAG);

    const parsed = JSON.parse(resumeArgs[configIndex + 1] as string);
    expect(Object.keys(parsed.mcpServers)).toEqual(["minsky"]);
    expect(parsed.mcpServers.minsky.args).toContain(SCRATCH_CWD);
  });

  // mt#3040 preservation (interaction fix) — the originally-selected model
  // must survive a resume, not silently fall back to the CLI's default.
  test("preserves the previously-selected model in the resume argv", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const registry = new DrivenSessionRegistry();
    resumeDrivenSession({
      previous: {
        localId: "local-model-preserve",
        cwd: SCRATCH_CWD,
        permissionMode: "default",
        harnessSessionId: "harness-model-1",
        taskId: null,
        minskySessionId: null,
        startedAt: new Date().toISOString(),
        driverGeneration: 0,
        model: "fable",
      },
      spawnFn,
      registry,
    });
    const call = first(calls);
    const i = call.args.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(call.args[i + 1]).toBe("fable");
  });

  test("injects INTERRUPTION_NOTICE_TEXT as the first stdin write by default", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const registry = new DrivenSessionRegistry();
    const { record: resumed } = resumeDrivenSession({
      previous: {
        localId: "local-fixed-id",
        cwd: SCRATCH_CWD,
        permissionMode: BYPASS_PERMISSIONS_MODE,
        harnessSessionId: "harness-abc",
        taskId: null,
        minskySessionId: null,
        startedAt: new Date().toISOString(),
        driverGeneration: 0,
      },
      spawnFn,
      registry,
    });
    const proc = resumed.proc as unknown as FakeClaudeProcess;
    const written = readStdinWrites(proc);
    const parsed = JSON.parse(written.trim());
    expect(parsed.message.content[0].text).toBe(INTERRUPTION_NOTICE_TEXT);
  });

  test("skipInterruptionNotice suppresses the injected notice (test seam)", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const registry = new DrivenSessionRegistry();
    const { record: resumed } = resumeDrivenSession({
      previous: {
        localId: "local-fixed-id-2",
        cwd: SCRATCH_CWD,
        permissionMode: BYPASS_PERMISSIONS_MODE,
        harnessSessionId: "harness-def",
        taskId: null,
        minskySessionId: null,
        startedAt: new Date().toISOString(),
        driverGeneration: 3,
      },
      spawnFn,
      registry,
      skipInterruptionNotice: true,
    });
    expect(resumed.driverGeneration).toBe(4);
    const proc = resumed.proc as unknown as FakeClaudeProcess;
    expect(readStdinWrites(proc)).toBe("");
  });
});

describe("DrivenSessionRegistry.replace — forces existing subscribers to swap", () => {
  test("calls onSwap on every subscriber of the OLD record, never onEvent", () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn } = makeFakeSpawnFn();
    const { record: original } = startDrivenSession({
      cwd: SCRATCH_CWD,
      spawnFn,
      registry,
    });

    let swapped = 0;
    let eventsAfterSwap = 0;
    const subscriber: DrivenSessionSubscriber = {
      onEvent: () => {
        eventsAfterSwap += 1;
      },
      onSwap: () => {
        swapped += 1;
      },
    };
    original.subscribers.add(subscriber);

    const replacement: DrivenSessionRecord = {
      ...original,
      status: "spawned",
      driverGeneration: original.driverGeneration + 1,
      subscribers: new Set(),
    };
    registry.replace(original.localId, replacement);

    expect(swapped).toBe(1);
    expect(eventsAfterSwap).toBe(0);
    expect(registry.get(original.localId)).toBe(replacement);
  });

  test("a subscriber's throwing onSwap does not stop the swap or affect other subscribers", () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn } = makeFakeSpawnFn();
    const { record: original } = startDrivenSession({
      cwd: SCRATCH_CWD,
      spawnFn,
      registry,
    });

    let secondSwapped = false;
    original.subscribers.add({
      onEvent: () => {},
      onSwap: () => {
        throw new Error("boom");
      },
    });
    original.subscribers.add({
      onEvent: () => {},
      onSwap: () => {
        secondSwapped = true;
      },
    });

    const replacement: DrivenSessionRecord = {
      ...original,
      subscribers: new Set(),
    };
    registry.replace(original.localId, replacement);

    expect(secondSwapped).toBe(true);
    expect(registry.get(original.localId)).toBe(replacement);
  });
});

describe("sendDrivenSessionInput / stopDrivenSession treat 'unrecoverable' as terminal", () => {
  test("sendDrivenSessionInput returns false against an unrecoverable record", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: SCRATCH_CWD, spawnFn });
    record.status = "unrecoverable";
    record.unrecoverableReason = "deleted cwd";
    expect(sendDrivenSessionInput(record, "hello")).toBe(false);
  });

  test("stopDrivenSession is a no-op against an unrecoverable record", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: SCRATCH_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;
    record.status = "unrecoverable";
    stopDrivenSession(record);
    expect(proc.killSignals.length).toBe(0);
  });
});

// Reviewer round 1 (PR #2179) — a finding raised a concern about
// wireChildProcess's crash-handling referencing state (argv/command) that
// could be "empty" for a boot placeholder. `wireChildProcess` is NEVER
// invoked against a boot placeholder's proc in the first place — it is only
// called from startDrivenSession/resumeDrivenSession, both of which always
// construct a REAL (fake-in-tests) spawned proc with non-empty argv. This
// proves the placeholder's proc is genuinely inert: none of its event
// listeners ever fire, so no crash-message construction path can ever run
// against it, empty argv or not.
describe("boot-reconciliation placeholder's proc is inert (never wired, never fires)", () => {
  test("createDeadProcessPlaceholder's on()/kill() never invoke a listener or throw", () => {
    const record = buildReconnectingDrivenSessionRecord({
      localId: "local-placeholder-1",
      harnessSessionId: "harness-placeholder-1",
      cwd: "/tmp/placeholder",
      permissionMode: "default",
      taskId: null,
      minskySessionId: null,
      status: "reconnecting",
      unrecoverableReason: null,
      driverGeneration: 0,
      startedAt: new Date().toISOString(),
    });

    expect(record.argv).toEqual([]);
    expect(record.pid).toBeUndefined();

    let exitFired = false;
    // Registering a listener the same way wireChildProcess would — proves
    // the placeholder's `on()` is a genuine no-op, not merely unused.
    record.proc.on("exit", () => {
      exitFired = true;
    });
    expect(exitFired).toBe(false);

    expect(record.proc.kill()).toBe(false);
    expect(() => record.proc.stdin.write("should be silently accepted")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// mt#3048 — mid-turn signal (cockpit-tray watcher's pre-restart gate)
// ---------------------------------------------------------------------------

describe("isDrivenSessionMidTurn (mt#3048)", () => {
  test("a freshly-spawned record with no events yet is mid-turn", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: SCRATCH_CWD, spawnFn });
    expect(record.eventLog.length).toBe(0);
    expect(isDrivenSessionMidTurn(record)).toBe(true);
  });

  test("becomes mid-turn once a non-terminal event (e.g. system/init) is observed", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: SCRATCH_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;
    proc.emitLine({ type: "system", subtype: "init", session_id: "harness-1" });
    expect(isDrivenSessionMidTurn(record)).toBe(true);
  });

  test("is NOT mid-turn once the latest event is a terminal 'result' (turn finished, idle between turns)", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: SCRATCH_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;
    proc.emitLine({ type: "system", subtype: "init", session_id: "harness-1" });
    proc.emitLine({ type: "assistant", message: { content: [] } });
    proc.emitLine({ type: "result", subtype: "success", total_cost_usd: 0.01 });
    expect(isDrivenSessionMidTurn(record)).toBe(false);
  });

  test("becomes mid-turn again once a NEW turn starts after a prior 'result'", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: SCRATCH_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;
    proc.emitLine({ type: "result", subtype: "success", total_cost_usd: 0.01 });
    expect(isDrivenSessionMidTurn(record)).toBe(false);
    // Operator sends the next turn's input; the child starts streaming again.
    proc.emitLine({ type: "assistant", message: { content: [] } });
    expect(isDrivenSessionMidTurn(record)).toBe(true);
  });

  test("is NOT mid-turn once the session driver has exited (latest event is minsky_exit)", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: SCRATCH_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;
    proc.emitLine({ type: "assistant", message: { content: [] } });
    expect(isDrivenSessionMidTurn(record)).toBe(true);
    proc.exit(0, null);
    expect(record.status).toBe("exited");
    expect(isDrivenSessionMidTurn(record)).toBe(false);
  });

  test("a crashed record is NOT mid-turn even mid-stream at time of crash", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const { record } = startDrivenSession({ cwd: SCRATCH_CWD, spawnFn });
    const proc = record.proc as unknown as FakeClaudeProcess;
    proc.emitLine({ type: "assistant", message: { content: [] } });
    proc.exit(1, null);
    expect(record.status).toBe("crashed");
    expect(isDrivenSessionMidTurn(record)).toBe(false);
  });

  test("a 'reconnecting' boot-placeholder record is NOT mid-turn (no live session driver to interrupt)", () => {
    const record = buildReconnectingDrivenSessionRecord({
      localId: "local-reconnecting-1",
      harnessSessionId: "harness-reconnecting-1",
      cwd: "/tmp/reconnecting",
      permissionMode: "default",
      taskId: null,
      minskySessionId: null,
      status: "reconnecting",
      unrecoverableReason: null,
      driverGeneration: 1,
      startedAt: new Date().toISOString(),
    });
    expect(isDrivenSessionMidTurn(record)).toBe(false);
  });

  test("an 'unrecoverable' record is NOT mid-turn", () => {
    const record = buildReconnectingDrivenSessionRecord({
      localId: "local-unrecoverable-1",
      harnessSessionId: null,
      cwd: "/tmp/unrecoverable",
      permissionMode: "default",
      taskId: null,
      minskySessionId: null,
      status: "unrecoverable",
      unrecoverableReason: "spawn-died-before-init",
      driverGeneration: 0,
      startedAt: new Date().toISOString(),
    });
    expect(isDrivenSessionMidTurn(record)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Spawn-cwd preflight (mt#3397)
// ---------------------------------------------------------------------------

describe("probeSpawnCwd (mt#3397)", () => {
  test("an existing directory is 'present'", () => {
    expect(probeSpawnCwd(TEST_WORKSPACE_ROOT)).toBe("present");
  });

  test("a path that does not exist is 'missing'", () => {
    expect(probeSpawnCwd(MISSING_CWD)).toBe("missing");
  });

  test("a path that exists but is a FILE is 'missing' — spawn needs a directory", () => {
    const filePath = join(TEST_WORKSPACE_ROOT, "not-a-directory.txt");
    writeFileSync(filePath, "x");
    expect(probeSpawnCwd(filePath)).toBe("missing");
  });
});

describe("startDrivenSession — missing cwd (mt#3397)", () => {
  test("does not spawn, and returns a terminal unrecoverable record naming the path", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const registry = new DrivenSessionRegistry();

    const { record } = startDrivenSession({ cwd: MISSING_CWD, spawnFn, registry });

    // The whole point: no child process is created at all.
    expect(calls.length).toBe(0);
    expect(record.status).toBe("unrecoverable");
    expect(record.unrecoverableReason).toContain(MISSING_CWD);
    // The operator must not be sent looking at their PATH for a cwd problem.
    expect(record.unrecoverableReason).not.toContain(CLAUDE_BINARY);
    expect(record.pid).toBeUndefined();
    // Registered under its own id, so the route can hand back a real session.
    expect(registry.get(record.localId)).toBe(record);
  });

  test("notifies the state-change observer, which is what persists the verdict", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const observed: DrivenSessionRecord[] = [];

    startDrivenSession({
      cwd: MISSING_CWD,
      spawnFn,
      registry: new DrivenSessionRegistry(),
      onStateChange: (record) => observed.push(record),
    });

    expect(observed.length).toBe(1);
    expect(first(observed).status).toBe("unrecoverable");
  });
});

describe("resumeDrivenSession — missing cwd (mt#3397, acceptance test 1)", () => {
  test("does not spawn; replaces the record with a terminal unrecoverable one", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const registry = new DrivenSessionRegistry();
    const { record: original } = startDrivenSession({
      cwd: TEST_CWD,
      spawnFn,
      registry,
      mcpConfig: null,
    });
    registry.linkHarnessId(original, RESUME_HARNESS_SESSION_ID);
    const spawnsBeforeResume = calls.length;

    const { record } = resumeDrivenSession({
      previous: {
        localId: original.localId,
        // The workspace was deleted out from under the conversation.
        cwd: MISSING_CWD,
        permissionMode: BYPASS_PERMISSIONS_MODE,
        harnessSessionId: RESUME_HARNESS_SESSION_ID,
        taskId: null,
        minskySessionId: null,
        startedAt: original.startedAt,
        driverGeneration: original.driverGeneration,
      },
      spawnFn,
      registry,
      mcpConfig: null,
    });

    expect(calls.length).toBe(spawnsBeforeResume);
    expect(record.status).toBe("unrecoverable");
    expect(record.unrecoverableReason).toContain(MISSING_CWD);
    // Same conversation, same session driver count — nothing new was started.
    expect(record.localId).toBe(original.localId);
    expect(record.harnessSessionId).toBe(RESUME_HARNESS_SESSION_ID);
    expect(record.driverGeneration).toBe(original.driverGeneration);
    expect(registry.get(original.localId)).toBe(record);
  });

  test("swaps existing subscribers so an open socket redials onto the terminal state", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const registry = new DrivenSessionRegistry();
    const { record: original } = startDrivenSession({
      cwd: TEST_CWD,
      spawnFn,
      registry,
      mcpConfig: null,
    });
    let swapped = 0;
    const subscriber: DrivenSessionSubscriber = {
      onEvent: () => undefined,
      onSwap: () => {
        swapped += 1;
      },
    };
    original.subscribers.add(subscriber);

    resumeDrivenSession({
      previous: {
        localId: original.localId,
        cwd: MISSING_CWD,
        permissionMode: BYPASS_PERMISSIONS_MODE,
        harnessSessionId: RESUME_HARNESS_SESSION_ID,
        taskId: null,
        minskySessionId: null,
        startedAt: original.startedAt,
        driverGeneration: 0,
      },
      spawnFn,
      registry,
      mcpConfig: null,
    });

    expect(swapped).toBe(1);
  });
});

describe("spawn ENOENT disambiguation (mt#3397, acceptance test 4)", () => {
  /** Build the exact error Node raises for both ENOENT causes. */
  function enoentError(command: string): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error(
      `spawn ${command} ENOENT: no such file or directory, posix_spawn '${command}'`
    );
    err.code = "ENOENT";
    return err;
  }

  test("with the cwd intact, an ENOENT reports a PATH problem — not a cwd one", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const registry = new DrivenSessionRegistry();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn, registry, mcpConfig: null });

    first(calls).proc.emit("error", enoentError(CLAUDE_BINARY));

    expect(record.status).toBe("crashed");
    expect(record.crashError).toContain("PATH");
    expect(record.crashError).toContain(CLAUDE_BINARY);
    expect(record.unrecoverableReason).toBeNull();
  });

  test("when the cwd vanished mid-spawn, the same ENOENT is unrecoverable, not crashed", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const registry = new DrivenSessionRegistry();
    // Preflight passes, then the directory disappears before the spawn lands.
    const raceCwd = mkdtempSync(join(tmpdir(), "driven-session-race-"));
    const { record } = startDrivenSession({ cwd: raceCwd, spawnFn, registry, mcpConfig: null });
    rmSync(raceCwd, { recursive: true, force: true });

    first(calls).proc.emit("error", enoentError(CLAUDE_BINARY));

    expect(record.status).toBe("unrecoverable");
    expect(record.unrecoverableReason).toContain(raceCwd);
    // And the client is told in the vocabulary it renders read-only with.
    const terminal = record.eventLog.at(-1);
    expect(terminal?.payload["type"]).toBe("minsky_unrecoverable");
    expect(terminal?.payload["reason"]).toContain(raceCwd);
  });

  test("a non-ENOENT spawn error is untouched by the disambiguation", () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const registry = new DrivenSessionRegistry();
    const { record } = startDrivenSession({ cwd: TEST_CWD, spawnFn, registry, mcpConfig: null });

    first(calls).proc.emit("error", new Error("EACCES: permission denied"));

    expect(record.status).toBe("crashed");
    expect(record.crashError).toContain("EACCES");
    expect(record.crashError).not.toContain("PATH");
  });
});

// PR #2452 R1 (BLOCKING): the boot-reconciliation and resume loops probe
// asynchronously so a slow or unresponsive workspace path cannot hold the
// daemon's event loop. The two verdicts must agree, or the same workspace would
// classify differently depending on which caller asked.
describe("probeSpawnCwdAsync (mt#3397, PR #2452 R1)", () => {
  test("agrees with the sync probe on an existing directory", async () => {
    expect(await probeSpawnCwdAsync(TEST_WORKSPACE_ROOT)).toBe("present");
    expect(await probeSpawnCwdAsync(TEST_WORKSPACE_ROOT)).toBe(probeSpawnCwd(TEST_WORKSPACE_ROOT));
  });

  test("agrees with the sync probe on a path that does not exist", async () => {
    expect(await probeSpawnCwdAsync(MISSING_CWD)).toBe("missing");
    expect(await probeSpawnCwdAsync(MISSING_CWD)).toBe(probeSpawnCwd(MISSING_CWD));
  });

  test("agrees with the sync probe on a path that is a file, not a directory", async () => {
    const filePath = join(TEST_WORKSPACE_ROOT, "async-not-a-directory.txt");
    writeFileSync(filePath, "x");
    expect(await probeSpawnCwdAsync(filePath)).toBe("missing");
    expect(await probeSpawnCwdAsync(filePath)).toBe(probeSpawnCwd(filePath));
  });
});

// PR #2452 R1 (non-blocking): remove the per-run temp dir so repeated runs do
// not accumulate orphaned directories under the system temp root.
afterAll(() => {
  rmSync(TEST_WORKSPACE_ROOT, { recursive: true, force: true });
});
