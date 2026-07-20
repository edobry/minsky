/**
 * Unit tests for the task-list widget's project-scope wiring (mt#2418).
 *
 * `getContextInspectorDb()` resolves to null in this unit-test environment
 * (no live SQL persistence provider configured), so `resolveCockpitProjectScope`
 * fails open to ALL_PROJECTS regardless of `ctx.query.project` — the
 * end-to-end "slug filters to that project's rows" behavior is covered by
 * `tests/domain/project-scope-acceptance.test.ts` (listTasks projectScope
 * filtering) and `src/cockpit/project-scope.test.ts` (slug->uuid resolution).
 * These tests instead prove the WIRING itself: the widget reads
 * `ctx.query.project`, calls through the real resolveCockpitProjectScope
 * codepath, and always supplies a `projectScope` key to listTasks() —
 * without crashing — whether or not the query param is present.
 */
import { describe, test, expect } from "bun:test";
import { createTaskListWidget, type TaskListDeps, type TaskListPayload } from "./task-list";
import type { Task, TaskListOptions } from "@minsky/domain/tasks/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import { isAllProjects } from "@minsky/domain/project/scope";

function makeCapturingTaskService(
  tasks: Task[],
  onListTasks: (options?: TaskListOptions) => void
): TaskServiceInterface {
  return {
    listTasks: async (options?: TaskListOptions) => {
      onListTasks(options);
      return tasks;
    },
    getTask: async () => null,
    getTaskStatus: async () => undefined,
    setTaskStatus: async () => {},
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

const TASK: Task = { id: "mt#1", title: "Task one", status: "TODO", kind: "implementation" };

describe("createTaskListWidget — project-scope wiring (mt#2418)", () => {
  test("supplies projectScope: ALL_PROJECTS to listTasks when ctx.query.project is absent", async () => {
    let captured: TaskListOptions | undefined;
    const deps: TaskListDeps = {
      taskService: makeCapturingTaskService([TASK], (o) => {
        captured = o;
      }),
    };
    const widget = createTaskListWidget(async () => deps);

    const data = await widget.fetch({ id: "task-list" });
    expect(data.state).toBe("ok");
    if (data.state !== "ok") throw new Error("expected ok");
    expect((data.payload as TaskListPayload).tasks.length).toBe(1);
    const projectScope = captured?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });

  test("does not crash when ctx.query.project is present (no live db -> fail-open to ALL_PROJECTS)", async () => {
    let captured: TaskListOptions | undefined;
    const deps: TaskListDeps = {
      taskService: makeCapturingTaskService([TASK], (o) => {
        captured = o;
      }),
    };
    const widget = createTaskListWidget(async () => deps);

    const data = await widget.fetch({ id: "task-list", query: { project: "edobry/minsky" } });
    expect(data.state).toBe("ok");
    const projectScope = captured?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });

  // PR #2056 R1 BLOCKING 2 / NON-BLOCKING 2: a thrown db-getter (module import
  // failure, connection error, etc.) must degrade project-scope resolution to
  // ALL_PROJECTS — NOT the whole widget to `state: "degraded"`. That contract
  // now lives entirely inside resolveCockpitProjectScope() (see
  // src/cockpit/project-scope.ts's fail-open try/catch, which wraps the
  // db-getter call, the dynamic import, and the resolveProjectScope call all
  // in one boundary) — every consumer of it, including this widget, inherits
  // the guarantee for free and cannot be individually tested around a thrown
  // getter without either (a) mock.module() on the sibling db-providers
  // module — banned by this repo's own custom/no-global-module-mocks ESLint
  // rule (dependency injection is the mandated alternative), or (b) adding a
  // redundant DI seam to this widget purely to re-exercise a contract already
  // exhaustively covered at its source. The thrown-getter / thrown-import /
  // thrown-query exception paths are covered directly, with clean DI (no
  // mock.module), in src/cockpit/project-scope.test.ts.
});
