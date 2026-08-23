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
import { describe, test, expect, afterEach, afterAll } from "bun:test";
/* eslint-disable custom/no-real-fs-in-tests -- mt#3397: the host preflights its spawn cwd against the REAL filesystem, so a cwd fixture has to be a real directory — there is no fs to inject through the code path under test. A per-run mkdtemp dir keeps the "fixed mock path" race the rule guards against from applying. */
import { mkdtempSync, rmSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "http";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import WebSocket from "ws";
import { createCockpitServer } from "./server";
import { attachDrivenSessionWebSocket } from "./driven-session-ws";
import {
  DrivenSessionRegistry,
  buildReconnectingDrivenSessionRecord,
  type ProcessLike,
  type SpawnFn,
} from "./driven-session-host";
import { buildAllowedHosts, COCKPIT_COOKIE_NAME } from "./auth";
import type { orchestrateDrivenSessionResume } from "./driven-session-launch";

const TEST_TOKEN = "test-driven-session-ws-token";
const DRIVEN_SESSION_PATH = "/api/driven-session";
// mt#3397 — the host preflights the spawn cwd, so these end-to-end POSTs need a
// cwd that actually exists or they'd all take the missing-cwd branch instead of
// spawning the fake child.
const SCRATCH_CWD = mkdtempSync(join(tmpdir(), "driven-session-ws-"));
const UNRECOVERABLE_EVENT_TYPE = "minsky_unrecoverable";

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

/**
 * Hermetic default for the restart-recovery seam (mt#3254).
 *
 * Omitting `orchestrateResume` used to fall through to the real
 * `orchestrateDrivenSessionResume`, which calls `getContextInspectorDb()` —
 * the PRODUCTION resolution path. Under `bun test` that resolves whatever the
 * environment points at, which is how this file contributed fixture rows to
 * prod `driven_sessions`. "No persisted row" is the right default for a test
 * that has not set one up; a test needing real resume behavior passes its own.
 */
const notFoundResume: typeof orchestrateDrivenSessionResume = async () => ({
  outcome: "not-found",
});

async function startTestServer(
  registry: DrivenSessionRegistry,
  spawnFn: SpawnFn,
  orchestrateResume: typeof orchestrateDrivenSessionResume = notFoundResume
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
    orchestrateResume,
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

    const { status, json } = await s.postJson(DRIVEN_SESSION_PATH, { cwd: SCRATCH_CWD });
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

    // The operator's own turn comes straight back over the channel (mt#3372) —
    // the child never echoes stdin, so this frame is the host's, and without it
    // the view would show the reply with nothing that prompted it.
    await waitUntil(() => messages.length >= 3);
    expect(messages[2]?.type).toBe("minsky_operator_input");
    expect(messages[2]?.text).toBe("continue please");

    // Next turn streams in live.
    proc.emitLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "continuing" }] },
    });
    await waitUntil(() => messages.length >= 4);
    expect(messages[3]?.type).toBe("assistant");
  });

  test("acceptance test 3: connecting without the auth token is refused", async () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn } = makeFakeSpawnFn();
    const s = await startTestServer(registry, spawnFn);
    closeList.push(s.close);

    const { json } = await s.postJson(DRIVEN_SESSION_PATH, { cwd: SCRATCH_CWD });
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

    const { json } = await s.postJson(DRIVEN_SESSION_PATH, { cwd: SCRATCH_CWD });
    const sessionId = (json as { sessionId: string }).sessionId;

    const ws = new WebSocket(s.wsUrl(`/api/driven-session/${sessionId}/ws`), {
      headers: { Authorization: "Bearer totally-wrong-token" },
    });
    socketList.push(ws);

    const outcome = await waitForWsOutcome(ws);

    expect(outcome).toBe("refused");
  });

  test("cross-origin (different-port) upgrade with a valid cookie is refused — CSRF defense (mt#2750 R1)", async () => {
    // A browser `WebSocket` can't set an Authorization header, so the SPA
    // authenticates the upgrade with the SameSite=Strict cookie — which IS sent
    // to a same-site DIFFERENT-port origin. A malicious `http://127.0.0.1:<other>`
    // page must NOT be able to open an authenticated command-execution channel
    // by riding that cookie. The Origin check refuses it.
    const registry = new DrivenSessionRegistry();
    const { spawnFn } = makeFakeSpawnFn();
    const s = await startTestServer(registry, spawnFn);
    closeList.push(s.close);

    const { json } = await s.postJson(DRIVEN_SESSION_PATH, { cwd: SCRATCH_CWD });
    const sessionId = (json as { sessionId: string }).sessionId;

    const ws = new WebSocket(s.wsUrl(`/api/driven-session/${sessionId}/ws`), {
      headers: {
        Cookie: `${COCKPIT_COOKIE_NAME}=${TEST_TOKEN}`,
        // Different port than the daemon's own — a same-site, cross-origin page.
        Origin: "http://127.0.0.1:1",
      },
    });
    socketList.push(ws);

    const outcome = await waitForWsOutcome(ws);

    expect(outcome).toBe("refused");
  });

  test("same-origin upgrade with a valid cookie is accepted — legitimate SPA path (mt#2750 R1)", async () => {
    // Guards against over-rejection: the real SPA connects with the cookie and a
    // same-origin Origin, which must succeed.
    const registry = new DrivenSessionRegistry();
    const { spawnFn } = makeFakeSpawnFn();
    const s = await startTestServer(registry, spawnFn);
    closeList.push(s.close);

    const { json } = await s.postJson(DRIVEN_SESSION_PATH, { cwd: SCRATCH_CWD });
    const sessionId = (json as { sessionId: string }).sessionId;

    const sameOrigin = s.wsUrl("").replace(/^ws:/, "http:");
    const ws = new WebSocket(s.wsUrl(`/api/driven-session/${sessionId}/ws`), {
      headers: {
        Cookie: `${COCKPIT_COOKIE_NAME}=${TEST_TOKEN}`,
        Origin: sameOrigin,
      },
    });
    socketList.push(ws);

    const outcome = await waitForWsOutcome(ws);

    expect(outcome).toBe("opened");
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

  // Reviewer round 1 (PR #2179) BLOCKING finding — an unrecoverable session
  // with NO in-memory placeholder (e.g. boot reconciliation never loaded
  // this specific row) must still attach with its reason, not 404.
  test("an unrecoverable session with no in-memory record attaches with its reason (not a 404)", async () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn } = makeFakeSpawnFn();
    const s = await startTestServer(registry, spawnFn, async () => ({
      outcome: "unrecoverable",
      reason: "deleted cwd",
    }));
    closeList.push(s.close);

    const ws = new WebSocket(s.wsUrl(`/api/driven-session/never-in-memory/ws`), {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    socketList.push(ws);
    const messages = collectMessages(ws);

    const outcome = await waitForWsOutcome(ws);
    expect(outcome).toBe("opened");

    await waitUntil(() => messages.some((m) => m.type === UNRECOVERABLE_EVENT_TYPE));
    const event = messages.find((m) => m.type === UNRECOVERABLE_EVENT_TYPE);
    expect(event?.reason).toBe("deleted cwd");

    const record = registry.get("never-in-memory");
    expect(record?.status).toBe("unrecoverable");
  });

  // mt#3397 — the host now emits a REAL minsky_unrecoverable event when a spawn
  // races a workspace deletion, so the replayed log can already contain one.
  // The synthetic frame must not double it up.
  test("does not duplicate the unrecoverable frame when the replayed log already carries one", async () => {
    const registry = new DrivenSessionRegistry();
    const reason = "deleted cwd — the workspace directory /tmp/gone no longer exists";
    const record = buildReconnectingDrivenSessionRecord({
      localId: "already-emitted",
      harnessSessionId: "harness-already-emitted",
      cwd: "/tmp/gone",
      permissionMode: "bypassPermissions",
      taskId: null,
      minskySessionId: null,
      status: "unrecoverable",
      unrecoverableReason: reason,
      driverGeneration: 1,
      startedAt: new Date().toISOString(),
    });
    record.eventLog.push({
      seq: 0,
      receivedAt: new Date().toISOString(),
      payload: { type: UNRECOVERABLE_EVENT_TYPE, reason },
    });
    registry.register(record);

    const { spawnFn } = makeFakeSpawnFn();
    const s = await startTestServer(registry, spawnFn);
    closeList.push(s.close);

    const ws = new WebSocket(s.wsUrl(`/api/driven-session/already-emitted/ws`), {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    socketList.push(ws);
    const messages = collectMessages(ws);

    expect(await waitForWsOutcome(ws)).toBe("opened");
    await waitUntil(() => messages.some((m) => m.type === UNRECOVERABLE_EVENT_TYPE));

    expect(messages.filter((m) => m.type === UNRECOVERABLE_EVENT_TYPE)).toHaveLength(1);
  });

  test("acceptance test 2: exit/crash surfaces a minsky_exit terminal event and updates the registry", async () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn, procs } = makeFakeSpawnFn();
    const s = await startTestServer(registry, spawnFn);
    closeList.push(s.close);

    const { json } = await s.postJson(DRIVEN_SESSION_PATH, { cwd: SCRATCH_CWD });
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

  test("routes are NOT mounted for the Railway isPublicDeployment entrypoint (load-bearing invariant)", async () => {
    const registry = new DrivenSessionRegistry();
    const { spawnFn } = makeFakeSpawnFn();
    const app = createCockpitServer({
      overrideToken: TEST_TOKEN,
      isPublicDeployment: true,
      // mt#4023: the public deployment now carries a passkey gate, which would
      // answer 401 before the router could answer 404 — and 401 cannot
      // distinguish "route absent" from "auth blocked it", which is precisely
      // what this test exists to tell apart. Authenticating past the gate keeps
      // the 404 below meaning what it has always meant.
      passkeyStore: {
        listPasskeys: async () => [{ id: "p1", credentialId: "c1", publicKey: "", counter: 0 }],
        findPasskeyByCredentialId: async () => null,
        insertPasskey: async () => "p1",
        updatePasskeyCounter: async () => {},
        createSession: async () => {},
        findValidSession: async () => ({ id: "s1" }),
        deleteSession: async () => {},
      },
      overrideDrivenSession: { registry, spawnFn },
    });
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closeList.push(
      () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    );
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");

    const res = await fetch(`http://127.0.0.1:${addr.port}${DRIVEN_SESSION_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "minsky_cockpit_session=test",
      },
      body: JSON.stringify({ cwd: SCRATCH_CWD }),
    });
    // Authenticated past the mt#4023 passkey gate (see the store double above),
    // so a 404 here specifically confirms the route itself was never mounted
    // — not merely that auth blocked it.
    expect(res.status).toBe(404);
  });
});

// PR #2452 R1 (non-blocking): remove the per-run temp dir so repeated runs do
// not accumulate orphaned directories under the system temp root.
afterAll(() => {
  rmSync(SCRATCH_CWD, { recursive: true, force: true });
});
