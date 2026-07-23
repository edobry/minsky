/**
 * Unit tests for the agents widget task-title enrichment (mt#1888).
 *
 * These tests focus on the server-side AgentRow.taskTitle population logic in
 * createAgentsWidget(). Widget integration tests (HTTP round-trip, filtering,
 * title-from-branch fallback) live in src/cockpit/cockpit.test.ts.
 */
import { describe, test, expect } from "bun:test";
import { createAgentsWidget, isWithinActiveWindow } from "./agents";
import type { TaskProviderLike, AgentRow } from "./agents";
import type {
  SessionProviderInterface,
  SessionRecord,
  SessionListOptions,
} from "@minsky/domain/session/types";
import { SessionStatus } from "@minsky/domain/session/types";
import type { SessionAttachment } from "@minsky/domain/session/index";
import { isAllProjects } from "@minsky/domain/project/scope";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionProvider(records: SessionRecord[]): SessionProviderInterface {
  return {
    listSessions: async (options?: SessionListOptions) => {
      const excluded = options?.statusNotIn;
      if (excluded && excluded.length > 0) {
        return records.filter((r) => !r.status || !excluded.includes(r.status));
      }
      return records;
    },
    getSession: async () => null,
    getSessionByTaskId: async () => null,
    addSession: async () => {},
    updateSession: async () => {},
    deleteSession: async () => false,
    getRepoPath: async () => "",
    getSessionWorkdir: async () => "",
  };
}

function makeTaskProvider(tasks: Record<string, string>): TaskProviderLike {
  return {
    getTask: async (taskId: string) => {
      const title = tasks[taskId];
      return title != null ? { title } : null;
    },
  };
}

const NOW = new Date();

const S1 = "s1-0000-0000-0000-000000000001";
const S2 = "s2-0000-0000-0000-000000000002";
const S3 = "s3-0000-0000-0000-000000000003";

function makeActiveSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "aaaaaaaa-0000-0000-0000-000000000001",
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky",
    createdAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
    status: SessionStatus.ACTIVE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task-title enrichment tests
// ---------------------------------------------------------------------------

