/**
 * Tests for the driven-session routes (mt#2750 shapes + mt#2752 task-bound
 * launch).
 *
 * Same CRITICAL TESTING CONSTRAINT as ../driven-session-host.test.ts: every
 * test injects a fake `spawnFn` — NO test spawns the real `claude` binary
 * (real money, headless skip-permissions agent). The task→workspace resolver
 * and the init-link observer are injected fakes too — no session_start
 * machinery, no Postgres.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { Server } from "http";
import express from "express";
import {
  DrivenSessionRegistry,
  type DrivenSessionRecord,
  type ProcessLike,
  type SpawnFn,
  type SpawnOptions,
} from "../driven-session-host";
import { mountDrivenSessionRoutes } from "./driven-sessions";
import type { ResolvedTaskWorkspace } from "../driven-session-launch";

// ---------------------------------------------------------------------------
// Fakes (mirrors ../driven-session-host.test.ts's FakeClaudeProcess)
// ---------------------------------------------------------------------------

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
}

interface SpawnCapture {
  command: string;
  args: string[];
  options: SpawnOptions;
  proc: FakeClaudeProcess;
}

function makeFakeSpawnFn(): { spawnFn: SpawnFn; calls: SpawnCapture[] } {
  const calls: SpawnCapture[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    const proc = new FakeClaudeProcess();
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
// Ephemeral-server harness
// ---------------------------------------------------------------------------

const servers: Server[] = [];

interface Harness {
  url: string;
  registry: DrivenSessionRegistry;
  calls: SpawnCapture[];
  linked: DrivenSessionRecord[];
}

async function makeHarness(opts?: {
  resolveTaskWorkspace?: (taskId: string) => Promise<ResolvedTaskWorkspace>;
  scratchCwd?: string;
}): Promise<Harness> {
  const registry = new DrivenSessionRegistry();
  const { spawnFn, calls } = makeFakeSpawnFn();
  const linked: DrivenSessionRecord[] = [];

  const app = express();
  app.use(express.json());
  mountDrivenSessionRoutes(app, {
    registry,
    spawnFn,
    resolveTaskWorkspace: opts?.resolveTaskWorkspace,
    scratchCwd: opts?.scratchCwd,
    onHarnessSessionLinked: (record) => linked.push(record),
  });

  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no ephemeral port");
  return { url: `http://127.0.0.1:${address.port}`, registry, calls, linked };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/api/driven-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const TASK_ID = "mt#9999";
const WORKSPACE_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const SESSION_DIR = `/state/minsky/sessions/${WORKSPACE_ID}`;
const HARNESS_ID = "aaaaaaaa-0000-0000-0000-000000000001";

function fakeResolver(): (taskId: string) => Promise<ResolvedTaskWorkspace> {
  return async () => ({ minskySessionId: WORKSPACE_ID, sessionDir: SESSION_DIR, reused: false });
}

// ---------------------------------------------------------------------------
// Body validation (mt#2752 shapes)
// ---------------------------------------------------------------------------

describe("POST /api/driven-session — body validation", () => {
  test("rejects taskId + cwd together with 400", async () => {
    const h = await makeHarness();
    const res = await post(h.url, { taskId: TASK_ID, cwd: "/tmp/x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("mutually exclusive");
    expect(h.calls.length).toBe(0);
  });

  test("rejects a present-but-empty cwd with 400 (no silent scratch fallback)", async () => {
    const h = await makeHarness();
    const res = await post(h.url, { cwd: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("cwd");
    expect(h.calls.length).toBe(0);
  });

  test("rejects a non-string taskId with 400", async () => {
    const h = await makeHarness();
    const res = await post(h.url, { taskId: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("taskId");
    expect(h.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scratch launch (mt#2752 SC3)
// ---------------------------------------------------------------------------

describe("POST /api/driven-session — scratch (empty body)", () => {
  test("spawns in the scratch cwd with no task binding", async () => {
    const h = await makeHarness({ scratchCwd: "/repo/checkout" });
    const res = await post(h.url, {});
    expect(res.status).toBe(201);
    expect(res.body.cwd).toBe("/repo/checkout");
    expect(res.body.taskId).toBeNull();
    expect(res.body.minskySessionId).toBeNull();
    expect(first(h.calls).options.cwd).toBe("/repo/checkout");
  });
});

// ---------------------------------------------------------------------------
// Explicit-cwd launch (mt#2750 back-compat)
// ---------------------------------------------------------------------------

describe("POST /api/driven-session — explicit cwd", () => {
  test("spawns in the given cwd, response carries null task binding", async () => {
    const h = await makeHarness();
    const res = await post(h.url, { cwd: "/tmp/explicit" });
    expect(res.status).toBe(201);
    expect(res.body.cwd).toBe("/tmp/explicit");
    expect(res.body.taskId).toBeNull();
    expect(typeof res.body.sessionId).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Task-bound launch (mt#2752 SC1/SC2)
// ---------------------------------------------------------------------------

describe("POST /api/driven-session — task-bound", () => {
  test("resolves the workspace and spawns with cwd = workspace dir", async () => {
    const h = await makeHarness({ resolveTaskWorkspace: fakeResolver() });
    const res = await post(h.url, { taskId: TASK_ID });
    expect(res.status).toBe(201);
    expect(res.body.taskId).toBe(TASK_ID);
    expect(res.body.minskySessionId).toBe(WORKSPACE_ID);
    expect(res.body.cwd).toBe(SESSION_DIR);
    expect(first(h.calls).options.cwd).toBe(SESSION_DIR);

    // Registry record carries the binding (drives the Agents-list splice).
    const record = h.registry.get(res.body.sessionId);
    expect(record?.taskId).toBe(TASK_ID);
    expect(record?.minskySessionId).toBe(WORKSPACE_ID);
  });

  test("fires the init-link observer once the child's init event arrives (spawn-time identity)", async () => {
    const h = await makeHarness({ resolveTaskWorkspace: fakeResolver() });
    const res = await post(h.url, { taskId: TASK_ID });
    expect(res.status).toBe(201);
    expect(h.linked.length).toBe(0);

    first(h.calls).proc.emitLine({ type: "system", subtype: "init", session_id: HARNESS_ID });
    // The stdout data handler is synchronous once the stream flushes — one
    // macrotask tick is enough for the PassThrough to deliver.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.linked.length).toBe(1);
    const record = first(h.linked);
    expect(record.harnessSessionId).toBe(HARNESS_ID);
    expect(record.minskySessionId).toBe(WORKSPACE_ID);
    expect(record.cwd).toBe(SESSION_DIR);
  });

  test("surfaces a workspace-resolution failure as 500 with the domain message", async () => {
    const h = await makeHarness({
      resolveTaskWorkspace: async () => {
        throw new Error("Task mt#9999 not found");
      },
    });
    const res = await post(h.url, { taskId: TASK_ID });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Task mt#9999 not found");
    expect(h.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// List (mt#2752 — task binding visible on the registry snapshot)
// ---------------------------------------------------------------------------

describe("GET /api/driven-session", () => {
  test("list rows carry task binding for task-bound sessions", async () => {
    const h = await makeHarness({ resolveTaskWorkspace: fakeResolver() });
    await post(h.url, { taskId: TASK_ID });
    await post(h.url, { cwd: "/tmp/scratchy" });

    const res = await fetch(`${h.url}/api/driven-session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: any[] };
    expect(body.sessions.length).toBe(2);

    const bound = body.sessions.find((s) => s.taskId === TASK_ID);
    expect(bound).toBeDefined();
    expect(bound.minskySessionId).toBe(WORKSPACE_ID);

    const scratch = body.sessions.find((s) => s.cwd === "/tmp/scratchy");
    expect(scratch.taskId).toBeNull();
  });

  test("list rows carry the SAME shape as the POST response, argv included (PR #1943 R2)", async () => {
    const h = await makeHarness();
    const created = await post(h.url, { cwd: "/tmp/shape-check" });

    const res = await fetch(`${h.url}/api/driven-session`);
    const body = (await res.json()) as { sessions: any[] };
    const row = body.sessions.find((s) => s.sessionId === created.body.sessionId);
    expect(row).toBeDefined();
    expect(Object.keys(row).sort()).toEqual(Object.keys(created.body).sort());
    expect(Array.isArray(row.argv)).toBe(true);
  });
});
