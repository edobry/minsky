/**
 * `AcpTransport` recorded-fixture test (mt#4936, AT1).
 *
 * A fake ACP AGENT process — `FakeAcpAgentProcess` — drives the OTHER end of
 * the JSON-RPC connection over the same stdio pipes `AcpTransport` spawns
 * and speaks over, scripted with a fixed sequence of frames recorded from a
 * real ACP session shape (`initialize` → `session/new` → a `prompt` that
 * emits an `agent_message_chunk`, a `tool_call`, a `tool_call_update`, and a
 * `session/request_permission` the client must answer, then a `prompt`
 * result). No `spyOn` anywhere — every seam (`spawnFn`, the credential
 * readers, the ask repository) is a plain injected fake, per
 * `testing-standards.mdc §Testable Design`.
 *
 * CRITICAL TESTING CONSTRAINT (inherited from ../claude-transport.test.ts's
 * identical note): `spawnFn` is always a fake — no test spawns a real `npx`
 * process, which would hit the network.
 *
 * @see ./acp-transport.ts
 * @see mt#4936 AT1
 */
/* eslint-disable custom/no-real-fs-in-tests -- mt#3397: spawn preflights the cwd against the REAL filesystem (probeSpawnCwd), so the test cwd has to be a real directory — there is no fs to inject through the code path under test. Mirrors claude-transport.test.ts's identical constraint. */
import { describe, test, expect, afterAll } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AcpTransport, AcpSubscriptionAuthRefusedError } from "./acp-transport";
import type { DriverTransportEvent, ProcessLike, SpawnFn, SpawnOptions } from "./driver-transport";
import type { AskRepository, CreateAskInput } from "@minsky/domain/ask/repository";
import type { Ask } from "@minsky/domain/ask/types";
import { chunkToString } from "./claude-transport-parsing";

// ---------------------------------------------------------------------------
// Fake ACP agent process — the other end of the wire.
// ---------------------------------------------------------------------------

class FakeAcpAgentProcess extends EventEmitter implements ProcessLike {
  readonly pid: number | undefined = 909090;
  /** What AcpTransport reads from (the agent's stdout). */
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** What AcpTransport writes to (the agent's stdin) — this test reads it
   * to see the client's outbound frames and drive scripted responses. */
  readonly stdin = new PassThrough();
  kill(): boolean {
    return true;
  }
}

interface JsonRpcFrame {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** ndjson line splitter for the client's outbound frames (same convention
 * `@agentclientprotocol/sdk`'s `ndJsonStream` speaks). */
function readFrames(proc: FakeAcpAgentProcess, onFrame: (frame: JsonRpcFrame) => void): void {
  let buffer = "";
  proc.stdin.on("data", (chunk: unknown) => {
    buffer += chunkToString(chunk);
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim().length > 0) onFrame(JSON.parse(line) as JsonRpcFrame);
      idx = buffer.indexOf("\n");
    }
  });
}

function writeFrame(proc: FakeAcpAgentProcess, frame: JsonRpcFrame): void {
  proc.stdout.write(`${JSON.stringify(frame)}\n`);
}

/**
 * Script the fake agent's whole session: respond to `initialize` and
 * `session/new`, and — on `session/prompt` — emit one `agent_message_chunk`,
 * one `tool_call`, one `tool_call_update`, a `session/request_permission`
 * REQUEST the client must answer, and finally the `prompt` result itself.
 * Returns the frames observed for assertions.
 */
