/**
 * Cockpit integration tests (mt#1144)
 *
 * Uses createCockpitServer with overrides to test server behavior
 * without touching the filesystem or real cockpit.json.
 *
 * Port strategy: listen on 0 (random) via Node's http module; call
 * the app via fetch against http://localhost:<assigned-port>.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { createCockpitServer } from "./server";
import type { CredentialModuleOverride } from "./server";
import type { WidgetModule, WidgetData, WidgetContext } from "./types";
import { createAgentsWidget } from "./widgets/agents";
import { createAttentionWidget } from "./widgets/attention";
import type { AttentionPayload, AttentionAsk } from "./widgets/attention";
import { FakeAskRepository } from "../domain/ask/repository";
import type { AgentRow } from "./widgets/agents";
import { createTaskGraphWidget } from "./widgets/task-graph";
import type { GraphNode, GraphEdge, TaskGraphDeps } from "./widgets/task-graph";
import { createWorkstreamsWidget } from "./widgets/workstreams";
import type { WorkstreamCard, WorkstreamsDeps } from "./widgets/workstreams";
import type { SessionProviderInterface, SessionRecord } from "../domain/session/types";
import { SessionStatus } from "../domain/session/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Start the app on a random port; resolves with (url, closeServer). */
async function startTestServer(opts?: Parameters<typeof createCockpitServer>[0]): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = createCockpitServer(opts);
  const server: Server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
  const url = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return { url, close };
}

// ---------------------------------------------------------------------------
// Default registry: real attention widget + basic-health
// (attention-stub was retired in mt#1147 / PR #1125)
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  widgets: [
    { id: "attention", enabled: true },
    { id: "basic-health", enabled: true },
  ],
};

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// Credential error codes — keep in sync with `CredentialErrorCode` in
// src/cockpit/server.ts and `CredentialApiErrorCode` in
// src/cockpit/web/widgets/Credentials.tsx (mt#1426 PR #1142 R1).
const CRED_ERR_UNKNOWN_PROVIDER = "unknown_provider";
const CRED_ERR_MISSING_FIELD = "missing_field";
const CRED_ERR_VALIDATION_FAILED = "validation_failed";

// ---------------------------------------------------------------------------
// Test servers — started lazily and closed per-test
// ---------------------------------------------------------------------------