describe("createAgentsWidget — task title enrichment", () => {
  test("populates taskTitle when task provider returns a matching task", async () => {
    const session = makeActiveSession({ taskId: "mt#1888" });
    const widget = createAgentsWidget(
      async () => makeSessionProvider([session]),
      async () => makeTaskProvider({ "mt#1888": "Build the X" })
    );

    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");

    const agents = (data.payload as { agents: { taskTitle: string | null }[] }).agents;
    expect(agents.length).toBe(1);
    const row = agents[0];
    if (!row) throw new Error("row missing");
    expect(row.taskTitle).toBe("Build the X");
  });

  test("taskTitle is null when task provider returns null for the taskId", async () => {
    const session = makeActiveSession({ taskId: "mt#9999" });
    const widget = createAgentsWidget(
      async () => makeSessionProvider([session]),
      async () => makeTaskProvider({}) // nothing known
    );

    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");

    const agents = (data.payload as { agents: { taskTitle: string | null; title: string }[] })
      .agents;
    expect(agents.length).toBe(1);
    const row = agents[0];
    if (!row) throw new Error("row missing");
    expect(row.taskTitle).toBeNull();
    // Fallback title still populated via branch ?? sessionId
    expect(row.title).toBe(session.sessionId);
  });

  test("taskTitle is null when no task provider is supplied", async () => {
    const session = makeActiveSession({ taskId: "mt#1888" });
    // No task provider — second argument omitted
    const widget = createAgentsWidget(async () => makeSessionProvider([session]));

    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");

    const agents = (data.payload as { agents: { taskTitle: string | null }[] }).agents;
    const row = agents[0];
    if (!row) throw new Error("row missing");
    expect(row.taskTitle).toBeNull();
  });

  test("taskTitle is null when session has no taskId, regardless of task provider", async () => {
    const session = makeActiveSession({ taskId: undefined });
    const widget = createAgentsWidget(
      async () => makeSessionProvider([session]),
      async () => makeTaskProvider({ "mt#1888": "Build the X" })
    );

    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");

    const agents = (data.payload as { agents: { taskTitle: string | null }[] }).agents;
    const row = agents[0];
    if (!row) throw new Error("row missing");
    expect(row.taskTitle).toBeNull();
  });

  test("task provider failure is non-fatal — rows still present with taskTitle: null", async () => {
    const session = makeActiveSession({ taskId: "mt#1888" });
    const widget = createAgentsWidget(
      async () => makeSessionProvider([session]),
      async () => {
        throw new Error("task backend unavailable");
      }
    );

    // Should not throw — widget degrades gracefully
    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");

    const agents = (data.payload as { agents: { taskTitle: string | null }[] }).agents;
    expect(agents.length).toBe(1);
    const row = agents[0];
    if (!row) throw new Error("row missing");
    expect(row.taskTitle).toBeNull();
  });

  test("batch-fetches titles for all unique taskIds in one pass", async () => {
    const callLog: string[] = [];
    const taskProvider: TaskProviderLike = {
      getTask: async (taskId: string) => {
        callLog.push(taskId);
        if (taskId === "mt#100") return { title: "Task 100" };
        if (taskId === "mt#200") return { title: "Task 200" };
        return null;
      },
    };

    const sessions = [
      makeActiveSession({ sessionId: S1, taskId: "mt#100" }),
      makeActiveSession({ sessionId: S2, taskId: "mt#200" }),
      // Third session re-uses mt#100 — should NOT trigger a second getTask call
      makeActiveSession({ sessionId: S3, taskId: "mt#100" }),
    ];

    const widget = createAgentsWidget(
      async () => makeSessionProvider(sessions),
      async () => taskProvider
    );

    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");

    const agents = (data.payload as { agents: { taskTitle: string | null; sessionId: string }[] })
      .agents;
    expect(agents.length).toBe(3);

    // Title lookup is deduplicated — only 2 unique taskIds
    expect(callLog.length).toBe(2);
    expect(callLog.sort()).toEqual(["mt#100", "mt#200"]);

    const s1 = agents.find((a) => a.sessionId === S1);
    const s2 = agents.find((a) => a.sessionId === S2);
    const s3 = agents.find((a) => a.sessionId === S3);

    expect(s1?.taskTitle).toBe("Task 100");
    expect(s2?.taskTitle).toBe("Task 200");
    expect(s3?.taskTitle).toBe("Task 100");
  });

  test("uses getTasks batch method when available and skips individual getTask", async () => {
    const getTaskCalls: string[] = [];
    const getTasksCalls: string[][] = [];
    const taskProvider: TaskProviderLike = {
      getTask: async (taskId: string) => {
        getTaskCalls.push(taskId);
        return { title: `Individual ${taskId}` };
      },
      getTasks: async (ids: string[]) => {
        getTasksCalls.push(ids);
        return ids.map((id) => ({ id, title: `Batch ${id}` }));
      },
    };

    const sessions = [
      makeActiveSession({ sessionId: S1, taskId: "mt#100" }),
      makeActiveSession({ sessionId: S2, taskId: "mt#200" }),
    ];

    const widget = createAgentsWidget(
      async () => makeSessionProvider(sessions),
      async () => taskProvider
    );

    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");

    const agents = (data.payload as { agents: { taskTitle: string | null; sessionId: string }[] })
      .agents;

    // Batch path was used, not individual
    expect(getTasksCalls.length).toBe(1);
    expect(getTaskCalls.length).toBe(0);

    const s1 = agents.find((a) => a.sessionId === S1);
    const s2 = agents.find((a) => a.sessionId === S2);
    expect(s1?.taskTitle).toBe("Batch mt#100");
    expect(s2?.taskTitle).toBe("Batch mt#200");
  });

  test("batch getTasks with partial results leaves missing titles as null", async () => {
    const taskProvider: TaskProviderLike = {
      getTask: async () => null,
      getTasks: async (ids: string[]) => {
        // Only return the first ID, omit the second
        return ids.slice(0, 1).map((id) => ({ id, title: `Found ${id}` }));
      },
    };

    const sessions = [
      makeActiveSession({ sessionId: S1, taskId: "mt#100" }),
      makeActiveSession({ sessionId: S2, taskId: "mt#200" }),
    ];

    const widget = createAgentsWidget(
      async () => makeSessionProvider(sessions),
      async () => taskProvider
    );

    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");

    const agents = (data.payload as { agents: { taskTitle: string | null; sessionId: string }[] })
      .agents;

    const s1 = agents.find((a) => a.sessionId === S1);
    const s2 = agents.find((a) => a.sessionId === S2);
    expect(s1?.taskTitle).toBe("Found mt#100");
    expect(s2?.taskTitle).toBeNull();
  });

  test("deduplicates taskIds after normalization", async () => {
    const getTasksCalls: string[][] = [];
    const taskProvider: TaskProviderLike = {
      getTask: async () => null,
      getTasks: async (ids: string[]) => {
        getTasksCalls.push(ids);
        return ids.map((id) => ({ id, title: `Title for ${id}` }));
      },
    };

    const sessions = [
      // Two sessions with the same qualified taskId should produce one lookup
      makeActiveSession({ sessionId: S1, taskId: "mt#100" }),
      makeActiveSession({ sessionId: S2, taskId: "mt#100" }),
      // A different task to confirm it's not collapsed
      makeActiveSession({ sessionId: S3, taskId: "mt#200" }),
    ];

    const widget = createAgentsWidget(
      async () => makeSessionProvider(sessions),
      async () => taskProvider
    );

    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");

    // Only two unique IDs after dedup
    expect(getTasksCalls.length).toBe(1);
    const batchIds = getTasksCalls[0] ?? [];
    expect(batchIds.length).toBe(2);
    expect([...batchIds].sort()).toEqual(["mt#100", "mt#200"]);

    const agents = (data.payload as { agents: { taskTitle: string | null }[] }).agents;
    expect(agents[0]?.taskTitle).toBe("Title for mt#100");
    expect(agents[1]?.taskTitle).toBe("Title for mt#100");
    expect(agents[2]?.taskTitle).toBe("Title for mt#200");
  });
});