function scriptFakeAgent(proc: FakeAcpAgentProcess): { seen: JsonRpcFrame[] } {
  const seen: JsonRpcFrame[] = [];
  let nextAgentRequestId = 100;

  readFrames(proc, (frame) => {
    seen.push(frame);

    if (frame.method === "initialize") {
      writeFrame(proc, {
        jsonrpc: "2.0",
        id: frame.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
      return;
    }

    if (frame.method === "session/new") {
      writeFrame(proc, { jsonrpc: "2.0", id: frame.id, result: { sessionId: "sess-fixture-1" } });
      return;
    }

    if (frame.method === "session/prompt") {
      const params = frame.params as { sessionId: string };
      // agent_message_chunk
      writeFrame(proc, {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        },
      });
      // tool_call (started)
      writeFrame(proc, {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "Run ls",
            kind: "execute",
          },
        },
      });
      // tool_call_update (finished)
      writeFrame(proc, {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" },
        },
      });
      // session/request_permission — a REQUEST, the client must answer.
      const permissionRequestId = nextAgentRequestId;
      nextAgentRequestId += 1;
      writeFrame(proc, {
        jsonrpc: "2.0",
        id: permissionRequestId,
        method: "session/request_permission",
        params: {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "tc-1", title: "Run ls" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      // The client's response to the permission request arrives as a later
      // frame on this SAME stream — this handler will see it (id matches
      // permissionRequestId, no method) and can ignore it; the prompt
      // result is sent once seen.
      const waitForPermissionResponse = (f: JsonRpcFrame): void => {
        if (f.id === permissionRequestId && f.method === undefined) {
          writeFrame(proc, {
            jsonrpc: "2.0",
            id: frame.id,
            result: { stopReason: "end_turn" },
          });
        }
      };
      readFrames(proc, waitForPermissionResponse);
      return;
    }
  });

  return { seen };
}

interface SpawnCapture {
  command: string;
  args: string[];
  options: SpawnOptions;
  proc: FakeAcpAgentProcess;
}

function makeFakeSpawnFn(): { spawnFn: SpawnFn; calls: SpawnCapture[] } {
  const calls: SpawnCapture[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    const proc = new FakeAcpAgentProcess();
    calls.push({ command, args, options, proc });
    return proc;
  };
  return { spawnFn, calls };
}

function first<T>(arr: T[]): T {
  const item = arr[0];
  if (item === undefined) throw new Error("expected at least one element in array");
  return item;
}

// ---------------------------------------------------------------------------
// Fake AskRepository — resolves a permission ask "selected: allow-once" on
// the FIRST getById poll, so the test carries no real wall-clock wait.
// ---------------------------------------------------------------------------

function makeFakeAskRepository(resolution: { optionValue: string } | { policyClose: true }): {
  repo: AskRepository;
  created: CreateAskInput[];
} {
  const created: CreateAskInput[] = [];
  const repo: Partial<AskRepository> = {
    create: async (input) => {
      created.push(input);
      const ask: Ask = {
        id: "ask-fixture-1",
        shortId: "ask#1",
        kind: input.kind,
        classifierVersion: input.classifierVersion,
        requestor: input.requestor,
        state: "suspended",
        routingTarget: "policyClose" in resolution ? "policy" : "operator",
        title: input.title,
        question: input.question,
        options: input.options,
        contextRefs: input.contextRefs,
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      } as unknown as Ask;
      return ask;
    },
    getById: async (id) => {
      const base = created[created.length - 1];
      if (!base) return null;
      if ("policyClose" in resolution) {
        return {
          id,
          state: "closed",
          routingTarget: "policy",
          response: { responder: "policy", payload: {} },
        } as unknown as Ask;
      }
      return {
        id,
        state: "responded",
        routingTarget: "operator",
        response: { responder: "operator", payload: { value: resolution.optionValue } },
      } as unknown as Ask;
    },
  };
  return { repo: repo as AskRepository, created };
}

const TEST_CWD = mkdtempSync(join(tmpdir(), "acp-transport-"));
const BYPASS_PERMISSIONS = "bypassPermissions" as const;
const HARNESS_SESSION_DISCOVERED = "harnessSessionDiscovered" as const;
afterAll(() => {
  rmSync(TEST_CWD, { recursive: true, force: true });
});

describe("AcpTransport — seam refusal (mt#2237/mt#2750, AT4)", () => {
  test('refuses authMode "subscription" — the transport has no subscription posture', () => {
    const { spawnFn } = makeFakeSpawnFn();
    const transport = new AcpTransport({ spawnFn, getOpenAiApiKey: () => "sk-fake" });
    expect(() =>
      transport.spawn({
        cwd: TEST_CWD,
        permissionMode: BYPASS_PERMISSIONS,
        authMode: "subscription",
      })
    ).toThrow(AcpSubscriptionAuthRefusedError);
  });

  test("refuses when authMode is omitted (same as subscription)", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const transport = new AcpTransport({ spawnFn, getOpenAiApiKey: () => "sk-fake" });
    expect(() => transport.spawn({ cwd: TEST_CWD, permissionMode: BYPASS_PERMISSIONS })).toThrow(
      AcpSubscriptionAuthRefusedError
    );
  });

  test("refuses an unknown harnessKind", () => {
    const { spawnFn } = makeFakeSpawnFn();
    const transport = new AcpTransport({ spawnFn, getOpenAiApiKey: () => "sk-fake" });
    const result = transport.spawn({
      cwd: TEST_CWD,
      permissionMode: BYPASS_PERMISSIONS,
      authMode: "api-key",
      harnessKind: "some-unregistered-harness",
    });
    expect(result.ok).toBe(false);
  });
});

