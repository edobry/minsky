/**
 * Unit tests for the task-graph widget's project-scope wiring (mt#4727).
 *
 * Two-project fixture: two projects' tasks share ONE relationship set (as
 * `TaskGraphService.getAllRelationships` is not itself project-scoped — see
 * task-graph.ts's inline comment). These tests prove the double-duty claim
 * in that comment: scoping `taskService.listTasks({ projectScope })` alone
 * is sufficient to scope the rendered graph, because the existing
 * orphan-edge filter (`taskMap.has(...)` on both endpoints) drops any edge
 * that crosses into a task outside the resolved project.
 *
 * Follows the exact seam pattern established by `task-list.test.ts` (mt#3016
 * `getDb` injection, not ambient "no live db" reliance) — see that file's
 * header comment for the full rationale.
 */
import { describe, test, expect } from "bun:test";
import { createTaskGraphWidget, type TaskGraphDeps, type TaskGraphPayload } from "./task-graph";
import type { Task, TaskListOptions } from "@minsky/domain/tasks/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { TaskGraphService, TaskRelationship } from "@minsky/domain/tasks/task-graph-service";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import { isAllProjects } from "@minsky/domain/project/scope";

const PROJECT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_A_SLUG = "edobry/minsky";

// Two-project fixture: mt#1/mt#2 belong to project A, pz#1 to project B.
const TASK_A1: Task = { id: "mt#1", title: "A root", status: "DONE" };
const TASK_A2: Task = { id: "mt#2", title: "A leaf", status: "TODO" };
const TASK_B1: Task = { id: "pz#1", title: "B root", status: "TODO" };
const ALL_TASKS = [TASK_A1, TASK_A2, TASK_B1];

// Relationships span BOTH projects — getAllRelationships is not itself
// project-scoped (see task-graph.ts's comment), so a project-B-referencing
// edge is present here even when we resolve project A's scope below.
const ALL_RELATIONSHIPS: TaskRelationship[] = [
  { fromTaskId: "mt#2", toTaskId: "mt#1", type: "depends" }, // within project A
  { fromTaskId: "pz#1", toTaskId: "mt#1", type: "depends" }, // CROSSES into project A
];

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

function makeCapturingTaskService(
  onListTasks: (options?: TaskListOptions) => void
): TaskServiceInterface {
  return {
    listTasks: async (options?: TaskListOptions) => {
      onListTasks(options);
      const scope = options?.projectScope;
      if (scope === PROJECT_A_ID) return [TASK_A1, TASK_A2];
      if (scope === PROJECT_B_ID) return [TASK_B1];
      return ALL_TASKS;
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

function makeTaskGraphService(): TaskGraphService {
  return {
    getAllRelationships: async () => ALL_RELATIONSHIPS,
  } as unknown as TaskGraphService;
}

describe("createTaskGraphWidget — project-scope wiring (mt#4727)", () => {
  test("supplies projectScope: ALL_PROJECTS to listTasks when ctx.query.project is absent", async () => {
    let captured: TaskListOptions | undefined;
    const deps: TaskGraphDeps = {
      taskService: makeCapturingTaskService((o) => {
        captured = o;
      }),
      taskGraphService: makeTaskGraphService(),
    };
    const widget = createTaskGraphWidget(async () => deps);

    const data = await widget.fetch({ id: "task-graph" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const payload = data.payload as TaskGraphPayload;
    // ALL_PROJECTS: every task is a node, and both edges are kept.
    expect(payload.nodes.map((n) => n.id).sort()).toEqual(["mt#1", "mt#2", "pz#1"]);
    expect(payload.edges.length).toBe(2);
    const projectScope = captured?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });

  test("scoping to project A drops the cross-project edge via the orphan-edge filter", async () => {
    let captured: TaskListOptions | undefined;
    const deps: TaskGraphDeps = {
      taskService: makeCapturingTaskService((o) => {
        captured = o;
      }),
      taskGraphService: makeTaskGraphService(),
      getDb: async () => makeScopeResolverDb([{ id: PROJECT_A_ID, slug: PROJECT_A_SLUG }]),
    };
    const widget = createTaskGraphWidget(async () => deps);

    const data = await widget.fetch({ id: "task-graph", query: { project: PROJECT_A_SLUG } });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const payload = data.payload as TaskGraphPayload;

    // Only project A's two tasks are nodes.
    expect(payload.nodes.map((n) => n.id).sort()).toEqual(["mt#1", "mt#2"]);
    // The pz#1 -> mt#1 edge referenced a task outside the scoped project, so
    // it is filtered out by the SAME orphan-edge check that already dropped
    // typo'd/deleted-task edges pre-mt#4727 — only the within-project edge survives.
    expect(payload.edges).toEqual([{ id: "depends:mt#2->mt#1", source: "mt#2", target: "mt#1" }]);

    const projectScope = captured?.projectScope;
    expect(projectScope).toBe(PROJECT_A_ID);
  });

  test("does not crash when ctx.query.project is present but unresolvable (fail-open to ALL_PROJECTS)", async () => {
    let captured: TaskListOptions | undefined;
    const deps: TaskGraphDeps = {
      taskService: makeCapturingTaskService((o) => {
        captured = o;
      }),
      taskGraphService: makeTaskGraphService(),
      getDb: async () => null,
    };
    const widget = createTaskGraphWidget(async () => deps);

    const data = await widget.fetch({ id: "task-graph", query: { project: "unknown/repo" } });
    expect(data.state).toBe("ok");
    const projectScope = captured?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });
});
