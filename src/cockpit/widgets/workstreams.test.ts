/**
 * Unit tests for the workstreams widget's project-scope wiring (mt#4727).
 *
 * Two-project fixture: two projects' parent/child task pairs share ONE
 * `parent` relationship set (`TaskGraphService.getAllRelationships` is not
 * itself project-scoped — see workstreams.ts's inline comment). These tests
 * prove that scoping `taskService.listTasks({ projectScope })` alone is
 * sufficient to scope the rendered workstream cards: the existing
 * orphan-edge filter (`taskMap.has(...)` on both parent and child ids) drops
 * any parent-relationship edge referencing a task outside the resolved
 * project — same double-duty as task-graph.ts.
 *
 * Follows the exact seam pattern established by `task-list.test.ts` (mt#3016
 * `getDb` injection).
 */
import { describe, test, expect } from "bun:test";
import {
  createWorkstreamsWidget,
  type WorkstreamsDeps,
  type WorkstreamsPayload,
} from "./workstreams";
import type { Task, TaskListOptions } from "@minsky/domain/tasks/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { TaskGraphService, TaskRelationship } from "@minsky/domain/tasks/task-graph-service";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import { isAllProjects } from "@minsky/domain/project/scope";

const PROJECT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_A_SLUG = "edobry/minsky";

// Two-project fixture: mt#1 (parent, DONE) / mt#2 (child, IN-PROGRESS) belong
// to project A; pz#1 (parent) / pz#2 (child) belong to project B.
const PARENT_A: Task = { id: "mt#1", title: "A parent", status: "DONE" };
const CHILD_A: Task = { id: "mt#2", title: "A child", status: "IN-PROGRESS" };
const PARENT_B: Task = { id: "pz#1", title: "B parent", status: "DONE" };
const CHILD_B: Task = { id: "pz#2", title: "B child", status: "IN-PROGRESS" };
const ALL_TASKS = [PARENT_A, CHILD_A, PARENT_B, CHILD_B];

// parent relationships: fromTaskId = child, toTaskId = parent. Spans both
// projects — getAllRelationships is not itself project-scoped.
const ALL_PARENT_RELATIONSHIPS: TaskRelationship[] = [
  { fromTaskId: "mt#2", toTaskId: "mt#1", type: "parent" },
  { fromTaskId: "pz#2", toTaskId: "pz#1", type: "parent" },
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
      if (scope === PROJECT_A_ID) return [PARENT_A, CHILD_A];
      if (scope === PROJECT_B_ID) return [PARENT_B, CHILD_B];
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
    getAllRelationships: async () => ALL_PARENT_RELATIONSHIPS,
  } as unknown as TaskGraphService;
}

describe("createWorkstreamsWidget — project-scope wiring (mt#4727)", () => {
  test("supplies projectScope: ALL_PROJECTS and renders both workstreams when ctx.query.project is absent", async () => {
    let captured: TaskListOptions | undefined;
    const deps: WorkstreamsDeps = {
      taskService: makeCapturingTaskService((o) => {
        captured = o;
      }),
      taskGraphService: makeTaskGraphService(),
    };
    const widget = createWorkstreamsWidget(async () => deps);

    const data = await widget.fetch({ id: "workstreams" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const payload = data.payload as WorkstreamsPayload;
    expect(payload.workstreams.map((w) => w.parentId).sort()).toEqual(["mt#1", "pz#1"]);

    const projectScope = captured?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });

  test("scoping to project A renders only project A's workstream (cross-project edge dropped)", async () => {
    let captured: TaskListOptions | undefined;
    const deps: WorkstreamsDeps = {
      taskService: makeCapturingTaskService((o) => {
        captured = o;
      }),
      taskGraphService: makeTaskGraphService(),
      getDb: async () => makeScopeResolverDb([{ id: PROJECT_A_ID, slug: PROJECT_A_SLUG }]),
    };
    const widget = createWorkstreamsWidget(async () => deps);

    const data = await widget.fetch({ id: "workstreams", query: { project: PROJECT_A_SLUG } });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    const payload = data.payload as WorkstreamsPayload;

    // Only project A's parent renders — project B's parent/child pair is
    // scoped out of `taskMap`, so its `parent` edge is dropped by the
    // pre-existing orphan-edge filter and never becomes a workstream card.
    expect(payload.workstreams.map((w) => w.parentId)).toEqual(["mt#1"]);
    expect(payload.workstreams[0]?.children.map((c) => c.id)).toEqual(["mt#2"]);

    const projectScope = captured?.projectScope;
    expect(projectScope).toBe(PROJECT_A_ID);
  });

  test("does not crash when ctx.query.project is present but unresolvable (fail-open to ALL_PROJECTS)", async () => {
    let captured: TaskListOptions | undefined;
    const deps: WorkstreamsDeps = {
      taskService: makeCapturingTaskService((o) => {
        captured = o;
      }),
      taskGraphService: makeTaskGraphService(),
      getDb: async () => null,
    };
    const widget = createWorkstreamsWidget(async () => deps);

    const data = await widget.fetch({
      id: "workstreams",
      query: { project: "unknown/repo" },
    });
    expect(data.state).toBe("ok");
    const projectScope = captured?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });
});
