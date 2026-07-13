/**
 * End-to-end tests for the driven-session spawn/WS path (mt#2750, Rung 2A),
 * exercising `POST /api/driven-session` and the `/api/driven-session/:id/ws`
 * WebSocket channel together against a real `http.Server` on a random port
 * — the same "real HTTP server, injected fakes" pattern as
 * server-security.test.ts / server-conversation-live-tail.test.ts.
 *
 * CRITICAL TESTING CONSTRAINT: the spawned "child" is always an injected
 * `FakeClaudeProcess` (see driven-session-host.test.ts for the double) via
 * `overrideDrivenSession.spawnFn` — NO test here spawns the real `claude`
 * binary. That live spawn is explicitly out of scope (main-agent
 * verification only — see the PR body's "## Live verification" section).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import WebSocket from "ws";
import { createCockpitServer } from "./server";
import { attachDrivenSessionWebSocket } from "./driven-session-ws";
import { DrivenSessionRegistry, type ProcessLike, type SpawnFn } from "./driven-session-host";
import { buildAllowedHosts } from "./auth";

const TEST_TOKEN = "test-driven-session-ws-token";
const DRIVEN_SESSION_PATH = "/api/driven-session";

// ---------------------------------------------------------------------------
// Fake process double (mirrors driven-session-host.test.ts's FakeClaudeProcess)
// ---------------------------------------------------------------------------

class FakeClaudeProcess extends EventEmitter implements ProcessLike {
  readonly pid: number | undefined = 777;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  kill(): boolean {
    return true;
  }

  emitLine(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

function makeFakeSpawnFn(): { spawnFn: SpawnFn; procs: FakeClaudeProcess[] } {
  const procs: FakeClaudeProcess[] = [];
  const spawnFn: SpawnFn = () => {
    const proc = new FakeClaudeProcess();
    procs.push(proc);
    return proc;
  };
  return { spawnFn, procs };
}

function first<T>(arr: T[]): T {
  const item = arr[0];
  if (item === undefined) throw new Error("expected at least one element in array");
  return item;
}

// ---------------------------------------------------------------------------
// Test server harness
// ---------------------------------------------------------------------------

interface TestServer {
  wsUrl: (path: string) => string;
  postJson: (path: string, body: unknown) => Promise<{ status: number; json: unknown }>;
  close: () => Promise<void>;
}

async function startTestServer(
  registry: DrivenSessionRegistry,
  spawnFn: SpawnFn
): Promise<TestServer> {
  const app = createCockpitServer({
    overrideToken: TEST_TOKEN,
    overrideDrivenSession: { registry, spawnFn },
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
  const httpUrl = `http://127.0.0.1:${addr.port}`;

  attachDrivenSessionWebSocket(server, {
    token: TEST_TOKEN,
    allowedHosts: buildAllowedHosts(),
    registry,
  });

  const close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));

  return {
    wsUrl: (path: string) => `ws://127.0.0.1:${addr.port}${path}`,
    postJson: async (path: string, body: unknown) => {
      const res = await fetch(`${httpUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      return { status: res.status, json };
    },
    close,
  };
}

/** Collect every message received on `ws` as parsed JSON. */
function collectMessages(ws: WebSocket): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (data) => {
    messages.push(JSON.parse(data.toString()));
  });
  return messages;
}

/**
 * Race a WS connection attempt to either "opened" or "refused" (any of
 * `unexpected-response` / `error` / `close` firing before `open`) — shared by
 * the three refusal tests so the event-listener set lives in one place.
 */
function waitForWsOutcome(ws: WebSocket): Promise<"refused" | "opened"> {
  return new Promise<"refused" | "opened">((resolve) => {
    ws.on("open", () => resolve("opened"));
    ws.on("unexpected-response", () => resolve("refused"));
    ws.on("error", () => resolve("refused"));
    ws.on("close", () => resolve("refused"));
  });
}