describe("createAgentsWidget — pagination and caching", () => {
  test("payload includes totalCount reflecting all non-terminal sessions", async () => {
    const sessions = [
      makeActiveSession({ sessionId: S1, taskId: "mt#100" }),
      makeActiveSession({ sessionId: S2, taskId: "mt#200" }),
      makeActiveSession({ sessionId: S3, taskId: "mt#300", status: SessionStatus.MERGED }),
    ];

    const widget = createAgentsWidget(async () => makeSessionProvider(sessions));

    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");

    const payload = data.payload as { agents: AgentRow[]; totalCount: number };
    expect(payload.agents.length).toBe(2);
    expect(payload.totalCount).toBe(2);
  });

  test("limit/offset query params paginate the result", async () => {
    const sessions = [
      makeActiveSession({ sessionId: "a1-0000-0000-0000-000000000001", taskId: "mt#1" }),
      makeActiveSession({ sessionId: "a2-0000-0000-0000-000000000002", taskId: "mt#2" }),
      makeActiveSession({ sessionId: "a3-0000-0000-0000-000000000003", taskId: "mt#3" }),
      makeActiveSession({ sessionId: "a4-0000-0000-0000-000000000004", taskId: "mt#4" }),
      makeActiveSession({ sessionId: "a5-0000-0000-0000-000000000005", taskId: "mt#5" }),
    ];

    const widget = createAgentsWidget(async () => makeSessionProvider(sessions));

    const page1 = await widget.fetch({ id: "agents", query: { limit: "2", offset: "0" } });
    expect(page1.state).toBe("ok");
    if (page1.state !== "ok") throw new Error("expected ok");
    const p1 = page1.payload as { agents: AgentRow[]; totalCount: number };
    expect(p1.agents.length).toBe(2);
    expect(p1.totalCount).toBe(5);

    const page2 = await widget.fetch({ id: "agents", query: { limit: "2", offset: "2" } });
    expect(page2.state).toBe("ok");
    if (page2.state !== "ok") throw new Error("expected ok");
    const p2 = page2.payload as { agents: AgentRow[]; totalCount: number };
    expect(p2.agents.length).toBe(2);
    expect(p2.totalCount).toBe(5);

    // Pages don't overlap
    const p1Ids = p1.agents.map((a) => a.sessionId);
    const p2Ids = p2.agents.map((a) => a.sessionId);
    expect(p1Ids.filter((id) => p2Ids.includes(id)).length).toBe(0);
  });

  test("task-title cache skips getTasks on second fetch within TTL", async () => {
    let getTasksCallCount = 0;
    const taskProvider: TaskProviderLike = {
      getTask: async () => null,
      getTasks: async (ids: string[]) => {
        getTasksCallCount++;
        return ids.map((id) => ({ id, title: `Title ${id}` }));
      },
    };

    const sessions = [makeActiveSession({ sessionId: S1, taskId: "mt#100" })];

    const widget = createAgentsWidget(
      async () => makeSessionProvider(sessions),
      async () => taskProvider
    );

    const data1 = await widget.fetch({ id: "agents" });
    expect(data1.state).toBe("ok");
    expect(getTasksCallCount).toBe(1);

    const data2 = await widget.fetch({ id: "agents" });
    expect(data2.state).toBe("ok");
    // Cache hit — no second getTasks call
    expect(getTasksCallCount).toBe(1);

    if (data2.state !== "ok") throw new Error("expected ok");
    const payload = data2.payload as { agents: AgentRow[] };
    expect(payload.agents[0]?.taskTitle).toBe("Title mt#100");
  });

  test("cache read-through: second page fetches only unseen IDs", async () => {
    const getTasksCalls: string[][] = [];
    const taskProvider: TaskProviderLike = {
      getTask: async () => null,
      getTasks: async (ids: string[]) => {
        getTasksCalls.push([...ids]);
        return ids.map((id) => ({ id, title: `Title ${id}` }));
      },
    };

    const page1Sessions = [
      makeActiveSession({ sessionId: S1, taskId: "mt#100" }),
      makeActiveSession({ sessionId: S2, taskId: "mt#200" }),
    ];

    const page2Sessions = [
      makeActiveSession({ sessionId: S1, taskId: "mt#100" }),
      makeActiveSession({ sessionId: S2, taskId: "mt#200" }),
      makeActiveSession({ sessionId: S3, taskId: "mt#300" }),
    ];

    let currentSessions = page1Sessions;
    const widget = createAgentsWidget(
      async () => makeSessionProvider(currentSessions),
      async () => taskProvider
    );

    // Page 1: warms cache with mt#100, mt#200
    await widget.fetch({ id: "agents" });
    expect(getTasksCalls.length).toBe(1);
    expect(getTasksCalls[0]?.sort()).toEqual(["mt#100", "mt#200"]);

    // Page 2: mt#300 is new — should fetch only mt#300
    currentSessions = page2Sessions;
    const data2 = await widget.fetch({ id: "agents" });
    expect(getTasksCalls.length).toBe(2);
    expect(getTasksCalls[1]).toEqual(["mt#300"]);

    if (data2.state !== "ok") throw new Error("expected ok");
    const agents = (data2.payload as { agents: AgentRow[] }).agents;
    expect(agents.find((a) => a.sessionId === S3)?.taskTitle).toBe("Title mt#300");
    // Cached titles still work
    expect(agents.find((a) => a.sessionId === S1)?.taskTitle).toBe("Title mt#100");
  });
});