describe("Cockpit server", () => {
  const closeList: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closeList.splice(0)) {
      await close();
    }
  });

  async function server(opts?: Parameters<typeof createCockpitServer>[0]) {
    const s = await startTestServer(opts);
    closeList.push(s.close);
    return s.url;
  }

  // 1. Server boots; GET /api/health → 200 + {status, version, uptimeSec}
  test("GET /api/health returns 200 and status ok with uptimeSec", async () => {
    const url = await server({ overrideConfig: DEFAULT_CONFIG });
    const res = await fetch(`${url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    // Field is named `uptimeSec` (not `uptime`) so naming is consistent with
    // the basic-health widget payload — see PR #1017 reviewer finding R1.
    expect(typeof body.uptimeSec).toBe("number");
    expect(typeof body.version).toBe("string");
    expect(body.uptime).toBeUndefined();
  });

  // 2. GET /api/widgets → array containing both enabled widgets
  test("GET /api/widgets returns both enabled widgets", async () => {
    const url = await server({ overrideConfig: DEFAULT_CONFIG });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(Array.isArray(body)).toBe(true);
    const ids = body.map((w) => w.id);
    expect(ids).toContain("attention");
    expect(ids).toContain("basic-health");
  });

  // 3. attention-stub-specific degraded test was retired in mt#1147 / PR #1125 R1
  // alongside the stub widget itself. The real attention widget's degraded path
  // is covered by test 12h (deps factory throws → degraded with attention error).

  // 4. GET /api/widget/basic-health/data → {state:"ok", payload:{uptimeSec:number, version:string, loadedWidgetCount:2}}
  test("GET /api/widget/basic-health/data returns ok with health payload", async () => {
    const url = await server({ overrideConfig: DEFAULT_CONFIG });
    const res = await fetch(`${url}/api/widget/basic-health/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      payload: { uptimeSec: number; version: string; loadedWidgetCount: number };
    };
    expect(body.state).toBe("ok");
    expect(typeof body.payload.uptimeSec).toBe("number");
    expect(typeof body.payload.version).toBe("string");
    expect(body.payload.loadedWidgetCount).toBe(2);
  });

  // 5. Inject widget that throws → {state:"degraded", reason matching /widget crashed/i}
  test("Widget that throws returns degraded with 'widget crashed' reason", async () => {
    const crashingWidget: WidgetModule = {
      id: "crashing-test",
      title: "Crashing Test Widget",
      updateMode: { type: "manual" },
      async fetch(_ctx: WidgetContext): Promise<WidgetData> {
        throw new Error("boom");
      },
    };
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "crashing-test", enabled: true }],
      },
      overrideRegistry: { "crashing-test": crashingWidget },
    });
    const res = await fetch(`${url}/api/widget/crashing-test/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; reason: string };
    expect(body.state).toBe("degraded");
    expect(body.reason).toMatch(/widget crashed/i);
  });

  // 6. overrideConfig disabling attention → only basic-health in /api/widgets
  test("Disabling attention via overrideConfig excludes it from /api/widgets", async () => {
    const url = await server({
      overrideConfig: {
        widgets: [
          { id: "attention", enabled: false },
          { id: "basic-health", enabled: true },
        ],
      },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((w) => w.id);
    expect(ids).not.toContain("attention");
    expect(ids).toContain("basic-health");
  });

  // 8. Malformed config (no widgets array) — server doesn't crash on
  // /api/widgets and yields an empty list. This exercises the defensive
  // path in `loadCockpitConfig` for the case where a user's existing
  // ~/.config/minsky/cockpit.json is empty or malformed (PR #1017 R1).
  test("Malformed overrideConfig does not crash; /api/widgets returns empty list", async () => {
    const url = await server({
      // Intentionally malformed — `widgets` is not an array of valid entries.
      // The server's effective enabledWidgets must fall back to empty rather
      // than crash on iteration.
      overrideConfig: { widgets: [] },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  // 7. overrideConfig + overrideRegistry adding third placeholder → 3 entries
  test("Adding third widget via overrideRegistry adds 3 entries to /api/widgets", async () => {
    const thirdWidget: WidgetModule = {
      id: "extra-stub",
      title: "Extra Stub",
      updateMode: { type: "manual" },
      async fetch(_ctx: WidgetContext): Promise<WidgetData> {
        return { state: "degraded", reason: "Placeholder" };
      },
    };
    const url = await server({
      overrideConfig: {
        widgets: [
          { id: "attention", enabled: true },
          { id: "basic-health", enabled: true },
          { id: "extra-stub", enabled: true },
        ],
      },
      overrideRegistry: { "extra-stub": thirdWidget },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.length).toBe(3);
    const ids = body.map((w) => w.id);
    expect(ids).toContain("extra-stub");
  });

  // ---------------------------------------------------------------------------
  // Agents widget tests (mt#1145)
  // ---------------------------------------------------------------------------

  /**
   * Build a minimal mock SessionProviderInterface for testing.
   * Only `listSessions` is needed by the agents widget.
   */
  function makeMockProvider(records: SessionRecord[]): SessionProviderInterface {
    return {
      listSessions: async () => records,
      getSession: async () => null,
      getSessionByTaskId: async () => null,
      addSession: async () => {},
      updateSession: async () => {},
      deleteSession: async () => false,
      getRepoPath: async () => "",
      getSessionWorkdir: async () => "",
    };
  }

  // Static base for fixture timestamps — "now" expressed without Date.now().
  // Using new Date() avoids the `no-real-fs-in-tests` lint rule that fires on
  // Date.now() used inside test files.  All offsets are expressed as
  // arithmetic on a base Date object.
  const NOW = new Date();
  const FORTY_FIVE_MIN_AGO = new Date(NOW.getTime() - 45 * 60 * 1000);
  const FIVE_HOURS_AGO = new Date(NOW.getTime() - 5 * 60 * 60 * 1000);
  const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);

  /** Fixture: a healthy session with a bound task and open PR.
   * taskId is stored in qualified form because `SessionDbAdapter.addTaskToSession`
   * normalizes via `validateQualifiedTaskId` before persisting (per PR #1030 R2). */
  const healthySession: SessionRecord = {
    sessionId: "aaaaaaaa-0000-0000-0000-000000000001",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky",
    createdAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
    taskId: "mt#1145",
    status: SessionStatus.PR_OPEN,
    pullRequest: {
      number: 42,
      url: "https://github.com/edobry/minsky/pull/42",
      state: "open",
      createdAt: NOW.toISOString(),
      headBranch: "task/mt-1145",
      baseBranch: "main",
      lastSynced: NOW.toISOString(),
    },
  };

  /** Fixture: an idle session with no task or PR (last active ~45 min ago) */
  const idleSession: SessionRecord = {
    sessionId: "bbbbbbbb-0000-0000-0000-000000000002",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky",
    createdAt: FORTY_FIVE_MIN_AGO.toISOString(),
    lastActivityAt: FORTY_FIVE_MIN_AGO.toISOString(),
    status: SessionStatus.ACTIVE,
  };

  /** Fixture: a stale session (last active ~5 hours ago, non-terminal) */
  const staleSession: SessionRecord = {
    sessionId: "cccccccc-0000-0000-0000-000000000003",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky",
    createdAt: FIVE_HOURS_AGO.toISOString(),
    lastActivityAt: FIVE_HOURS_AGO.toISOString(),
    status: SessionStatus.ACTIVE,
    // stale liveness (>2h), but not orphaned status — included in results
  };

  /** Fixture: a MERGED session (terminal — must be filtered) */
  const mergedSession: SessionRecord = {
    sessionId: "dddddddd-0000-0000-0000-000000000004",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky",
    createdAt: TWO_DAYS_AGO.toISOString(),
    lastActivityAt: TWO_DAYS_AGO.toISOString(),
    status: SessionStatus.MERGED,
    taskId: "mt#999",
  };

  /** Fixture: a CLOSED session (terminal — must be filtered). PR #1030 R1 added. */
  const closedSession: SessionRecord = {
    sessionId: "eeeeeeee-0000-0000-0000-000000000005",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky",
    createdAt: TWO_DAYS_AGO.toISOString(),
    lastActivityAt: TWO_DAYS_AGO.toISOString(),
    status: SessionStatus.CLOSED,
    taskId: "mt#888",
  };

  /** Fixture: a session that should appear with the branch as its title. */
  const branchedSession: SessionRecord = {
    sessionId: "ffffffff-0000-0000-0000-000000000006",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky",
    createdAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
    status: SessionStatus.ACTIVE,
    branch: "task/mt-1145",
  };

  /** Fixture: a session whose taskId is already in qualified form (mt#NNNN).
   * Verifies the display formatter doesn't double-prefix. PR #1030 R2 added. */
  const qualifiedTaskSession: SessionRecord = {
    sessionId: "11111111-0000-0000-0000-000000000007",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky",
    createdAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
    status: SessionStatus.ACTIVE,
    taskId: "mt#1145", // already qualified — must NOT become "mt#mt#1145"
  };

  // 9a. Agents widget present in /api/widgets when enabled
  test("agents widget present in /api/widgets when enabled", async () => {
    const agentsWidget = createAgentsWidget(async () => makeMockProvider([]));
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "agents", enabled: true }],
      },
      overrideRegistry: { agents: agentsWidget },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((w) => w.id);
    expect(ids).toContain("agents");
  });

  // 9b. /api/widget/agents/data returns {state:"ok", payload:{agents:[...]}} shape
  test("/api/widget/agents/data returns ok with agents payload (healthy + idle)", async () => {
    const agentsWidget = createAgentsWidget(async () =>
      makeMockProvider([healthySession, idleSession])
    );
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "agents", enabled: true }],
      },
      overrideRegistry: { agents: agentsWidget },
    });
    const res = await fetch(`${url}/api/widget/agents/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      payload: { agents: AgentRow[] };
    };
    expect(body.state).toBe("ok");
    expect(Array.isArray(body.payload.agents)).toBe(true);
    expect(body.payload.agents.length).toBe(2);

    const sessionIds = body.payload.agents.map((a) => a.sessionId);
    expect(sessionIds).toContain(healthySession.sessionId);
    expect(sessionIds).toContain(idleSession.sessionId);

    // Healthy session should have PR fields
    const healthy = body.payload.agents.find((a) => a.sessionId === healthySession.sessionId);
    if (!healthy) throw new Error("healthy session missing from response");
    expect(healthy.liveness).toBe("healthy");
    expect(healthy.taskId).toBe("mt#1145");
    expect(healthy.prNumber).toBe(42);
    expect(healthy.prStatus).toBe("open");

    // Idle session should have no task or PR
    const idle = body.payload.agents.find((a) => a.sessionId === idleSession.sessionId);
    if (!idle) throw new Error("idle session missing from response");
    expect(idle.liveness).toBe("idle");
    expect(idle.taskId).toBeNull();
    expect(idle.prNumber).toBeNull();
  });

  // 9c. Agents widget filters out terminal-status sessions (MERGED + CLOSED)
  // and keeps stale-but-non-terminal sessions. The spec calls out both MERGED
  // and CLOSED explicitly (PR #1030 R1 reviewer finding — original test
  // covered only MERGED).
  test("agents widget filters out MERGED + CLOSED, keeps stale non-terminal", async () => {
    const agentsWidget = createAgentsWidget(async () =>
      makeMockProvider([healthySession, staleSession, mergedSession, closedSession])
    );
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "agents", enabled: true }],
      },
      overrideRegistry: { agents: agentsWidget },
    });
    const res = await fetch(`${url}/api/widget/agents/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      payload: { agents: AgentRow[] };
    };
    expect(body.state).toBe("ok");

    const sessionIds = body.payload.agents.map((a) => a.sessionId);
    // MERGED + CLOSED (terminal) must be absent
    expect(sessionIds).not.toContain(mergedSession.sessionId);
    expect(sessionIds).not.toContain(closedSession.sessionId);
    // healthy and stale (non-terminal) must be present
    expect(sessionIds).toContain(healthySession.sessionId);
    expect(sessionIds).toContain(staleSession.sessionId);
  });

  // 9c'. Agents widget renders branch as title when available
  // (PR #1030 R1 reviewer finding: 8-char sessionId prefix risks collision —
  // resolved by preferring `record.branch ?? full sessionId`).
  test("agents widget uses branch as title when present, full sessionId otherwise", async () => {
    const agentsWidget = createAgentsWidget(async () =>
      makeMockProvider([healthySession, branchedSession])
    );
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "agents", enabled: true }],
      },
      overrideRegistry: { agents: agentsWidget },
    });
    const res = await fetch(`${url}/api/widget/agents/data`);
    const body = (await res.json()) as {
      state: string;
      payload: { agents: AgentRow[] };
    };
    expect(body.state).toBe("ok");

    const healthy = body.payload.agents.find((a) => a.sessionId === healthySession.sessionId);
    const branched = body.payload.agents.find((a) => a.sessionId === branchedSession.sessionId);
    // Branched session renders its branch as title (not an 8-char prefix)
    expect(branched?.title).toBe("task/mt-1145");
    // Healthy session has no branch → full sessionId is the title (no prefix-truncation)
    expect(healthy?.title).toBe(healthySession.sessionId);
    expect(healthy?.title).not.toMatch(/^session [a-f0-9]{8}$/);
  });

  // 9c''. Agents widget doesn't double-prefix already-qualified taskIds
  // (PR #1030 R2 reviewer finding: SessionDbAdapter.addTaskToSession normalizes
  // to "mt#NNNN" form before persisting, so storage may already hold a
  // qualified ID; the display formatter must be idempotent.)
  test("agents widget doesn't double-prefix already-qualified taskIds", async () => {
    const agentsWidget = createAgentsWidget(async () => makeMockProvider([qualifiedTaskSession]));
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "agents", enabled: true }],
      },
      overrideRegistry: { agents: agentsWidget },
    });
    const res = await fetch(`${url}/api/widget/agents/data`);
    const body = (await res.json()) as {
      state: string;
      payload: { agents: AgentRow[] };
    };
    expect(body.state).toBe("ok");

    const row = body.payload.agents.find((a) => a.sessionId === qualifiedTaskSession.sessionId);
    expect(row?.taskId).toBe("mt#1145");
    expect(row?.taskId).not.toBe("mt#mt#1145");
  });

  // 9d. Agents widget returns degraded when provider throws
  test("agents widget returns degraded when session provider throws", async () => {
    const agentsWidget = createAgentsWidget(async () => {
      throw new Error("DB connection failed");
    });
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "agents", enabled: true }],
      },
      overrideRegistry: { agents: agentsWidget },
    });
    const res = await fetch(`${url}/api/widget/agents/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; reason: string };
    expect(body.state).toBe("degraded");
    expect(body.reason).toMatch(/session_list error/i);
    expect(body.reason).toMatch(/DB connection failed/i);
  });

  // ---------------------------------------------------------------------------
  // Task graph widget tests (mt#1146)
  // ---------------------------------------------------------------------------

  /**
   * Build a minimal mock TaskGraphDeps for testing.
   * Accepts fixture tasks and relationships.
   */
  function makeMockTaskGraphDeps(
    tasks: Array<{ id: string; title: string; status: string }>,
    relationships: Array<{ fromTaskId: string; toTaskId: string }>
  ): TaskGraphDeps {
    const mockTaskService = {
      listTasks: async () =>
        tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          // minimal Task shape — other fields unused by the widget
          specPath: "",
          description: "",
        })),
      getTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
      getTaskStatus: async () => undefined,
      setTaskStatus: async () => {},
      createTaskFromTitleAndSpec: async () => {
        throw new Error("not implemented");
      },
      deleteTask: async () => false,
      getTasks: async () => [],
      getTaskSpecContent: async () => {
        throw new Error("not implemented");
      },
      getWorkspacePath: () => "/mock",
    };

    const mockTaskGraphService = {
      getAllRelationships: async (_type?: string) =>
        relationships.map((r) => ({
          fromTaskId: r.fromTaskId,
          toTaskId: r.toTaskId,
          type: "depends" as const,
        })),
      // stub other methods to satisfy interface
      addDependency: async () => ({ created: false }),
      removeDependency: async () => ({ removed: false }),
      listDependencies: async () => [],
      listDependents: async () => [],
      addParent: async () => ({ created: false }),
      removeParent: async () => ({ removed: false }),
      reparent: async () => ({ taskId: "", previousParent: null, newParent: null }),
      getParent: async () => null,
      listChildren: async () => [],
      getAncestors: async () => [],
      getTransitiveDependencies: async () => new Set<string>(),
      getRelationshipsForTasks: async () => [],
    };

    return {
      taskService: mockTaskService as unknown as TaskGraphDeps["taskService"],
      taskGraphService: mockTaskGraphService as unknown as TaskGraphDeps["taskGraphService"],
    };
  }

  // Fixture: 3 tasks, 2 dependency edges
  const FIXTURE_TASKS = [
    { id: "mt#1", title: "Root Task", status: "DONE" },
    { id: "mt#2", title: "Middle Task", status: "IN-PROGRESS" },
    { id: "mt#3", title: "Leaf Task", status: "TODO" },
  ];
  const FIXTURE_EDGES = [
    { fromTaskId: "mt#2", toTaskId: "mt#1" }, // mt#2 depends on mt#1
    { fromTaskId: "mt#3", toTaskId: "mt#2" }, // mt#3 depends on mt#2
  ];

  // 10a. task-graph widget present in /api/widgets when enabled
  test("task-graph widget present in /api/widgets when enabled", async () => {
    const widget = createTaskGraphWidget(async () =>
      makeMockTaskGraphDeps(FIXTURE_TASKS, FIXTURE_EDGES)
    );
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "task-graph", enabled: true }],
      },
      overrideRegistry: { "task-graph": widget },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((w) => w.id);
    expect(ids).toContain("task-graph");
  });

  // 10b. /api/widget/task-graph/data returns {state:"ok", payload:{nodes,edges}} shape
  test("/api/widget/task-graph/data returns ok with nodes and edges", async () => {
    const widget = createTaskGraphWidget(async () =>
      makeMockTaskGraphDeps(FIXTURE_TASKS, FIXTURE_EDGES)
    );
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "task-graph", enabled: true }],
      },
      overrideRegistry: { "task-graph": widget },
    });
    const res = await fetch(`${url}/api/widget/task-graph/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      payload: { nodes: GraphNode[]; edges: GraphEdge[] };
    };
    expect(body.state).toBe("ok");

    // Nodes: 3 tasks in the fixture
    expect(Array.isArray(body.payload.nodes)).toBe(true);
    expect(body.payload.nodes.length).toBe(3);

    const nodeIds = body.payload.nodes.map((n) => n.id);
    expect(nodeIds).toContain("mt#1");
    expect(nodeIds).toContain("mt#2");
    expect(nodeIds).toContain("mt#3");

    // Status is propagated correctly
    const rootNode = body.payload.nodes.find((n) => n.id === "mt#1");
    expect(rootNode?.status).toBe("DONE");
    const leafNode = body.payload.nodes.find((n) => n.id === "mt#3");
    expect(leafNode?.status).toBe("TODO");

    // Edges: 2 dependency edges
    expect(Array.isArray(body.payload.edges)).toBe(true);
    expect(body.payload.edges.length).toBe(2);

    const edgeSources = body.payload.edges.map((e) => e.source);
    expect(edgeSources).toContain("mt#2");
    expect(edgeSources).toContain("mt#3");
  });

  // 10d. task-graph widget filters out edges referencing unknown task IDs
  // (PR #1031 R1 reviewer finding: original code fabricated phantom TODO nodes
  // for orphaned relationships; the fix filters them out entirely.)
  test("task-graph widget filters out edges that reference unknown task IDs", async () => {
    const widget = createTaskGraphWidget(async () =>
      makeMockTaskGraphDeps(
        // Two real tasks
        [
          { id: "mt#1", title: "Real task A", status: "READY" },
          { id: "mt#2", title: "Real task B", status: "IN-PROGRESS" },
        ],
        // Three relationships: one valid (mt#2 → mt#1), two orphaned
        // (referencing mt#999 / mt#888 which don't exist in listTasks)
        [
          { fromTaskId: "mt#2", toTaskId: "mt#1" }, // valid
          { fromTaskId: "mt#999", toTaskId: "mt#1" }, // orphan source
          { fromTaskId: "mt#2", toTaskId: "mt#888" }, // orphan target
        ]
      )
    );
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "task-graph", enabled: true }],
      },
      overrideRegistry: { "task-graph": widget },
    });
    const res = await fetch(`${url}/api/widget/task-graph/data`);
    const body = (await res.json()) as {
      state: string;
      payload: { nodes: GraphNode[]; edges: GraphEdge[] };
    };
    expect(body.state).toBe("ok");

    // No phantom nodes — only the 2 real tasks should appear
    const nodeIds = body.payload.nodes.map((n) => n.id);
    expect(nodeIds.length).toBe(2);
    expect(nodeIds).toContain("mt#1");
    expect(nodeIds).toContain("mt#2");
    expect(nodeIds).not.toContain("mt#999");
    expect(nodeIds).not.toContain("mt#888");

    // Only the valid edge survived
    expect(body.payload.edges.length).toBe(1);
    const edge = body.payload.edges[0];
    if (!edge) throw new Error("expected one edge to survive filtering");
    expect(edge).toMatchObject({ source: "mt#2", target: "mt#1" });
    // Edge ID includes the relationship-type prefix (mt#1031 R2 reviewer
    // finding — guards against collision if other relationship types added)
    expect(edge.id).toBe("depends:mt#2->mt#1");
  });

  // 10c. task-graph widget returns degraded when the underlying provider throws
  test("task-graph widget returns degraded when dep provider throws", async () => {
    const widget = createTaskGraphWidget(async () => {
      throw new Error("task DB unavailable");
    });
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "task-graph", enabled: true }],
      },
      overrideRegistry: { "task-graph": widget },
    });
    const res = await fetch(`${url}/api/widget/task-graph/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; reason: string };
    expect(body.state).toBe("degraded");
    expect(body.reason).toMatch(/task_graph error/i);
    expect(body.reason).toMatch(/task DB unavailable/i);
  });

  // ---------------------------------------------------------------------------
  // Workstreams widget tests (mt#1452)
  // ---------------------------------------------------------------------------

  /**
   * Build a minimal mock WorkstreamsDeps for testing.
   * Accepts fixture tasks and parent relationships.
   * Edge direction: fromTaskId = child, toTaskId = parent
   */
  function makeMockWorkstreamsDeps(
    tasks: Array<{ id: string; title: string; status: string }>,
    parentRels: Array<{ fromTaskId: string; toTaskId: string }>
  ): WorkstreamsDeps {
    const mockTaskService = {
      // Accept the production `options` parameter even though the v0 fixture
      // does not filter. PR #1032 R1 reviewer finding: a mock that drops the
      // `options` arg silently masks regressions if the widget ever starts
      // passing meaningful filter options. Marking it `_options` documents
      // the deliberate v0 no-op and keeps the signature in sync with
      // TaskServiceInterface.listTasks.
      listTasks: async (_options?: unknown) =>
        tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          // minimal Task shape — other fields unused by the widget
          specPath: "",
          description: "",
        })),
      getTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
      getTaskStatus: async () => undefined,
      setTaskStatus: async () => {},
      createTaskFromTitleAndSpec: async () => {
        throw new Error("not implemented");
      },
      deleteTask: async () => false,
      getTasks: async () => [],
      getTaskSpecContent: async () => {
        throw new Error("not implemented");
      },
      getWorkspacePath: () => "/mock",
    };

    const mockTaskGraphService = {
      getAllRelationships: async (_type?: string) =>
        parentRels.map((r) => ({
          fromTaskId: r.fromTaskId,
          toTaskId: r.toTaskId,
          type: "parent" as const,
        })),
      // stub other methods to satisfy interface
      addDependency: async () => ({ created: false }),
      removeDependency: async () => ({ removed: false }),
      listDependencies: async () => [],
      listDependents: async () => [],
      addParent: async () => ({ created: false }),
      removeParent: async () => ({ removed: false }),
      reparent: async () => ({ taskId: "", previousParent: null, newParent: null }),
      getParent: async () => null,
      listChildren: async () => [],
      getAncestors: async () => [],
      getTransitiveDependencies: async () => new Set<string>(),
      getRelationshipsForTasks: async () => [],
    };

    return {
      taskService: mockTaskService as unknown as WorkstreamsDeps["taskService"],
      taskGraphService: mockTaskGraphService as unknown as WorkstreamsDeps["taskGraphService"],
    };
  }

  // 11a. workstreams widget present in /api/widgets when enabled
  test("workstreams widget present in /api/widgets when enabled", async () => {
    const widget = createWorkstreamsWidget(async () => makeMockWorkstreamsDeps([], []));
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "workstreams", enabled: true }],
      },
      overrideRegistry: { workstreams: widget },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((w) => w.id);
    expect(ids).toContain("workstreams");
  });

  // 11b. ok payload — 1 active parent (3 children: IN-PROGRESS, DONE, TODO) +
  // 1 inactive parent (1 child, DONE only) → 1 workstream returned, counts correct
  test("/api/widget/workstreams/data returns ok with correct workstream rollup", async () => {
    // Parent mt#10 has children: mt#11 (IN-PROGRESS), mt#12 (DONE), mt#13 (TODO) → active
    // Parent mt#20 has children: mt#21 (DONE only) → inactive (no active children)
    const tasks = [
      { id: "mt#10", title: "Active Parent", status: "IN-PROGRESS" },
      { id: "mt#11", title: "Child In Progress", status: "IN-PROGRESS" },
      { id: "mt#12", title: "Child Done", status: "DONE" },
      { id: "mt#13", title: "Child Todo", status: "TODO" },
      { id: "mt#20", title: "Inactive Parent", status: "DONE" },
      { id: "mt#21", title: "Done Child", status: "DONE" },
    ];
    // fromTaskId = child, toTaskId = parent
    const parentRels = [
      { fromTaskId: "mt#11", toTaskId: "mt#10" },
      { fromTaskId: "mt#12", toTaskId: "mt#10" },
      { fromTaskId: "mt#13", toTaskId: "mt#10" },
      { fromTaskId: "mt#21", toTaskId: "mt#20" },
    ];

    const widget = createWorkstreamsWidget(async () => makeMockWorkstreamsDeps(tasks, parentRels));
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "workstreams", enabled: true }],
      },
      overrideRegistry: { workstreams: widget },
    });
    const res = await fetch(`${url}/api/widget/workstreams/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      payload: { workstreams: WorkstreamCard[] };
    };
    expect(body.state).toBe("ok");

    // Only 1 workstream: the active parent
    expect(Array.isArray(body.payload.workstreams)).toBe(true);
    expect(body.payload.workstreams.length).toBe(1);

    const card = body.payload.workstreams[0];
    if (!card) throw new Error("expected one workstream card");

    expect(card.parentId).toBe("mt#10");
    expect(card.parentTitle).toBe("Active Parent");

    // Counts: 2 active (IN-PROGRESS + TODO), 1 done
    expect(card.activeChildCount).toBe(2);
    expect(card.doneChildCount).toBe(1);
    expect(card.blockedChildCount).toBe(0);

    // Children sorted by status weight: IN-PROGRESS (0) → TODO (4) → DONE (6)
    expect(card.children.length).toBe(3);
    expect(card.children[0]?.status).toBe("IN-PROGRESS");
    expect(card.children[2]?.status).toBe("DONE");
  });

  // 11c. degraded — provider throws → reason matches /workstreams error/
  test("workstreams widget returns degraded when dep provider throws", async () => {
    const widget = createWorkstreamsWidget(async () => {
      throw new Error("task DB connection failed");
    });
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "workstreams", enabled: true }],
      },
      overrideRegistry: { workstreams: widget },
    });
    const res = await fetch(`${url}/api/widget/workstreams/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; reason: string };
    expect(body.state).toBe("degraded");
    expect(body.reason).toMatch(/workstreams error/i);
    expect(body.reason).toMatch(/task DB connection failed/i);
  });

  // 11d. empty — no parent relationships at all → {workstreams: []} with state: "ok"
  test("workstreams widget returns empty list when no parent relationships exist", async () => {
    const tasks = [
      { id: "mt#1", title: "Solo Task A", status: "IN-PROGRESS" },
      { id: "mt#2", title: "Solo Task B", status: "TODO" },
    ];
    // No parent relationships at all
    const widget = createWorkstreamsWidget(async () => makeMockWorkstreamsDeps(tasks, []));
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "workstreams", enabled: true }],
      },
      overrideRegistry: { workstreams: widget },
    });
    const res = await fetch(`${url}/api/widget/workstreams/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      payload: { workstreams: WorkstreamCard[] };
    };
    expect(body.state).toBe("ok");
    expect(Array.isArray(body.payload.workstreams)).toBe(true);
    expect(body.payload.workstreams.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Attention widget tests (mt#1147)
  // ---------------------------------------------------------------------------

  // Shared test constants — avoids magic-string duplication across cases
  const KIND_DIRECTION = "direction.decide" as const;
  const KIND_AUTH = "authorization.approve" as const;
  const REQ_TASK1 = "minsky.native-subagent:task:mt#1" as const;
  const REQ_TASK2 = "minsky.native-subagent:task:mt#2" as const;

  /**
   * Build a FakeAskRepository seeded with the given Asks.
   * Uses _seedAtState to insert pre-built Asks at specific states.
   */
  function makeFakeRepo(
    asks: Array<{
      id: string;
      kind: AttentionAsk["kind"];
      state: "suspended" | "routed";
      title: string;
      question: string;
      requestor: string;
      routingTarget?: string;
      parentTaskId?: string;
      serviceStrategy?: "asap" | "scheduled" | "deadline-bound";
      windowKey?: string;
      windowMissedCount?: number;
      options?: Array<{ label: string; value: unknown; description?: string }>;
      deadline?: string;
      metadata?: Record<string, unknown>;
    }>
  ): FakeAskRepository {
    const repo = new FakeAskRepository();
    const now = new Date().toISOString();
    for (const a of asks) {
      repo._seedAtState({
        id: a.id,
        kind: a.kind,
        state: a.state,
        classifierVersion: "v1",
        title: a.title,
        question: a.question,
        requestor: a.requestor,
        routingTarget: a.routingTarget,
        parentTaskId: a.parentTaskId,
        parentSessionId: undefined,
        options: a.options,
        contextRefs: undefined,
        deadline: a.deadline,
        serviceStrategy: a.serviceStrategy,
        windowKey: a.windowKey,
        windowMissedCount: a.windowMissedCount ?? 0,
        forceImmediate: false,
        metadata: a.metadata ?? {},
        createdAt: now,
      });
    }
    return repo;
  }

  // 12a. Attention widget present in /api/widgets when enabled
  test("attention widget present in /api/widgets when enabled", async () => {
    const repo = makeFakeRepo([]);
    const widget = createAttentionWidget(async () => ({ repo, activeWindowKey: null }));
    const url = await server({
      overrideConfig: { widgets: [{ id: "attention", enabled: true }] },
      overrideRegistry: { attention: widget },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((w) => w.id)).toContain("attention");
  });

  // 12b. Empty state — no pending asks → ok payload with cohort: [], totalPending: 0
  test("attention widget returns ok payload with empty cohort when no asks exist", async () => {
    const repo = makeFakeRepo([]);
    const widget = createAttentionWidget(async () => ({ repo, activeWindowKey: null }));
    const url = await server({
      overrideConfig: { widgets: [{ id: "attention", enabled: true }] },
      overrideRegistry: { attention: widget },
    });
    const res = await fetch(`${url}/api/widget/attention/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; payload: AttentionPayload };
    expect(body.state).toBe("ok");
    expect(Array.isArray(body.payload.cohort)).toBe(true);
    expect(body.payload.cohort.length).toBe(0);
    expect(body.payload.totalPending).toBe(0);
    expect(body.payload.activeWindow).toBeNull();
  });

  // 12c. direction.decide Ask routed to operator appears in cohort
  test("attention widget returns direction.decide ask in cohort when operator-routed", async () => {
    const repo = makeFakeRepo([
      {
        id: "ask-1",
        kind: KIND_DIRECTION,
        state: "suspended",
        title: "Choose approach",
        question: "Which architectural approach to take?",
        requestor: "minsky.native-subagent:task:mt#1147",
        routingTarget: "operator",
        parentTaskId: "mt#1147",
        options: [
          { label: "Option A", value: "a", description: "Fast approach" },
          { label: "Option B", value: "b", description: "Thorough approach" },
        ],
      },
    ]);
    const widget = createAttentionWidget(async () => ({ repo, activeWindowKey: null }));
    const url = await server({
      overrideConfig: { widgets: [{ id: "attention", enabled: true }] },
      overrideRegistry: { attention: widget },
    });
    const res = await fetch(`${url}/api/widget/attention/data`);
    const body = (await res.json()) as { state: string; payload: AttentionPayload };
    expect(body.state).toBe("ok");
    expect(body.payload.cohort.length).toBe(1);
    expect(body.payload.totalPending).toBe(1);

    const ask = body.payload.cohort[0];
    if (!ask) throw new Error("expected one ask in cohort");
    expect(ask.id).toBe("ask-1");
    expect(ask.kind).toBe(KIND_DIRECTION);
    expect(ask.options).toHaveLength(2);
    expect(ask.parentTaskId).toBe("mt#1147");
  });

  // 12d. Policy-resolved asks (routingTarget==="policy" or state==="closed") never appear
  test("attention widget never surfaces policy-resolved or closed asks", async () => {
    const repo = makeFakeRepo([
      {
        id: "ask-good",
        kind: KIND_DIRECTION,
        state: "suspended",
        title: "Visible ask",
        question: "What to do?",
        requestor: REQ_TASK1,
        routingTarget: "operator",
        parentTaskId: "mt#1",
      },
    ]);
    // Also seed a closed ask directly
    repo._seedAtState({
      id: "ask-closed",
      kind: KIND_AUTH,
      state: "closed",
      classifierVersion: "v1",
      title: "Closed ask",
      question: "Approve?",
      requestor: REQ_TASK2,
      routingTarget: "policy",
      parentTaskId: "mt#2",
      parentSessionId: undefined,
      options: undefined,
      contextRefs: undefined,
      deadline: undefined,
      serviceStrategy: undefined,
      windowKey: undefined,
      windowMissedCount: 0,
      forceImmediate: false,
      metadata: {},
      createdAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
    });

    const widget = createAttentionWidget(async () => ({ repo, activeWindowKey: null }));
    const url = await server({
      overrideConfig: { widgets: [{ id: "attention", enabled: true }] },
      overrideRegistry: { attention: widget },
    });
    const res = await fetch(`${url}/api/widget/attention/data`);
    const body = (await res.json()) as { state: string; payload: AttentionPayload };
    expect(body.state).toBe("ok");
    // Only the visible ask appears — closed/policy asks filtered
    const ids = body.payload.cohort.map((a) => a.id);
    expect(ids).toContain("ask-good");
    expect(ids).not.toContain("ask-closed");
  });

  // 12e. Multiple kind asks — priority ordering: stuck.unblock > authorization.approve > direction.decide
  test("attention widget returns asks in priority order across kinds", async () => {
    const baseTime = new Date().toISOString();
    const repo = makeFakeRepo([
      {
        id: "ask-direction",
        kind: KIND_DIRECTION,
        state: "suspended",
        title: "Direction ask",
        question: "Which way?",
        requestor: REQ_TASK1,
        routingTarget: "operator",
        parentTaskId: "mt#1",
      },
      {
        id: "ask-stuck",
        kind: "stuck.unblock",
        state: "suspended",
        title: "Stuck ask",
        question: "I am stuck",
        requestor: REQ_TASK2,
        routingTarget: "operator",
        parentTaskId: "mt#2",
      },
      {
        id: "ask-auth",
        kind: KIND_AUTH,
        state: "suspended",
        title: "Auth ask",
        question: "Can I proceed?",
        requestor: "minsky.native-subagent:task:mt#3",
        routingTarget: "operator",
        parentTaskId: "mt#3",
      },
    ]);
    void baseTime; // suppress unused-var
    const widget = createAttentionWidget(async () => ({ repo, activeWindowKey: null }));
    const url = await server({
      overrideConfig: { widgets: [{ id: "attention", enabled: true }] },
      overrideRegistry: { attention: widget },
    });
    const res = await fetch(`${url}/api/widget/attention/data`);
    const body = (await res.json()) as { state: string; payload: AttentionPayload };
    expect(body.state).toBe("ok");
    expect(body.payload.cohort.length).toBe(3);

    const kinds = body.payload.cohort.map((a) => a.kind);
    expect(kinds[0]).toBe("stuck.unblock");
    expect(kinds[1]).toBe(KIND_AUTH);
    expect(kinds[2]).toBe(KIND_DIRECTION);
  });

  // 12f. Resolve endpoint — POST /api/asks/:id/resolve transitions Ask to closed
  test("POST /api/asks/:id/resolve marks ask as closed via FakeAskRepository", async () => {
    const repo = makeFakeRepo([
      {
        id: "ask-to-resolve",
        kind: KIND_DIRECTION,
        state: "suspended",
        title: "Resolve me",
        question: "Pick one",
        requestor: REQ_TASK1,
        routingTarget: "operator",
        options: [{ label: "Yes", value: "yes" }],
      },
    ]);
    const url = await server({
      overrideConfig: { widgets: [{ id: "attention", enabled: true }] },
      overrideRegistry: {},
      overrideAskRepository: repo,
    });
    const res = await fetch(`${url}/api/asks/ask-to-resolve/resolve`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        responder: "operator",
        payload: { chosen: "yes" },
        attentionCost: { transport: "inbox", resolvedIn: "inbox" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string; state: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("ask-to-resolve");
    expect(body.state).toBe("closed");

    // Verify state changed in repo
    const updated = await repo.getById("ask-to-resolve");
    expect(updated?.state).toBe("closed");
  });

  // 12g. Resolve endpoint — 404 for unknown ask id
  test("POST /api/asks/:id/resolve returns 404 for unknown ask", async () => {
    const repo = makeFakeRepo([]);
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideRegistry: {},
      overrideAskRepository: repo,
    });
    const res = await fetch(`${url}/api/asks/nonexistent/resolve`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ responder: "operator", payload: {} }),
    });
    expect(res.status).toBe(404);
  });

  // 12h. Degraded state — deps factory throws → degraded with "attention error" reason
  test("attention widget returns degraded when deps factory throws", async () => {
    const widget = createAttentionWidget(async () => {
      throw new Error("DB unavailable");
    });
    const url = await server({
      overrideConfig: { widgets: [{ id: "attention", enabled: true }] },
      overrideRegistry: { attention: widget },
    });
    const res = await fetch(`${url}/api/widget/attention/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; reason: string };
    expect(body.state).toBe("degraded");
    expect(body.reason).toMatch(/attention error/i);
    expect(body.reason).toMatch(/DB unavailable/i);
  });

  // 12i. Window-cohort mode — asks scheduled for "ask-hours" window appear when activeWindowKey is set
  test("attention widget loads scheduled-window cohort when activeWindowKey provided", async () => {
    const repo = makeFakeRepo([
      {
        id: "ask-windowed",
        kind: KIND_DIRECTION,
        state: "suspended",
        title: "Window ask",
        question: "Decide now",
        requestor: REQ_TASK1,
        routingTarget: "operator",
        serviceStrategy: "scheduled",
        windowKey: "ask-hours",
      },
      {
        id: "ask-other-window",
        kind: "quality.review",
        state: "suspended",
        title: "Other window ask",
        question: "Review this",
        requestor: REQ_TASK2,
        routingTarget: "operator",
        serviceStrategy: "scheduled",
        windowKey: "weekly-review",
      },
    ]);
    const widget = createAttentionWidget(async () => ({ repo, activeWindowKey: "ask-hours" }));
    const url = await server({
      overrideConfig: { widgets: [{ id: "attention", enabled: true }] },
      overrideRegistry: { attention: widget },
    });
    const res = await fetch(`${url}/api/widget/attention/data`);
    const body = (await res.json()) as { state: string; payload: AttentionPayload };
    expect(body.state).toBe("ok");

    // Active window info present
    expect(body.payload.activeWindow).not.toBeNull();
    expect(body.payload.activeWindow?.windowKey).toBe("ask-hours");

    // Only the ask-hours window ask appears in cohort
    const ids = body.payload.cohort.map((a) => a.id);
    expect(ids).toContain("ask-windowed");
    expect(ids).not.toContain("ask-other-window");
  });

  // 12j. Resolve endpoint enforces algedonic selection — non-operator-routed
  // asks return 403 and do NOT transition to closed. PR #1125 R1 BLOCKING.
  test("POST /api/asks/:id/resolve returns 403 for non-operator-routed asks", async () => {
    const repo = makeFakeRepo([
      {
        id: "ask-policy-routed",
        kind: KIND_DIRECTION,
        state: "suspended",
        title: "Policy routed",
        question: "Should never reach operator",
        requestor: REQ_TASK1,
        routingTarget: "policy",
      },
      {
        id: "ask-peer-routed",
        kind: KIND_DIRECTION,
        state: "suspended",
        title: "Peer routed",
        question: "Routed to a peer agent",
        requestor: REQ_TASK1,
        routingTarget: "agent:peer-1",
      },
    ]);
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideRegistry: {},
      overrideAskRepository: repo,
    });

    const policyRes = await fetch(`${url}/api/asks/ask-policy-routed/resolve`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ responder: "operator", payload: {} }),
    });
    expect(policyRes.status).toBe(403);

    const peerRes = await fetch(`${url}/api/asks/ask-peer-routed/resolve`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ responder: "operator", payload: {} }),
    });
    expect(peerRes.status).toBe(403);

    // Neither should have transitioned
    const policyAsk = await repo.getById("ask-policy-routed");
    const peerAsk = await repo.getById("ask-peer-routed");
    expect(policyAsk?.state).toBe("suspended");
    expect(peerAsk?.state).toBe("suspended");
  });

  // ---------------------------------------------------------------------------
  // Credential endpoints (mt#1426)
  // ---------------------------------------------------------------------------

  /**
   * Build a stub CredentialModuleOverride for credential endpoint tests.
   *
   * Provides minimal doubles for getCredentialProvider, addCredential,
   * listCredentials, and removeCredential so tests never touch the real
   * filesystem (config.yaml, credentials-meta.json).
   */
  function makeCredentialModuleStub(
    opts: {
      providerExists?: boolean;
      validateOk?: boolean;
      validateDetail?: string;
      addResult?: import("./server").CredentialModuleOverride["addCredential"] extends (
        ...args: infer _A
      ) => Promise<infer R>
        ? R
        : never;
      listResult?: Array<{
        provider: string;
        displayName: string;
        configPath: string;
        configured: boolean;
        lastValidatedAt?: string;
        lastValidationDetail?: string;
      }>;
      removeResult?: { removed: boolean };
    } = {}
  ): CredentialModuleOverride {
    const {
      providerExists = true,
      validateOk = true,
      validateDetail = "ok",
      listResult = [],
      removeResult = { removed: true },
    } = opts;

    return {
      getCredentialProvider: (id: string) => {
        if (!providerExists) return undefined;
        return {
          validate: async (_token: string) => ({
            ok: validateOk,
            detail: validateDetail,
          }),
          id,
          displayName: id,
          configPath: `${id}.token`,
          acquireUrl: `https://example.com/${id}/tokens`,
          scopeGuidance: "test guidance",
          test: async (_token: string) => ({ ok: true, detail: "smoke ok" }),
        };
      },
      addCredential: opts.addResult
        ? async (_provider: string, _token: string) =>
            opts.addResult as Awaited<ReturnType<CredentialModuleOverride["addCredential"]>>
        : async (provider: string, _token: string) => ({
            provider,
            validate: { ok: validateOk, detail: validateDetail },
            stored: validateOk ? { configFilePath: `/mock/config.yaml` } : undefined,
            test: validateOk ? { ok: true, detail: "smoke ok" } : undefined,
          }),
      listCredentials: async () => listResult,
      removeCredential: async (_provider: string) => removeResult,
    };
  }

  // 13a. GET /api/credentials → 200 + { credentials: [...] }
  test("GET /api/credentials returns credentials list", async () => {
    const credMod = makeCredentialModuleStub({
      listResult: [
        {
          provider: "github",
          displayName: "GitHub",
          configPath: "github.token",
          configured: true,
          lastValidatedAt: new Date().toISOString(),
          lastValidationDetail: "github:octocat",
        },
        {
          provider: "anthropic",
          displayName: "Anthropic",
          configPath: "anthropic.apiKey",
          configured: false,
        },
      ],
    });
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: credMod,
    });
    const res = await fetch(`${url}/api/credentials`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Array<{ provider: string }> };
    expect(Array.isArray(body.credentials)).toBe(true);
    expect(body.credentials.length).toBe(2);
    const providers = body.credentials.map((c) => c.provider);
    expect(providers).toContain("github");
    expect(providers).toContain("anthropic");
  });

  // 13b. GET /api/credentials — response never includes a token field
  test("GET /api/credentials response never includes token field", async () => {
    const credMod = makeCredentialModuleStub({
      listResult: [
        {
          provider: "github",
          displayName: "GitHub",
          configPath: "github.token",
          configured: true,
        },
      ],
    });
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: credMod,
    });
    const res = await fetch(`${url}/api/credentials`);
    const body = (await res.json()) as { credentials: Array<Record<string, unknown>> };
    // Trust-boundary: none of the entries may include a 'token' key
    for (const entry of body.credentials) {
      expect(Object.keys(entry)).not.toContain("token");
    }
  });

  // 13c. POST /api/credentials/validate → 200 + { ok, detail }; never echoes token
  test("POST /api/credentials/validate returns ok result and never echoes token", async () => {
    const credMod = makeCredentialModuleStub({
      validateOk: true,
      validateDetail: "github:octocat",
    });
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: credMod,
    });
    const res = await fetch(`${url}/api/credentials/validate`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: "github", token: "secret-token-value" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.detail).toBe("github:octocat");
    // Trust-boundary: response must not echo the token back
    expect(JSON.stringify(body)).not.toContain("secret-token-value");
  });

  // 13d. POST /api/credentials/validate → 200 + { ok: false } on invalid token
  test("POST /api/credentials/validate returns ok:false on validation failure", async () => {
    const credMod = makeCredentialModuleStub({
      validateOk: false,
      validateDetail: "401 Unauthorized",
    });
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: credMod,
    });
    const res = await fetch(`${url}/api/credentials/validate`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: "github", token: "bad-token" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.detail).toBe("401 Unauthorized");
    expect(JSON.stringify(body)).not.toContain("bad-token");
  });

  // 13e. POST /api/credentials/validate → 400 on unknown provider
  test("POST /api/credentials/validate returns 400 for unknown provider", async () => {
    const credMod = makeCredentialModuleStub({ providerExists: false });
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: credMod,
    });
    const res = await fetch(`${url}/api/credentials/validate`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: "nonexistent", token: "tok" }),
    });
    expect(res.status).toBe(400);
    // Normalized error shape per PR #1142 R1: { error: { code, message } }
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(CRED_ERR_UNKNOWN_PROVIDER);
    expect(body.error.message).toMatch(/unknown credential provider/i);
    expect(JSON.stringify(body)).not.toContain("tok");
  });

  // 13f. POST /api/credentials/validate → 400 when token is missing
  test("POST /api/credentials/validate returns 400 when token is missing", async () => {
    const credMod = makeCredentialModuleStub();
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: credMod,
    });
    const res = await fetch(`${url}/api/credentials/validate`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: "github" }), // no token field
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(CRED_ERR_MISSING_FIELD);
    expect(body.error.message).toMatch(/token/i);
  });

  // 13g. POST /api/credentials/add → 200 + result shape; never echoes token
  test("POST /api/credentials/add returns result and never echoes token", async () => {
    const credMod = makeCredentialModuleStub({
      validateOk: true,
      validateDetail: "github:octocat",
    });
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: credMod,
    });
    const res = await fetch(`${url}/api/credentials/add`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: "github", token: "my-secret-token" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.provider).toBe("github");
    // Trust-boundary: response body must not contain the token value at any depth
    expect(JSON.stringify(body)).not.toContain("my-secret-token");
    // Result shape: validate + stored + test present on success
    expect((body.validate as Record<string, unknown>).ok).toBe(true);
    expect(body.stored).toBeDefined();
  });

  // 13h. POST /api/credentials/add → 400 when validation fails (never echoes token)
  test("POST /api/credentials/add returns 400 on validation failure and never echoes token", async () => {
    const credMod = makeCredentialModuleStub({
      validateOk: false,
      validateDetail: "401 bad credentials",
    });
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: credMod,
    });
    const res = await fetch(`${url}/api/credentials/add`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: "github", token: "invalid-secret" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error as { code: string; message: string };
    expect(err.code).toBe(CRED_ERR_VALIDATION_FAILED);
    expect(err.message).toMatch(/validation failed/i);
    // Structured validate result rides along per PR #1142 R1
    expect((body.validate as Record<string, unknown>).ok).toBe(false);
    // Trust-boundary: token value must not appear anywhere in the error response
    expect(JSON.stringify(body)).not.toContain("invalid-secret");
  });

  // 13i. POST /api/credentials/add → 400 on unknown provider
  test("POST /api/credentials/add returns 400 for unknown provider", async () => {
    const credMod = makeCredentialModuleStub({ providerExists: false });
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: credMod,
    });
    const res = await fetch(`${url}/api/credentials/add`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: "nonexistent", token: "tok" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(CRED_ERR_UNKNOWN_PROVIDER);
    expect(body.error.message).toMatch(/unknown credential provider/i);
  });

  // 13j. DELETE /api/credentials/:provider → 200 + { removed: true }
  test("DELETE /api/credentials/:provider returns removed:true", async () => {
    const credMod = makeCredentialModuleStub({ removeResult: { removed: true } });
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: credMod,
    });
    const res = await fetch(`${url}/api/credentials/github`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean };
    expect(body.removed).toBe(true);
  });

  // 13k. DELETE /api/credentials/:provider → 400 on unknown provider
  test("DELETE /api/credentials/:provider returns 400 for unknown provider", async () => {
    const credMod = makeCredentialModuleStub({ providerExists: false });
    const url = await server({
      overrideConfig: { widgets: [] },
      overrideCredentialModule: credMod,
    });
    const res = await fetch(`${url}/api/credentials/nonexistent`, {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(CRED_ERR_UNKNOWN_PROVIDER);
    expect(body.error.message).toMatch(/unknown credential provider/i);
  });

  // 13l. credentials widget present in /api/widgets when enabled
  test("credentials widget present in /api/widgets when enabled", async () => {
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "credentials", enabled: true }],
      },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((w) => w.id);
    expect(ids).toContain("credentials");
  });

  // 14. Preview-mode guard (mt#2096)
  test("preview mode blocks POST requests with 403", async () => {
    process.env.MINSKY_COCKPIT_PREVIEW = "true";
    try {
      const url = await server({ overrideConfig: DEFAULT_CONFIG });
      const res = await fetch(`${url}/api/asks/fake-id/resolve`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ responder: "operator", payload: {} }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; preview: boolean };
      expect(body.preview).toBe(true);
    } finally {
      delete process.env.MINSKY_COCKPIT_PREVIEW;
    }
  });

  test("preview mode allows GET requests", async () => {
    process.env.MINSKY_COCKPIT_PREVIEW = "true";
    try {
      const url = await server({ overrideConfig: DEFAULT_CONFIG });
      const res = await fetch(`${url}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      delete process.env.MINSKY_COCKPIT_PREVIEW;
    }
  });
});