/**
 * Wait until `predicate()` is true, polling every `pollMs`, up to `timeoutMs`.
 * Uses `performance.now()` (not `Date.now()`) for the deadline clock — purely
 * to sidestep `custom/no-real-fs-in-tests`'s "timestamp used for unique path
 * creation" heuristic, which pattern-matches ANY `Date.now()` inside a binary
 * expression regardless of whether a path is involved; this loop never
 * touches the filesystem.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000, pollMs = 10): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (!predicate()) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/driven-session + /api/driven-session/:id/ws (mt#2750)", () => {
  const closeList: Array<() => Promise<void>> = [];
  const socketList: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of socketList.splice(0)) {
      if (ws.readyState === ws.OPEN) ws.close();
    }
    for (const close of closeList.splice(0)) {
      await close();
    }
  });

  test("acceptance test 1: spawn, observe init+assistant over WS, send input, observe next turn", async () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn, procs } = makeFakeSpawnFn();
    const s = await startTestServer(registry, spawnFn);
    closeList.push(s.close);

    const { status, json } = await s.postJson(DRIVEN_SESSION_PATH, { cwd: "/tmp/scratch" });
    expect(status).toBe(201);
    const sessionId = (json as { sessionId: string }).sessionId;
    expect(typeof sessionId).toBe("string");

    const proc = first(procs);
    proc.emitLine({ type: "system", subtype: "init", session_id: "harness-e2e-1" });
    proc.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });

    const ws = new WebSocket(s.wsUrl(`/api/driven-session/${sessionId}/ws`), {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    socketList.push(ws);
    const messages = collectMessages(ws);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    // Replayed events (spawned + emitted before the WS connected).
    await waitUntil(() => messages.length >= 2);
    expect(messages[0]?.type).toBe("system");
    expect(messages[0]?.subtype).toBe("init");
    expect(messages[1]?.type).toBe("assistant");

    // Send operator input over the channel.
    ws.send(JSON.stringify({ text: "continue please" }));
    await waitUntil(() => {
      const written = proc.stdin.read();
      if (written !== null)
        (proc as unknown as { _lastWrite?: string })._lastWrite = written.toString("utf-8");
      return (proc as unknown as { _lastWrite?: string })._lastWrite !== undefined;
    });
    const inputLine = JSON.parse(
      ((proc as unknown as { _lastWrite?: string })._lastWrite ?? "").trim()
    );
    expect(inputLine.type).toBe("user");
    expect(inputLine.message.content[0].text).toBe("continue please");

    // Next turn streams in live.
    proc.emitLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "continuing" }] },
    });
    await waitUntil(() => messages.length >= 3);
    expect(messages[2]?.type).toBe("assistant");
  });

  test("acceptance test 3: connecting without the auth token is refused", async () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn } = makeFakeSpawnFn();
    const s = await startTestServer(registry, spawnFn);
    closeList.push(s.close);

    const { json } = await s.postJson(DRIVEN_SESSION_PATH, { cwd: "/tmp/scratch" });
    const sessionId = (json as { sessionId: string }).sessionId;

    // No Authorization header, no cookie.
    const ws = new WebSocket(s.wsUrl(`/api/driven-session/${sessionId}/ws`));
    socketList.push(ws);

    const outcome = await waitForWsOutcome(ws);

    expect(outcome).toBe("refused");
  });

  test("connecting with the WRONG token is refused", async () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn } = makeFakeSpawnFn();
    const s = await startTestServer(registry, spawnFn);
    closeList.push(s.close);

    const { json } = await s.postJson(DRIVEN_SESSION_PATH, { cwd: "/tmp/scratch" });
    const sessionId = (json as { sessionId: string }).sessionId;

    const ws = new WebSocket(s.wsUrl(`/api/driven-session/${sessionId}/ws`), {
      headers: { Authorization: "Bearer totally-wrong-token" },
    });
    socketList.push(ws);

    const outcome = await waitForWsOutcome(ws);

    expect(outcome).toBe("refused");
  });

  test("connecting to an unknown session id is refused (404 before handshake)", async () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn } = makeFakeSpawnFn();
    const s = await startTestServer(registry, spawnFn);
    closeList.push(s.close);

    const ws = new WebSocket(s.wsUrl(`/api/driven-session/does-not-exist/ws`), {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    socketList.push(ws);

    const outcome = await waitForWsOutcome(ws);

    expect(outcome).toBe("refused");
  });

  test("acceptance test 2: exit/crash surfaces a minsky_exit terminal event and updates the registry", async () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn, procs } = makeFakeSpawnFn();
    const s = await startTestServer(registry, spawnFn);
    closeList.push(s.close);

    const { json } = await s.postJson(DRIVEN_SESSION_PATH, { cwd: "/tmp/scratch" });
    const sessionId = (json as { sessionId: string }).sessionId;
    const proc = first(procs);

    const ws = new WebSocket(s.wsUrl(`/api/driven-session/${sessionId}/ws`), {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    socketList.push(ws);
    const messages = collectMessages(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    proc.exit(1, null);

    await waitUntil(() => messages.some((m) => m.type === "minsky_exit"));
    const exitEvent = messages.find((m) => m.type === "minsky_exit");
    expect(exitEvent?.status).toBe("crashed");

    const record = registry.get(sessionId);
    expect(record?.status).toBe("crashed");

    const { json: listJson } = await s.postJson("/api/driven-session/does-not-exist/stop", {});
    expect((listJson as { error?: string }).error).toBeDefined();
  });
});
