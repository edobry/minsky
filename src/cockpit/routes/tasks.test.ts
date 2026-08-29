/**
 * Tests for the pure query-parsing helper backing GET /api/tasks/meta
 * (mt#3174). The route itself calls `getServerTaskService()` directly (no DI
 * seam, matching the existing untested-at-this-layer convention for
 * /api/tasks/ids and /api/tasks/:id in this file — no routes/tasks.test.ts
 * predates this one) and `mock.module` is banned in this codebase (see
 * `shared-persistence.test.ts`, `events-broker-init.test.ts`), so the
 * ids-parsing logic is extracted into a pure, directly-testable function
 * instead. Data-layer correctness (the actual label resolution) is covered
 * by `../task-title-cache.test.ts`'s `getTaskMeta` suite.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "http";
import express from "express";
import {
  collectReferencedTaskIds,
  parseTaskMetaIds,
  selectLiveDrivenSession,
  mountTaskRoutes,
} from "./tasks";
import type { Task, TaskListOptions } from "@minsky/domain/tasks/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";

describe("collectReferencedTaskIds", () => {
  const ok = <T>(value: T): PromiseSettledResult<T> => ({ status: "fulfilled", value });
  const failed = <T>(): PromiseSettledResult<T> => ({
    status: "rejected",
    reason: new Error("graph read failed"),
  });
  const none = ok<readonly string[] | undefined>(undefined);

  test("collects parent, children, outgoing and incoming ids", () => {
    expect(collectReferencedTaskIds(ok("mt#1"), ok(["mt#2"]), ok(["mt#3"]), ok(["mt#4"]))).toEqual([
      "mt#1",
      "mt#2",
      "mt#3",
      "mt#4",
    ]);
  });

  test("deduplicates an id reachable by more than one edge", () => {
    // A task can be both a dependency and a child; the batch fetch must not
    // request it twice.
    expect(collectReferencedTaskIds(ok("mt#1"), ok(["mt#1", "mt#2"]), ok(["mt#2"]), none)).toEqual([
      "mt#1",
      "mt#2",
    ]);
  });

  test("returns an empty list for a task with no neighbors", () => {
    expect(collectReferencedTaskIds(ok(null), none, none, none)).toEqual([]);
  });

  test("skips a rejected edge instead of failing the whole collection", () => {
    // One graph read failing must degrade that edge to "no neighbors" — the
    // detail page still renders, minus that section.
    expect(collectReferencedTaskIds(failed(), ok(["mt#2"]), failed(), ok(["mt#4"]))).toEqual([
      "mt#2",
      "mt#4",
    ]);
  });

  test("treats a null or undefined parent as absent", () => {
    expect(collectReferencedTaskIds(ok(undefined), ok(["mt#2"]), none, none)).toEqual(["mt#2"]);
    expect(collectReferencedTaskIds(ok(null), ok(["mt#2"]), none, none)).toEqual(["mt#2"]);
  });
});

describe("parseTaskMetaIds", () => {
  test("splits a comma-separated ids param", () => {
    expect(parseTaskMetaIds("mt%231,mt%232")).toEqual(["mt#1", "mt#2"]);
  });

  test("trims whitespace around segments", () => {
    expect(parseTaskMetaIds("mt%231, mt%232 ")).toEqual(["mt#1", "mt#2"]);
  });

  test("drops empty segments (trailing/leading/double commas)", () => {
    expect(parseTaskMetaIds(",mt%231,,mt%232,")).toEqual(["mt#1", "mt#2"]);
  });

  test("a single id with no comma", () => {
    expect(parseTaskMetaIds("mt%231")).toEqual(["mt#1"]);
  });

  test("missing param → empty array", () => {
    expect(parseTaskMetaIds(undefined)).toEqual([]);
  });

  test("empty string param → empty array", () => {
    expect(parseTaskMetaIds("")).toEqual([]);
  });

  test("non-string param (e.g. an array, from a malformed request) → empty array", () => {
    expect(parseTaskMetaIds(["mt#1", "mt#2"])).toEqual([]);
  });

  test("malformed percent-encoding in a segment degrades that segment to dropped, not a thrown error", () => {
    expect(parseTaskMetaIds("mt%231,%E0%A4%A")).toEqual(["mt#1"]);
  });
});

/**
 * mt#3400 — the rules deciding whether a task page offers a one-hop return to
 * a live driven session.
 *
 * Stand-in collaborators keep these tests about the RULES: `normalize` models
 * the display-form canonicalization the route passes `formatTaskIdForDisplay`
 * for, and `isTerminal` mirrors `isTerminalStatus`'s real membership
 * (exited/crashed/unrecoverable) rather than re-importing the host module.
 */