// ---------------------------------------------------------------------------
// Driven-session splice (mt#2752)
// ---------------------------------------------------------------------------

import { spliceDrivenSessions } from "./agents";
import type { DrivenSessionSnapshot } from "./agents";

const DRIVEN_LOCAL_ID = "dddddddd-0000-0000-0000-000000000001";

function makeDrivenSnapshot(overrides: Partial<DrivenSessionSnapshot> = {}): DrivenSessionSnapshot {
  return {
    localId: DRIVEN_LOCAL_ID,
    cwd: "/fixture-state/sessions/aaaaaaaa-0000-0000-0000-000000000001",
    status: "running",
    startedAt: NOW.toISOString(),
    taskId: "mt#9999",
    minskySessionId: "aaaaaaaa-0000-0000-0000-000000000001",
    harnessSessionId: null,
    ...overrides,
  };
}

describe("spliceDrivenSessions", () => {
  test("annotates the matching workspace row instead of adding a new row", async () => {
    const widget = createAgentsWidget(
      async () => makeSessionProvider([makeActiveSession({ taskId: "mt#9999" })]),
      undefined,
      undefined,
      () => [makeDrivenSnapshot()]
    );
    const data = await widget.fetch({ id: "agents" });
    if (data.state !== "ok") throw new Error("expected ok");
    const agents = (data.payload as { agents: AgentRow[] }).agents;

    expect(agents.length).toBe(1);
    const row = agents[0];
    expect(row?.kind).toBe("dispatched-agent");
    expect(row?.driven).toEqual({
      sessionId: DRIVEN_LOCAL_ID,
      status: "running",
    });
  });

  test("emits a standalone driven-session row for an untasked scratch session", async () => {
    const widget = createAgentsWidget(
      async () => makeSessionProvider([]),
      undefined,
      undefined,
      () => [
        makeDrivenSnapshot({
          taskId: null,
          minskySessionId: null,
          cwd: "/Users/op/projects/minsky",
          harnessSessionId: "cccccccc-0000-0000-0000-000000000003",
        }),
      ]
    );
    const data = await widget.fetch({ id: "agents" });
    if (data.state !== "ok") throw new Error("expected ok");
    const agents = (data.payload as { agents: AgentRow[] }).agents;

    expect(agents.length).toBe(1);
    const row = agents[0];
    expect(row?.kind).toBe("driven-session");
    expect(row?.sessionId).toBe(DRIVEN_LOCAL_ID);
    expect(row?.title).toBe("Scratch: minsky");
    expect(row?.taskId).toBeNull();
    expect(row?.conversationId).toBe("cccccccc-0000-0000-0000-000000000003");
    expect(row?.driven?.status).toBe("running");
  });

  test("emits a standalone row when the bound workspace is not in view", () => {
    const rows: AgentRow[] = [];
    const result = spliceDrivenSessions(rows, [makeDrivenSnapshot()]);
    expect(result.length).toBe(1);
    expect(result[0]?.kind).toBe("driven-session");
    // Task binding is preserved on the standalone row.
    expect(result[0]?.taskId).toBe("mt#9999");
  });

  test("a throwing snapshot source degrades to no driven rows, not a widget error", async () => {
    const widget = createAgentsWidget(
      async () => makeSessionProvider([makeActiveSession()]),
      undefined,
      undefined,
      () => {
        throw new Error("registry unavailable");
      }
    );
    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const agents = (data.payload as { agents: AgentRow[] }).agents;
    expect(agents.length).toBe(1);
    expect(agents[0]?.driven).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// attachState wiring (mt#2286) — the 5th `getLiveAttachments` factory param.
// ---------------------------------------------------------------------------

function makeAttachment(overrides: Partial<SessionAttachment> = {}): SessionAttachment {
  return {
    id: overrides.id ?? "att-1",
    sessionId: overrides.sessionId ?? S1,
    actorId: overrides.actorId ?? "actor-1",
    terminalContext: overrides.terminalContext,
    registeredAt: overrides.registeredAt ?? NOW.toISOString(),
  };
}

describe("createAgentsWidget — attachState wiring", () => {
  test("attachState is null for every row when no getLiveAttachments factory is supplied", async () => {
    const widget = createAgentsWidget(async () =>
      makeSessionProvider([makeActiveSession({ sessionId: S1 })])
    );
    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const agents = (data.payload as { agents: AgentRow[] }).agents;
    expect(agents[0]?.attachState).toBeNull();
  });

  test("attachState is 'attached-external' when the row's live attachment carries terminalContext", async () => {
    const widget = createAgentsWidget(
      async () => makeSessionProvider([makeActiveSession({ sessionId: S1 })]),
      undefined,
      undefined,
      undefined,
      async () => [makeAttachment({ sessionId: S1, terminalContext: { TMUX_PANE: "%3" } })]
    );
    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const agents = (data.payload as { agents: AgentRow[] }).agents;
    expect(agents[0]?.attachState).toBe("attached-external");
  });

  test("attachState is 'in-cockpit' when the row's live attachment has no terminalContext", async () => {
    const widget = createAgentsWidget(
      async () => makeSessionProvider([makeActiveSession({ sessionId: S1 })]),
      undefined,
      undefined,
      undefined,
      async () => [makeAttachment({ sessionId: S1, terminalContext: {} })]
    );
    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const agents = (data.payload as { agents: AgentRow[] }).agents;
    expect(agents[0]?.attachState).toBe("in-cockpit");
  });

  test("attachState is 'detached' when no live attachment matches the row's sessionId", async () => {
    const widget = createAgentsWidget(
      async () => makeSessionProvider([makeActiveSession({ sessionId: S1 })]),
      undefined,
      undefined,
      undefined,
      async () => [makeAttachment({ sessionId: "some-other-session" })]
    );
    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const agents = (data.payload as { agents: AgentRow[] }).agents;
    expect(agents[0]?.attachState).toBe("detached");
  });

  test("a throwing getLiveAttachments degrades to attachState: null, not a widget error", async () => {
    const widget = createAgentsWidget(
      async () => makeSessionProvider([makeActiveSession({ sessionId: S1 })]),
      undefined,
      undefined,
      undefined,
      async () => {
        throw new Error("presence service unavailable");
      }
    );
    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const agents = (data.payload as { agents: AgentRow[] }).agents;
    expect(agents.length).toBe(1);
    expect(agents[0]?.attachState).toBeNull();
  });

  test("batches one attachment lookup across multiple rows and maps each independently", async () => {
    const calls: number[] = [];
    const widget = createAgentsWidget(
      async () =>
        makeSessionProvider([
          makeActiveSession({ sessionId: S1 }),
          makeActiveSession({ sessionId: S2 }),
          makeActiveSession({ sessionId: S3 }),
        ]),
      undefined,
      undefined,
      undefined,
      async () => {
        calls.push(1);
        return [
          makeAttachment({
            id: "a1",
            sessionId: S1,
            terminalContext: { TERM_PROGRAM: "iTerm.app" },
          }),
          makeAttachment({ id: "a2", sessionId: S2, terminalContext: {} }),
          // S3 has no attachment at all -> detached
        ];
      }
    );
    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const agents = (data.payload as { agents: AgentRow[] }).agents;
    expect(calls.length).toBe(1); // one batch call, not one per row

    const bySessionId = new Map(agents.map((a) => [a.sessionId, a]));
    expect(bySessionId.get(S1)?.attachState).toBe("attached-external");
    expect(bySessionId.get(S2)?.attachState).toBe("in-cockpit");
    expect(bySessionId.get(S3)?.attachState).toBe("detached");
  });
});

// ---------------------------------------------------------------------------
// Project-scope wiring (mt#2418)
//
// These tests prove the WIRING itself: the widget reads `ctx.query.project`,
// calls through the real resolveCockpitProjectScope codepath, and always
// supplies a `projectScope` key to listSessions() — without crashing —
// whether or not the query param is present. The end-to-end "slug filters to
// that project's rows" behavior is covered by
// `tests/domain/project-scope-acceptance.test.ts` (listSessions/listTasks
// projectScope filtering) and `src/cockpit/project-scope.test.ts` (slug->uuid
// resolution).
//
// mt#3016 — explicit `getProjectScopeDb` injection, not ambient "no live db":
// earlier versions of this block relied on `getContextInspectorDb()` (the
// REAL, module-level-cached singleton `resolveCockpitProjectScope` falls
// back to) resolving to `null` as an AMBIENT property of the test
// environment. That assumption is NOT guaranteed — `getContextInspectorDb`
// is shared across every test file in the same `bun test` process, and its
// result depends on whatever OTHER file happened to run first. Confirmed
// empirically: running `packages/domain/src/session-auto-task-creation.test.ts`
// (whose `beforeEach` calls the equally global, equally un-reset
// `@minsky/domain/configuration` `initializeConfiguration()` singleton, which
// still merges in the real user-level `~/.config/minsky/config.yaml`
// independent of the fake `workingDirectory` it passes) before this file in
// the same process made `getContextInspectorDb()` resolve a REAL, non-null
// Postgres connection, breaking the "no live db" assumption below. See
// `src/cockpit/widgets/task-list.test.ts`'s file-header docstring (mt#2418's
// sibling widget) for the full writeup — the fix is the same: inject
// `getProjectScopeDb` directly via `createAgentsWidget`'s 6th (mt#3016)
// parameter, so behavior is fully determined by THIS test file.
// ---------------------------------------------------------------------------

/**
 * Fake db shaped exactly as `scope-resolver.ts`'s query expects
 * (`select().from().where().limit()`), resolving to `rows` — mirrors
 * `src/cockpit/project-scope.test.ts`'s helper of the same name.
 */
function makeScopeResolverDb(rows: Array<{ id: string; slug: string }>): ScopeResolverDb {
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

describe("createAgentsWidget — project-scope wiring (mt#2418)", () => {
  test("supplies projectScope: ALL_PROJECTS to listSessions when ctx.query.project is absent", async () => {
    let capturedOptions: SessionListOptions | undefined;
    const provider: SessionProviderInterface = {
      ...makeSessionProvider([makeActiveSession({ sessionId: S1 })]),
      listSessions: async (options?: SessionListOptions) => {
        capturedOptions = options;
        return [makeActiveSession({ sessionId: S1 })];
      },
    };
    const widget = createAgentsWidget(async () => provider);

    const data = await widget.fetch({ id: "agents" });
    expect(data.state).toBe("ok");
    const projectScope = capturedOptions?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });

  test("does not crash when ctx.query.project is present (injected getProjectScopeDb: null -> fail-open to ALL_PROJECTS)", async () => {
    let capturedOptions: SessionListOptions | undefined;
    const provider: SessionProviderInterface = {
      ...makeSessionProvider([makeActiveSession({ sessionId: S1 })]),
      listSessions: async (options?: SessionListOptions) => {
        capturedOptions = options;
        return [makeActiveSession({ sessionId: S1 })];
      },
    };
    // mt#3016: explicit injection via the 6th (getProjectScopeDb) param, not
    // reliance on ambient "no live db" environment state — see the
    // describe-block header comment above.
    const widget = createAgentsWidget(
      async () => provider,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => null
    );

    const data = await widget.fetch({ id: "agents", query: { project: "edobry/minsky" } });
    expect(data.state).toBe("ok");
    const projectScope = capturedOptions?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });

  // mt#3016 regression guard: project-scope resolution must be driven
  // ENTIRELY by this test's own injected `getProjectScopeDb`, never by
  // whatever `@minsky/domain/configuration` / `getContextInspectorDb()`
  // global singleton state some OTHER test file left behind in this
  // process. Prove it with a fake db that DOES resolve a matching project
  // row — see task-list.test.ts's sibling test for the full rationale.
  test("resolves ctx.query.project to the injected fake db's matching project uuid", async () => {
    const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
    let capturedOptions: SessionListOptions | undefined;
    const provider: SessionProviderInterface = {
      ...makeSessionProvider([makeActiveSession({ sessionId: S1 })]),
      listSessions: async (options?: SessionListOptions) => {
        capturedOptions = options;
        return [makeActiveSession({ sessionId: S1 })];
      },
    };
    const widget = createAgentsWidget(
      async () => provider,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => makeScopeResolverDb([{ id: PROJECT_ID, slug: "edobry/minsky" }])
    );

    const data = await widget.fetch({ id: "agents", query: { project: "edobry/minsky" } });
    expect(data.state).toBe("ok");
    const projectScope = capturedOptions?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(projectScope).toBe(PROJECT_ID);
    expect(isAllProjects(projectScope)).toBe(false);
  });

  // PR #2056 R1 BLOCKING 1 / NON-BLOCKING 1: a thrown db-getter (module import
  // failure, connection error, etc.) must degrade project-scope resolution to
  // ALL_PROJECTS — NOT the whole widget to `state: "degraded"`. That contract
  // lives entirely inside resolveCockpitProjectScope() (see
  // src/cockpit/project-scope.ts's fail-open try/catch, which wraps the
  // db-getter call, the dynamic import, and the resolveProjectScope call all
  // in one boundary) — every consumer of it, including this widget, inherits
  // the guarantee for free. This widget DOES now carry a `getProjectScopeDb`
  // DI seam (added for mt#3016, above) but re-exercising the thrown-getter /
  // thrown-import / thrown-query paths here would be redundant — they're
  // already covered directly, with clean DI (no mock.module, banned by this
  // repo's own custom/no-global-module-mocks ESLint rule), in
  // src/cockpit/project-scope.test.ts.
});

// ---------------------------------------------------------------------------
// Activity-bound tests (mt#3118)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fixed clock for the pure-function tests. `isWithinActiveWindow` takes `now`
 * as a parameter precisely so these never read a real clock — a wall-clock
 * read would make the assertions time-of-day dependent (and trips
 * `custom/no-real-fs-in-tests`, which flags `Date.now()` in tests).
 */
const FIXED_NOW_MS = Date.parse("2026-07-23T12:00:00.000Z");

function agedSession(daysAgo: number, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const ts = new Date(FIXED_NOW_MS - daysAgo * DAY_MS).toISOString();
  return makeActiveSession({ createdAt: ts, lastActivityAt: ts, ...overrides });
}

describe("isWithinActiveWindow — the default activity bound", () => {
  test("keeps a workspace active within the window", () => {
    expect(isWithinActiveWindow(agedSession(3), FIXED_NOW_MS)).toBe(true);
  });

  test("drops a workspace quiet for longer than the window", () => {
    expect(isWithinActiveWindow(agedSession(40), FIXED_NOW_MS)).toBe(false);
  });

  test("an OPEN pull request extends the window past the base bound", () => {
    const withPr = agedSession(20, {
      pullRequest: { number: 1234, state: "open" },
    } as Partial<SessionRecord>);
    // 20 days is outside the 10-day base bound, inside the 30-day PR window.
    expect(isWithinActiveWindow(withPr, FIXED_NOW_MS)).toBe(true);
  });

  test("a DRAFT pull request extends the window the same way (in-flight work)", () => {
    const withDraft = agedSession(20, {
      pullRequest: { number: 1234, state: "draft" },
    } as Partial<SessionRecord>);
    expect(isWithinActiveWindow(withDraft, FIXED_NOW_MS)).toBe(true);
  });

  // The open-PR window EXTENDS the bound; it does not remove it. 35 of the 37
  // sessions cached as "open" have been inactive 30+ days with PR numbers as
  // low as #152 — a stale cache, not live review work.
  test("an open pull request does NOT grant an unbounded window", () => {
    const ancient = agedSession(200, {
      pullRequest: { number: 152, state: "open" },
    } as Partial<SessionRecord>);
    expect(isWithinActiveWindow(ancient, FIXED_NOW_MS)).toBe(false);
  });

  // Regression for the defect the live DB check caught: overriding on the mere
  // PRESENCE of a PR record left 55 of 225 workspaces in the "bounded" view,
  // oldest last active 2025-09-03 — sessions whose PR merged months ago but
  // whose row was never updated.
  test("a merged pull request grants no extension at all", () => {
    const merged = agedSession(20, {
      pullRequest: { number: 1234, state: "merged" },
    } as Partial<SessionRecord>);
    // Inside the 30-day PR window but outside the 10-day base bound: a merged
    // PR must not extend anything, so this is hidden.
    expect(isWithinActiveWindow(merged, FIXED_NOW_MS)).toBe(false);
  });

  test("a closed pull request grants no extension at all", () => {
    const closed = agedSession(20, {
      pullRequest: { number: 1234, state: "closed" },
    } as Partial<SessionRecord>);
    expect(isWithinActiveWindow(closed, FIXED_NOW_MS)).toBe(false);
  });

  test("keeps a row whose activity timestamp is unparseable (fail-open, never silently drop)", () => {
    const bad = makeActiveSession({ createdAt: "not-a-date", lastActivityAt: "not-a-date" });
    expect(isWithinActiveWindow(bad, FIXED_NOW_MS)).toBe(true);
  });

  test("falls back to createdAt when lastActivityAt is absent", () => {
    const old = new Date(FIXED_NOW_MS - 40 * DAY_MS).toISOString();
    const rec = makeActiveSession({ createdAt: old, lastActivityAt: undefined });
    expect(isWithinActiveWindow(rec, FIXED_NOW_MS)).toBe(false);
  });
});

describe("createAgentsWidget — activity bound applied to the row source (mt#3118)", () => {
  // These go through the widget's own real clock, so "recent" rides the
  // module-level NOW and "abandoned" is a fixed date far enough in the past to
  // stay outside the window no matter when the suite runs.
  const recent = makeActiveSession({ sessionId: S1 });
  const abandoned = makeActiveSession({
    sessionId: S2,
    createdAt: "2025-01-01T00:00:00.000Z",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
  });

  test("default view hides abandoned workspaces and reports how many were hidden", async () => {
    const widget = createAgentsWidget(
      async () => makeSessionProvider([recent, abandoned]),
      async () => makeTaskProvider({})
    );
    const result = await widget.fetch({ query: {} } as never);
    expect(result.state).toBe("ok");
    const payload = (result as { payload: { agents: AgentRow[]; hiddenInactiveCount: number } })
      .payload;
    expect(payload.agents.map((a) => a.sessionId)).toEqual([S1]);
    expect(payload.hiddenInactiveCount).toBe(1);
  });

  test("includeInactive=true restores the hidden rows", async () => {
    const widget = createAgentsWidget(
      async () => makeSessionProvider([recent, abandoned]),
      async () => makeTaskProvider({})
    );
    const result = await widget.fetch({ query: { includeInactive: "true" } } as never);
    const payload = (result as { payload: { agents: AgentRow[]; hiddenInactiveCount: number } })
      .payload;
    expect(payload.agents.map((a) => a.sessionId).sort()).toEqual([S1, S2].sort());
    expect(payload.hiddenInactiveCount).toBe(0);
  });
});