describe("AcpTransport — recorded-fixture session (mt#4936 AT1)", () => {
  test("classifies session/update notifications, bridges a permission request, and reports the turn result", async () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const { repo, created } = makeFakeAskRepository({ optionValue: "allow-once" });
    const transport = new AcpTransport({
      spawnFn,
      getOpenAiApiKey: () => "sk-fake-openai",
      createAskRepository: async () => repo,
    });

    const spawnResult = transport.spawn({
      cwd: TEST_CWD,
      permissionMode: BYPASS_PERMISSIONS,
      authMode: "api-key",
      harnessKind: "codex",
      taskId: "mt#4936",
    });
    expect(spawnResult.ok).toBe(true);
    if (!spawnResult.ok) return;

    const proc = first(calls).proc;
    scriptFakeAgent(proc);

    const events: DriverTransportEvent[] = [];
    transport.attach(spawnResult.proc, TEST_CWD, (event) => events.push(event));

    // Wait for session/new to resolve (harnessSessionDiscovered).
    await waitFor(() => events.some((e) => e.kind === HARNESS_SESSION_DISCOVERED));
    const discovered = events.find((e) => e.kind === HARNESS_SESSION_DISCOVERED);
    expect(discovered).toBeDefined();
    if (discovered && discovered.kind === HARNESS_SESSION_DISCOVERED) {
      expect(discovered.harnessSessionId).toBe("sess-fixture-1");
    }

    const sent = transport.sendUserTurn(proc, "please run ls");
    expect(sent).toBe(true);

    await waitFor(() => events.some((e) => e.kind === "turnResult"));

    // assistantDelta
    expect(events.some((e) => e.kind === "assistantDelta")).toBe(true);
    // toolUseStarted (tool_call)
    expect(events.some((e) => e.kind === "toolUseStarted")).toBe(true);
    // toolUseFinished (tool_call_update)
    expect(events.some((e) => e.kind === "toolUseFinished")).toBe(true);
    // permissionRequested
    const permReq = events.find((e) => e.kind === "permissionRequested");
    expect(permReq).toBeDefined();
    if (permReq && permReq.kind === "permissionRequested") {
      expect(permReq.raw["toolTitle"]).toBe("Run ls");
    }
    // turnResult
    const turnResult = events.find((e) => e.kind === "turnResult");
    expect(turnResult).toBeDefined();
    if (turnResult && turnResult.kind === "turnResult") {
      expect(turnResult.summary.subtype).toBe("end_turn");
      expect(turnResult.summary.isError).toBe(false);
    }

    // The permission request became exactly one authorization.approve ask,
    // parented to the drive's bound task.
    expect(created).toHaveLength(1);
    expect(created[0]?.kind).toBe("authorization.approve");
    expect(created[0]?.parentTaskId).toBe("mt#4936");
  });

  test("a phase-1 policy close on the permission ask is NEVER treated as approval (mt#3233 exposure)", async () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const { repo } = makeFakeAskRepository({ policyClose: true });
    const transport = new AcpTransport({
      spawnFn,
      getOpenAiApiKey: () => "sk-fake-openai",
      createAskRepository: async () => repo,
    });

    const spawnResult = transport.spawn({
      cwd: TEST_CWD,
      permissionMode: BYPASS_PERMISSIONS,
      authMode: "api-key",
      harnessKind: "codex",
    });
    expect(spawnResult.ok).toBe(true);
    if (!spawnResult.ok) return;

    const proc = first(calls).proc;
    const seenRef = scriptFakeAgent(proc);

    const events: DriverTransportEvent[] = [];
    transport.attach(spawnResult.proc, TEST_CWD, (event) => events.push(event));
    await waitFor(() => events.some((e) => e.kind === HARNESS_SESSION_DISCOVERED));

    transport.sendUserTurn(proc, "please run ls");
    await waitFor(() => events.some((e) => e.kind === "turnResult"));

    // The client's response to the agent's session/request_permission
    // request must carry outcome "cancelled" — never "selected" — because
    // the ask was closed by policy, not by a human.
    const permissionResponseFrame = seenRef.seen.find(
      (f) =>
        f.method === undefined &&
        typeof f.result === "object" &&
        f.result !== null &&
        "outcome" in (f.result as object)
    );
    expect(permissionResponseFrame).toBeDefined();
    const outcome = (permissionResponseFrame?.result as { outcome: { outcome: string } }).outcome;
    expect(outcome.outcome).toBe("cancelled");
  });

  test("refuses closed when the default ask repository is unreachable under test (fail-closed)", async () => {
    // No createAskRepository override — exercises defaultCreateAskRepository,
    // which under bun test hits db-providers.ts's TestEnvironmentDbAccessError
    // guard (NODE_ENV=test, no opt-in). handlePermissionRequest's catch
    // around createAskRepository() turns that into a logged, closed refusal
    // — never a hang, never a silent approval.
    const { spawnFn, calls } = makeFakeSpawnFn();
    const transport = new AcpTransport({ spawnFn, getOpenAiApiKey: () => "sk-fake-openai" });

    const spawnResult = transport.spawn({
      cwd: TEST_CWD,
      permissionMode: BYPASS_PERMISSIONS,
      authMode: "api-key",
      harnessKind: "codex",
    });
    expect(spawnResult.ok).toBe(true);
    if (!spawnResult.ok) return;

    const proc = first(calls).proc;
    const seenRef = scriptFakeAgent(proc);

    const events: DriverTransportEvent[] = [];
    transport.attach(spawnResult.proc, TEST_CWD, (event) => events.push(event));
    await waitFor(() => events.some((e) => e.kind === HARNESS_SESSION_DISCOVERED));

    transport.sendUserTurn(proc, "please run ls");
    await waitFor(() => events.some((e) => e.kind === "turnResult"));

    const permissionResponseFrame = seenRef.seen.find(
      (f) =>
        f.method === undefined &&
        typeof f.result === "object" &&
        f.result !== null &&
        "outcome" in (f.result as object)
    );
    expect(permissionResponseFrame).toBeDefined();
    const outcome = (permissionResponseFrame?.result as { outcome: { outcome: string } }).outcome;
    expect(outcome.outcome).toBe("cancelled");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
