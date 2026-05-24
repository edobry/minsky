/**
 * Unit tests for the agents widget task-title enrichment (mt#1888).
 *
 * These tests focus on the server-side AgentRow.taskTitle population logic in
 * createAgentsWidget(). Widget integration tests (HTTP round-trip, filtering,
 * title-from-branch fallback) live in src/cockpit/cockpit.test.ts.
 */
import { describe, test, expect } from "bun:test";
import { createAgentsWidget } from "./agents";
import type { TaskProviderLike, AgentRow } from "./agents";
import type { SessionProviderInterface, SessionRecord } from "../../domain/session/types";
import { SessionStatus } from "../../domain/session/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionProvider(records: SessionRecord[]): SessionProviderInterface {
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
});