describe("selectLiveDrivenSession (mt#3400)", () => {
  type Rec = {
    localId: string;
    taskId: string | null;
    status: "spawned" | "running" | "reconnecting" | "exited" | "crashed" | "unrecoverable";
    startedAt: string;
  };

  const normalize = (id: string) =>
    id
      .trim()
      .toLowerCase()
      .replace(/^task#/, "mt#");
  const isTerminal = (s: Rec["status"]) =>
    s === "exited" || s === "crashed" || s === "unrecoverable";

  const rec = (over: Partial<Rec> & Pick<Rec, "localId">): Rec => ({
    taskId: "mt#3400",
    status: "running",
    startedAt: "2026-07-30T10:00:00.000Z",
    ...over,
  });

  test("returns the live session bound to the task", () => {
    const found = selectLiveDrivenSession(
      [rec({ localId: "ds-1" })],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found?.localId).toBe("ds-1");
  });

  test("no records → null", () => {
    expect(selectLiveDrivenSession([], "mt#3400", normalize, isTerminal)).toBeNull();
  });

  test("a session bound to a DIFFERENT task is never returned", () => {
    const found = selectLiveDrivenSession(
      [rec({ localId: "ds-other", taskId: "mt#9999" })],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found).toBeNull();
  });

  test("an untasked scratch session (null taskId) is never returned", () => {
    const found = selectLiveDrivenSession(
      [rec({ localId: "ds-scratch", taskId: null })],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found).toBeNull();
  });

  test.each([["exited"], ["crashed"], ["unrecoverable"]] as const)(
    "a %s session never hijacks the action",
    (status) => {
      const found = selectLiveDrivenSession(
        [rec({ localId: "ds-done", status })],
        "mt#3400",
        normalize,
        isTerminal
      );
      expect(found).toBeNull();
    }
  );

  // The originating incident's exact state: the daemon restarted, so the record
  // was rebuilt as a "reconnecting" placeholder. It IS reachable — attaching
  // resumes it — so excluding it would reintroduce the reported bug.
  test.each([["spawned"], ["running"], ["reconnecting"]] as const)(
    "a %s session qualifies as returnable",
    (status) => {
      const found = selectLiveDrivenSession(
        [rec({ localId: "ds-live", status })],
        "mt#3400",
        normalize,
        isTerminal
      );
      expect(found?.localId).toBe("ds-live");
    }
  );

  test("ids are compared through normalize, so a display-form difference still matches", () => {
    const found = selectLiveDrivenSession(
      [rec({ localId: "ds-1", taskId: "TASK#3400" })],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found?.localId).toBe("ds-1");
  });

  test("newest-started wins when a task has been driven more than once", () => {
    const found = selectLiveDrivenSession(
      [
        rec({ localId: "ds-old", startedAt: "2026-07-30T09:00:00.000Z" }),
        rec({ localId: "ds-new", startedAt: "2026-07-30T18:00:00.000Z" }),
        rec({ localId: "ds-mid", startedAt: "2026-07-30T12:00:00.000Z" }),
      ],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found?.localId).toBe("ds-new");
  });

  test("a newer TERMINAL session does not shadow an older live one", () => {
    const found = selectLiveDrivenSession(
      [
        rec({ localId: "ds-live", startedAt: "2026-07-30T09:00:00.000Z" }),
        rec({ localId: "ds-dead", status: "exited", startedAt: "2026-07-30T18:00:00.000Z" }),
      ],
      "mt#3400",
      normalize,
      isTerminal
    );
    expect(found?.localId).toBe("ds-live");
  });

  // PR #2448 R1 — the comparator must be total. Cast at the call site because
  // the malformed shapes below are exactly what the type system forbids and a
  // non-TS caller could still hand over.
  test("a record with a missing startedAt sorts last instead of throwing", () => {
    const malformed = [
      { localId: "ds-nostart", taskId: "mt#3400", status: "running" },
      rec({ localId: "ds-ok", startedAt: "2026-07-30T09:00:00.000Z" }),
    ] as unknown as Rec[];
    const found = selectLiveDrivenSession(malformed, "mt#3400", normalize, isTerminal);
    expect(found?.localId).toBe("ds-ok");
  });

  test("a non-string startedAt sorts last instead of throwing", () => {
    const malformed = [
      { localId: "ds-numeric", taskId: "mt#3400", status: "running", startedAt: 12345 },
      rec({ localId: "ds-ok", startedAt: "2026-07-30T09:00:00.000Z" }),
    ] as unknown as Rec[];
    const found = selectLiveDrivenSession(malformed, "mt#3400", normalize, isTerminal);
    expect(found?.localId).toBe("ds-ok");
  });

  test("an all-malformed candidate set still returns a record rather than throwing", () => {
    const malformed = [
      { localId: "ds-a", taskId: "mt#3400", status: "running" },
      { localId: "ds-b", taskId: "mt#3400", status: "running" },
    ] as unknown as Rec[];
    const found = selectLiveDrivenSession(malformed, "mt#3400", normalize, isTerminal);
    expect(found).not.toBeNull();
  });

  test("does not mutate the caller's array (the registry's own list)", () => {
    const records = [
      rec({ localId: "ds-old", startedAt: "2026-07-30T09:00:00.000Z" }),
      rec({ localId: "ds-new", startedAt: "2026-07-30T18:00:00.000Z" }),
    ];
    selectLiveDrivenSession(records, "mt#3400", normalize, isTerminal);
    expect(records.map((r) => r.localId)).toEqual(["ds-old", "ds-new"]);
  });
});

/**
 * GET /api/tasks and GET /api/tasks/ids project-scope wiring (mt#4727).
 *
 * Two-project fixture: two distinct in-memory task lists, one per project
 * uuid. The fake `TaskServiceInterface` returns whichever list matches the
 * resolved `projectScope` (or the concatenation for ALL_PROJECTS), so a real
 * end-to-end HTTP request against `?project=<slug>` proves BOTH halves of
 * the wiring: the route resolves the slug to the right uuid via the injected
 * `getProjectScopeDb` fake, and passes that uuid through to `listTasks()`.
 */
describe("GET /api/tasks & /api/tasks/ids — project-scope wiring (mt#4727)", () => {
  const PROJECT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROJECT_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PROJECT_A_SLUG = "edobry/minsky";
  const PROJECT_B_SLUG = "edobry/peezombie.me";

  const TASK_A: Task = { id: "mt#1", title: "Project A task", status: "TODO" };
  const TASK_B: Task = { id: "pz#1", title: "Project B task", status: "TODO" };

  /** Fake task service partitioned by project id — the two-project fixture. */
  function makeTwoProjectTaskService(): TaskServiceInterface {
    return {
      listTasks: async (options?: TaskListOptions) => {
        const scope = options?.projectScope;
        if (scope === PROJECT_A_ID) return [TASK_A];
        if (scope === PROJECT_B_ID) return [TASK_B];
        // ALL_PROJECTS (or any other sentinel/omitted value): every project's rows.
        return [TASK_A, TASK_B];
      },
      getTask: async () => null,
      getTaskStatus: async () => undefined,
      setTaskStatus: async () => ({ recordsAffected: 1 }),
      createTaskFromTitleAndSpec: async () => {
        throw new Error("not implemented in fake");
      },
      deleteTask: async () => false,
      getTasks: async () => [],
      getTaskSpecContent: async () => {
        throw new Error("not implemented in fake");
      },
      getWorkspacePath: () => "/fake/workspace",
    };
  }

  /**
   * Fake scope-resolver db resolving exactly the given slug->uuid rows.
   * `resolveProjectScope` builds its own drizzle WHERE predicate internally
   * (`eq(projectsTable.slug, slug)`) and always reads `rows[0]` — this fake
   * cannot see which slug the predicate encodes, so (mirroring
   * `task-list.test.ts`'s `makeScopeResolverDb`) each call site supplies
   * only the row(s) relevant to what it's testing, keeping `rows[0]`
   * unambiguous.
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

  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
  });

  async function makeHarness(scopeDbRows: Array<{ id: string; slug: string }>): Promise<{
    url: string;
  }> {
    const app = express();
    mountTaskRoutes(app, {
      taskServiceOverride: makeTwoProjectTaskService(),
      getProjectScopeDb: async () => makeScopeResolverDb(scopeDbRows),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no ephemeral port");
    return { url: `http://127.0.0.1:${address.port}` };
  }

  test("GET /api/tasks with no ?project= returns every project's tasks (ALL_PROJECTS default)", async () => {
    const { url } = await makeHarness([]);
    const res = await fetch(`${url}/api/tasks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string }[] };
    expect(body.tasks.map((t) => t.id).sort()).toEqual(["mt#1", "pz#1"]);
  });

  test("GET /api/tasks?project=<project A slug> returns only project A's tasks", async () => {
    const { url } = await makeHarness([{ id: PROJECT_A_ID, slug: PROJECT_A_SLUG }]);
    const res = await fetch(`${url}/api/tasks?project=${encodeURIComponent(PROJECT_A_SLUG)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string }[] };
    expect(body.tasks.map((t) => t.id)).toEqual(["mt#1"]);
  });

  test("GET /api/tasks?project=<project B slug> returns only project B's tasks", async () => {
    const { url } = await makeHarness([{ id: PROJECT_B_ID, slug: PROJECT_B_SLUG }]);
    const res = await fetch(`${url}/api/tasks?project=${encodeURIComponent(PROJECT_B_SLUG)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string }[] };
    expect(body.tasks.map((t) => t.id)).toEqual(["pz#1"]);
  });

  test("GET /api/tasks/ids?project=<project A slug> returns only project A's ids", async () => {
    const { url } = await makeHarness([{ id: PROJECT_A_ID, slug: PROJECT_A_SLUG }]);
    const res = await fetch(`${url}/api/tasks/ids?project=${encodeURIComponent(PROJECT_A_SLUG)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ids: string[] };
    expect(body.ids).toEqual(["mt#1"]);
  });

  test("GET /api/tasks/ids with no ?project= returns every project's ids", async () => {
    const { url } = await makeHarness([]);
    const res = await fetch(`${url}/api/tasks/ids`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ids: string[] };
    expect(body.ids.sort()).toEqual(["mt#1", "pz#1"]);
  });

  test("GET /api/tasks?project=all falls back to ALL_PROJECTS (explicit sentinel)", async () => {
    const { url } = await makeHarness([]);
    const res = await fetch(`${url}/api/tasks?project=all`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string }[] };
    expect(body.tasks.map((t) => t.id).sort()).toEqual(["mt#1", "pz#1"]);
  });
});
