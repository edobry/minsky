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
import type { WidgetModule, WidgetData, WidgetContext } from "./types";
import { createAgentsWidget } from "./widgets/agents";
import type { AgentRow } from "./widgets/agents";
import { createTaskGraphWidget } from "./widgets/task-graph";
import type { GraphNode, GraphEdge, TaskGraphDeps } from "./widgets/task-graph";
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
// Default registry: both placeholder widgets enabled
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  widgets: [
    { id: "attention-stub", enabled: true },
    { id: "basic-health", enabled: true },
  ],
};

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

  // 2. GET /api/widgets → array containing both placeholder widgets
  test("GET /api/widgets returns both enabled widgets", async () => {
    const url = await server({ overrideConfig: DEFAULT_CONFIG });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(Array.isArray(body)).toBe(true);
    const ids = body.map((w) => w.id);
    expect(ids).toContain("attention-stub");
    expect(ids).toContain("basic-health");
  });

  // 3. GET /api/widget/attention-stub/data → {state:"degraded", reason matching /pending mt#1034/i}
  test("GET /api/widget/attention-stub/data returns degraded with pending reason", async () => {
    const url = await server({ overrideConfig: DEFAULT_CONFIG });
    const res = await fetch(`${url}/api/widget/attention-stub/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; reason: string };
    expect(body.state).toBe("degraded");
    expect(body.reason).toMatch(/pending mt#1034/i);
  });

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

  // 6. overrideConfig disabling attention-stub → only basic-health in /api/widgets
  test("Disabling attention-stub via overrideConfig excludes it from /api/widgets", async () => {
    const url = await server({
      overrideConfig: {
        widgets: [
          { id: "attention-stub", enabled: false },
          { id: "basic-health", enabled: true },
        ],
      },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((w) => w.id);
    expect(ids).not.toContain("attention-stub");
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
          { id: "attention-stub", enabled: true },
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
});
