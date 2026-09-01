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
/* eslint-disable custom/no-real-fs-in-tests -- mt#3397: the host preflights its spawn cwd against the REAL filesystem, so a route that spawns needs a real directory as its cwd — there is no fs to inject through the code path under test. A per-run mkdtemp dir keeps the "fixed mock path" race the rule guards against from applying. */
import { describe, test, expect, afterEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
import { reconcilePersistedDrivenSessions } from "../driven-session-launch";
import type {
  ResolvedTaskWorkspace,
  DrivenSessionAttachOutcome,
  OrchestrateDrivenSessionAttachDeps,
} from "../driven-session-launch";
import type { DrivenSessionRow } from "@minsky/domain/storage/schemas/driven-sessions-schema";

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
  attachDrivenSession?: (
    conversationId: string,
    deps: OrchestrateDrivenSessionAttachDeps
  ) => Promise<DrivenSessionAttachOutcome>;
  getProjectScopeDb?: () => Promise<
    import("@minsky/domain/project/scope-resolver").ScopeResolverDb | null
  >;
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
    attachDrivenSession: opts?.attachDrivenSession,
    getProjectScopeDb: opts?.getProjectScopeDb,
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
// mt#3397 — the host preflights the spawn cwd, so every directory a route
// actually spawns into has to exist. A made-up path here would not fail the
// tests loudly; it would quietly divert them into the missing-cwd branch and
// leave them asserting against a record that never spawned.
const TEST_DIR_ROOT = mkdtempSync(join(tmpdir(), "driven-session-routes-"));
function realDir(name: string): string {
  const dir = join(TEST_DIR_ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const SESSION_DIR = realDir(WORKSPACE_ID);
const SCRATCH_CWD = realDir("scratch-checkout");
const EXPLICIT_CWD = realDir("explicit");
const HARNESS_ID = "aaaaaaaa-0000-0000-0000-000000000001";

function fakeResolver(
  projectId: string | null = null
): (taskId: string) => Promise<ResolvedTaskWorkspace> {
  return async () => ({
    minskySessionId: WORKSPACE_ID,
    sessionDir: SESSION_DIR,
    reused: false,
    projectId,
  });
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
// Model selection (mt#3040)
// ---------------------------------------------------------------------------

describe("POST /api/driven-session — model selection (mt#3040)", () => {
  test("threads a valid model into the spawn argv as --model <alias>", async () => {
    const h = await makeHarness({ scratchCwd: SCRATCH_CWD });
    const res = await post(h.url, { model: "fable" });
    expect(res.status).toBe(201);
    const args = first(h.calls).args;
    const i = args.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("fable");
  });

  test("omits --model when no model is provided", async () => {
    const h = await makeHarness({ scratchCwd: SCRATCH_CWD });
    const res = await post(h.url, {});
    expect(res.status).toBe(201);
    expect(first(h.calls).args).not.toContain("--model");
  });

  test("rejects an unknown model id with 400 and does not spawn", async () => {
    const h = await makeHarness({ scratchCwd: SCRATCH_CWD });
    const res = await post(h.url, { model: "gpt-4o" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("model");
    expect(h.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scratch launch (mt#2752 SC3)
// ---------------------------------------------------------------------------

describe("POST /api/driven-session — scratch (empty body)", () => {
  test("spawns in the scratch cwd with no task binding", async () => {
    const h = await makeHarness({ scratchCwd: SCRATCH_CWD });
    const res = await post(h.url, {});
    expect(res.status).toBe(201);
    expect(res.body.cwd).toBe(SCRATCH_CWD);
    expect(res.body.taskId).toBeNull();
    expect(res.body.minskySessionId).toBeNull();
    expect(first(h.calls).options.cwd).toBe(SCRATCH_CWD);
  });
});

// ---------------------------------------------------------------------------
// Explicit-cwd launch (mt#2750 back-compat)
// ---------------------------------------------------------------------------

describe("POST /api/driven-session — explicit cwd", () => {
  test("spawns in the given cwd, response carries null task binding", async () => {
    const h = await makeHarness();
    const res = await post(h.url, { cwd: EXPLICIT_CWD });
    expect(res.status).toBe(201);
    expect(res.body.cwd).toBe(EXPLICIT_CWD);
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

  // mt#4732: the resolved workspace's projectId must reach the registry
  // record — the production-wiring half of the agents-widget fix
  // (spliceDrivenSessions's own tests cover the widget-side classification).
  test("mt#4732: threads the resolved workspace's projectId onto the registry record", async () => {
    const PROJECT_ID = "cccc3333-0000-0000-0000-00000000CCCC";
    const h = await makeHarness({ resolveTaskWorkspace: fakeResolver(PROJECT_ID) });
    const res = await post(h.url, { taskId: TASK_ID });
    expect(res.status).toBe(201);

    const record = h.registry.get(res.body.sessionId);
    expect(record?.projectId).toBe(PROJECT_ID);
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
    await post(h.url, { cwd: realDir("scratchy") });

    const res = await fetch(`${h.url}/api/driven-session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: any[] };
    expect(body.sessions.length).toBe(2);

    const bound = body.sessions.find((s) => s.taskId === TASK_ID);
    expect(bound).toBeDefined();
    expect(bound.minskySessionId).toBe(WORKSPACE_ID);

    const scratch = body.sessions.find((s) => s.cwd === realDir("scratchy"));
    expect(scratch.taskId).toBeNull();
  });

  test("list rows carry the SAME shape as the POST response, argv included (PR #1943 R2)", async () => {
    const h = await makeHarness();
    const created = await post(h.url, { cwd: realDir("shape-check") });

    const res = await fetch(`${h.url}/api/driven-session`);
    const body = (await res.json()) as { sessions: any[] };
    const row = body.sessions.find((s) => s.sessionId === created.body.sessionId);
    expect(row).toBeDefined();
    expect(Object.keys(row).sort()).toEqual(Object.keys(created.body).sort());
    expect(Array.isArray(row.argv)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Project scope (mt#4746 — two-project fixture, mirrors mt#4727's pattern)
// ---------------------------------------------------------------------------

describe("GET /api/driven-session — project scope (mt#4746)", () => {
  const PROJECT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROJECT_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PROJECT_A_SLUG = "edobry/minsky";

  /** A resolver keyed by taskId, so one harness can spawn sessions bound to
   * two different projects' workspaces. */
  function fakeResolverByTaskId(
    map: Record<string, string | null>
  ): (taskId: string) => Promise<ResolvedTaskWorkspace> {
    return async (taskId: string) => ({
      minskySessionId: `${WORKSPACE_ID}-${taskId.replace("#", "-")}`,
      sessionDir: realDir(`scope-${taskId.replace("#", "-")}`),
      reused: false,
      projectId: map[taskId] ?? null,
    });
  }

  function makeScopeResolverDb(
    rows: Array<{ id: string; slug: string }>
  ): import("@minsky/domain/project/scope-resolver").ScopeResolverDb {
    return {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return Promise.resolve(rows);
                  },
                };
              },
            };
          },
        };
      },
    };
  }

  test("no ?project= returns sessions from both projects plus the unattributed scratch session", async () => {
    const resolver = fakeResolverByTaskId({ "mt#1": PROJECT_A_ID, "mt#2": PROJECT_B_ID });
    const h = await makeHarness({ resolveTaskWorkspace: resolver });
    await post(h.url, { taskId: "mt#1" });
    await post(h.url, { taskId: "mt#2" });
    await post(h.url, { cwd: realDir("scope-scratch") });

    const res = await fetch(`${h.url}/api/driven-session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ taskId: string | null }> };
    expect(body.sessions.length).toBe(3);
  });

  test("?project=<project A slug> keeps only project A's session (drops project B and the unattributed scratch session)", async () => {
    const resolver = fakeResolverByTaskId({ "mt#1": PROJECT_A_ID, "mt#2": PROJECT_B_ID });
    const h = await makeHarness({
      resolveTaskWorkspace: resolver,
      getProjectScopeDb: async () =>
        makeScopeResolverDb([{ id: PROJECT_A_ID, slug: PROJECT_A_SLUG }]),
    });
    await post(h.url, { taskId: "mt#1" });
    await post(h.url, { taskId: "mt#2" });
    await post(h.url, { cwd: realDir("scope-scratch-2") });

    const res = await fetch(
      `${h.url}/api/driven-session?project=${encodeURIComponent(PROJECT_A_SLUG)}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ taskId: string | null }> };
    expect(body.sessions.length).toBe(1);
    expect(body.sessions[0]?.taskId).toBe("mt#1");
  });

  test("?project=<unresolvable slug> fails open to ALL_PROJECTS (every session returned)", async () => {
    const resolver = fakeResolverByTaskId({ "mt#1": PROJECT_A_ID, "mt#2": PROJECT_B_ID });
    const h = await makeHarness({
      resolveTaskWorkspace: resolver,
      getProjectScopeDb: async () => null,
    });
    await post(h.url, { taskId: "mt#1" });
    await post(h.url, { taskId: "mt#2" });

    const res = await fetch(
      `${h.url}/api/driven-session?project=${encodeURIComponent("unknown/repo")}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Turn-active signal (mt#3048 — cockpit-tray watcher's pre-restart gate)
// ---------------------------------------------------------------------------

describe("GET /api/driven-session/turn-active", () => {
  test("reports active: false with no driven sessions at all", async () => {
    const h = await makeHarness();
    const res = await fetch(`${h.url}/api/driven-session/turn-active`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean; activeSessionIds: string[] };
    expect(body.active).toBe(false);
    expect(body.activeSessionIds).toEqual([]);
  });

  test("reports active: false while every session is idle between turns", async () => {
    const h = await makeHarness();
    const created = await post(h.url, { cwd: realDir("idle") });
    first(h.calls).proc.emitLine({ type: "result", subtype: "success", total_cost_usd: 0.01 });

    const res = await fetch(`${h.url}/api/driven-session/turn-active`);
    const body = (await res.json()) as { active: boolean; activeSessionIds: string[] };
    expect(body.active).toBe(false);
    expect(body.activeSessionIds).not.toContain(created.body.sessionId);
  });

  test("reports active: true with the session id once a turn is streaming", async () => {
    const h = await makeHarness();
    const created = await post(h.url, { cwd: realDir("active") });
    first(h.calls).proc.emitLine({ type: "assistant", message: { content: [] } });

    const res = await fetch(`${h.url}/api/driven-session/turn-active`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean; activeSessionIds: string[] };
    expect(body.active).toBe(true);
    expect(body.activeSessionIds).toEqual([created.body.sessionId]);
  });

  test("one active + one idle session: reports true, lists only the active one", async () => {
    const h = await makeHarness();
    const idle = await post(h.url, { cwd: realDir("idle-2") });
    const active = await post(h.url, { cwd: realDir("active-2") });
    h.calls[0]?.proc.emitLine({ type: "result", subtype: "success", total_cost_usd: 0.01 });
    h.calls[1]?.proc.emitLine({ type: "assistant", message: { content: [] } });

    const res = await fetch(`${h.url}/api/driven-session/turn-active`);
    const body = (await res.json()) as { active: boolean; activeSessionIds: string[] };
    expect(body.active).toBe(true);
    expect(body.activeSessionIds).toEqual([active.body.sessionId]);
    expect(body.activeSessionIds).not.toContain(idle.body.sessionId);
  });
});

/**
 * POST /api/driven-session/attach (mt#3095).
 *
 * The orchestration's own decisions live in
 * ../driven-session-launch-persistence.test.ts; what this route owns — and what
 * these tests pin — is the outcome→status-code mapping. The codes are load-bearing
 * for a caller: 409 (the conversation has a writer) and 423 (you lost a race
 * with another cockpit session driver) call for different UI, so collapsing them
 * would lose the distinction.
 */
describe("POST /api/driven-session/attach (mt#3095)", () => {
  // A syntactically valid conversation id — the route rejects anything that
  // cannot be one before doing any I/O (PR #2466 R1).
  const CONVERSATION = "3bc714e7-d40a-40b3-bcfc-c2b1c90ef8c6";

  async function attachPost(url: string, body: unknown) {
    const res = await fetch(`${url}/api/driven-session/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  test("201 with a session summary when the attach succeeds", async () => {
    const registry = new DrivenSessionRegistry();
    const h = await makeHarness({
      attachDrivenSession: async (conversationId, deps) => {
        // The route must forward its registry/spawn seams through, or a
        // production attach would land in the wrong registry.
        expect(deps.registry).toBeDefined();
        const { record } = (await import("../driven-session-host")).startDrivenSession({
          cwd: EXPLICIT_CWD,
          permissionMode: "bypassPermissions",
          spawnFn: () => new FakeClaudeProcess(),
          registry,
        });
        record.harnessSessionId = conversationId;
        return { outcome: "attached", record };
      },
    });

    const res = await attachPost(h.url, { conversationId: CONVERSATION });
    expect(res.status).toBe(201);
    expect(res.body.harnessSessionId).toBe(CONVERSATION);
  });

  test("409 with the refusal reason and operator-facing message", async () => {
    const h = await makeHarness({
      attachDrivenSession: async () => ({
        outcome: "refused",
        reason: "live-writer",
        message: "This conversation is being written to right now.",
        presence: "LIVE",
      }),
    });

    const res = await attachPost(h.url, { conversationId: CONVERSATION });
    expect(res.status).toBe(409);
    expect(res.body.refused).toBe(true);
    expect(res.body.reason).toBe("live-writer");
    expect(res.body.presence).toBe("LIVE");
    // The message is what a caller shows the operator — it must survive the
    // mapping, not be replaced by a generic conflict string.
    expect(res.body.message).toContain("written to right now");
  });

  test("423 — distinct from 409 — when another cockpit session driver holds the lock", async () => {
    const h = await makeHarness({
      attachDrivenSession: async () => ({ outcome: "locked" }),
    });
    const res = await attachPost(h.url, { conversationId: CONVERSATION });
    expect(res.status).toBe(423);
  });

  test("404 when no transcript exists for the conversation", async () => {
    const h = await makeHarness({
      attachDrivenSession: async () => ({ outcome: "no-transcript" }),
    });
    const res = await attachPost(h.url, { conversationId: CONVERSATION });
    expect(res.status).toBe(404);
  });

  test.each([[undefined], [""], [42], [null]])(
    "400 on a malformed conversationId (%p)",
    async (conversationId) => {
      let called = 0;
      const h = await makeHarness({
        attachDrivenSession: async () => {
          called += 1;
          return { outcome: "no-transcript" };
        },
      });
      const res = await attachPost(h.url, { conversationId });
      expect(res.status).toBe(400);
      // Rejected before any orchestration runs — no lock, no spawn, no disk walk.
      expect(called).toBe(0);
    }
  );

  test("400 on a syntactically impossible id, with zero orchestration work", async () => {
    let called = 0;
    const h = await makeHarness({
      attachDrivenSession: async () => {
        called += 1;
        return { outcome: "no-transcript" };
      },
    });
    const res = await attachPost(h.url, { conversationId: "not-a-conversation-id" });
    expect(res.status).toBe(400);
    // The point of the check is avoiding a full `~/.claude/projects` walk for
    // an id that could never have resolved.
    expect(called).toBe(0);
  });

  test("500 when the orchestration throws, without leaking a stack to the client", async () => {
    const h = await makeHarness({
      attachDrivenSession: async () => {
        throw new Error("boom");
      },
    });
    const res = await attachPost(h.url, { conversationId: CONVERSATION });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Failed to attach driven session");
  });

  test("the conversation id reaches the orchestration verbatim", async () => {
    const seen: string[] = [];
    const h = await makeHarness({
      attachDrivenSession: async (conversationId) => {
        seen.push(conversationId);
        return { outcome: "no-transcript" };
      },
    });
    await attachPost(h.url, { conversationId: CONVERSATION });
    expect(seen).toEqual([CONVERSATION]);
  });
});

describe("GET /api/driven-session after boot reconciliation retires a row (mt#4255)", () => {
  // PR #3126 R1: the spec's last criterion asks for the LIST, not the column —
  // "verified by loading the surface". The reconciler's own tests assert
  // `registry.get(...)` is undefined, which is the mechanism; this asserts the
  // consequence at the surface the principal actually sees, over the real
  // Express route and a real HTTP request.
  // Named once rather than repeated: the retirement assertions below reference
  // each id several times, and a typo in one of them would silently weaken the
  // check instead of failing it.
  const LIVE_ID = "live-session-driver";
  const DEAD_ID = "dead-session-driver";

  const BASE: DrivenSessionRow = {
    localId: "placeholder",
    harnessSessionId: "harness-x",
    cwd: TEST_DIR_ROOT,
    permissionMode: "bypassPermissions",
    taskId: null,
    minskySessionId: null,
    status: "running",
    unrecoverableReason: null,
    pid: 4242,
    pidCmdline: "claude -p --input-format stream-json",
    model: null,
    driverGeneration: 0,
    startedAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  };

  test("the retired row is absent from the list; the live one is still there", async () => {
    const h = await makeHarness();

    await reconcilePersistedDrivenSessions({
      getDb: async () => ({}) as never,
      listNonTerminal: async () => [
        { ...BASE, localId: DEAD_ID, pid: 1 },
        { ...BASE, localId: LIVE_ID, pid: 2 },
      ],
      registry: h.registry,
      persistTerminalVerdict: async () => "written",
      probeSessionDriver: async (pid) => (pid === 1 ? "gone" : "ours"),
    });

    const res = await fetch(`${h.url}/api/driven-session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { sessionId: string; status: string }[] };
    const ids = body.sessions.map((s) => s.sessionId);

    // The phantom is gone from the surface, on the same boot that detected it.
    expect(ids).not.toContain(DEAD_ID);
    // And the check can fail: a sweep that retired everything would drop this
    // one too, and a change that retired nothing would leave both.
    expect(ids).toContain(LIVE_ID);
    expect(body.sessions.find((s) => s.sessionId === LIVE_ID)?.status).toBe("reconnecting");
  });

  test("a row whose retirement write FAILED is still listed", async () => {
    // The surface-level companion to the R1 blocking fix: an unconfirmed write
    // leaves the row non-terminal in the database, so hiding it from the list
    // would show the operator a session that is about to come back.
    const h = await makeHarness();

    await reconcilePersistedDrivenSessions({
      getDb: async () => ({}) as never,
      listNonTerminal: async () => [{ ...BASE, localId: "dead-but-unpersisted", pid: 1 }],
      registry: h.registry,
      persistTerminalVerdict: async () => {
        throw new Error("simulated upsert failure");
      },
      probeSessionDriver: async () => "gone",
    });

    const res = await fetch(`${h.url}/api/driven-session`);
    const body = (await res.json()) as { sessions: { sessionId: string }[] };
    expect(body.sessions.map((s) => s.sessionId)).toContain("dead-but-unpersisted");
  });
});

// PR #2452 R1 (non-blocking): remove the per-run temp dir so repeated runs do
// not accumulate orphaned directories under the system temp root.
afterAll(() => {
  rmSync(TEST_DIR_ROOT, { recursive: true, force: true });
});
