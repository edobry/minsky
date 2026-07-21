/**
 * Unit tests for the task-list widget's project-scope wiring (mt#2418).
 *
 * These tests prove the WIRING itself: the widget reads `ctx.query.project`,
 * calls through the real resolveCockpitProjectScope codepath, and always
 * supplies a `projectScope` key to listTasks() — without crashing — whether
 * or not the query param is present. The end-to-end "slug filters to that
 * project's rows" behavior is covered by
 * `tests/domain/project-scope-acceptance.test.ts` (listTasks projectScope
 * filtering) and `src/cockpit/project-scope.test.ts` (slug->uuid resolution).
 *
 * ## mt#3016 — explicit `getDb` injection, not ambient "no live db"
 *
 * Earlier versions of this file relied on `getContextInspectorDb()` (the
 * REAL, module-level-cached singleton `resolveCockpitProjectScope` falls
 * back to) resolving to `null` as an AMBIENT property of the test
 * environment ("no live SQL persistence provider configured"). That
 * assumption is NOT guaranteed: `getContextInspectorDb` is shared across
 * every test file that lands in the same `bun test` process (sequential OR
 * sharded), and its result depends on whatever OTHER file happened to run
 * first. Confirmed empirically (mt#3016): running
 * `packages/domain/src/session-auto-task-creation.test.ts` — whose
 * `beforeEach` calls `@minsky/domain/configuration`'s
 * `initializeConfiguration()`, itself an equally global, equally un-reset
 * singleton — before this file in the same process made
 * `getContextInspectorDb()` resolve a REAL, non-null Postgres connection
 * (because `initializeConfiguration` still merges in the real user-level
 * `~/.config/minsky/config.yaml`, independent of the fake `workingDirectory`
 * override that test passes), which then let `resolveProjectScope` find the
 * real `edobry/minsky` project row and return its uuid instead of
 * `ALL_PROJECTS`. This is not a narrow "stale cache" bug fixable by
 * resetting `db-providers.ts`'s cache alone — a completely FRESH
 * `getContextInspectorDb()` call also resolves non-null once configuration
 * has been initialized anywhere in-process, and `initializeConfiguration()`
 * is called (without any reset) by 9+ other test files repo-wide.
 *
 * The fix: every test below that needs a specific project-scope outcome now
 * injects `getDb` directly via `TaskListDeps` (a test seam threaded through
 * to `resolveCockpitProjectScope`'s existing `options.getDb` — see
 * `project-scope.ts`), so behavior is fully determined by THIS test file,
 * never by cross-file process state.
 */
import { describe, test, expect } from "bun:test";
import { createTaskListWidget, type TaskListDeps, type TaskListPayload } from "./task-list";
import type { Task, TaskListOptions } from "@minsky/domain/tasks/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import { isAllProjects } from "@minsky/domain/project/scope";

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

  test("does not crash when ctx.query.project is present (injected getDb: null -> fail-open to ALL_PROJECTS)", async () => {
    let captured: TaskListOptions | undefined;
    const deps: TaskListDeps = {
      taskService: makeCapturingTaskService([TASK], (o) => {
        captured = o;
      }),
      // mt#3016: explicit injection, not reliance on ambient "no live db"
      // environment state — see the file-header docstring.
      getDb: async () => null,
    };
    const widget = createTaskListWidget(async () => deps);

    const data = await widget.fetch({ id: "task-list", query: { project: "edobry/minsky" } });
    expect(data.state).toBe("ok");
    const projectScope = captured?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(isAllProjects(projectScope)).toBe(true);
  });

  // mt#3016 regression guard: project-scope resolution must be driven
  // ENTIRELY by this test's own injected `getDb`, never by whatever
  // `@minsky/domain/configuration` / `getContextInspectorDb()` global
  // singleton state some OTHER test file left behind in this process. Prove
  // it by injecting a fake db that DOES resolve a matching project row —
  // if the widget were still reaching past the injected seam to some
  // ambient real getter, this would either throw (a real drizzle query
  // against a mismatched fake) or silently ignore the injected fake row.
  test("resolves ctx.query.project to the injected fake db's matching project uuid", async () => {
    const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
    let captured: TaskListOptions | undefined;
    const deps: TaskListDeps = {
      taskService: makeCapturingTaskService([TASK], (o) => {
        captured = o;
      }),
      getDb: async () => makeScopeResolverDb([{ id: PROJECT_ID, slug: "edobry/minsky" }]),
    };
    const widget = createTaskListWidget(async () => deps);

    const data = await widget.fetch({ id: "task-list", query: { project: "edobry/minsky" } });
    expect(data.state).toBe("ok");
    const projectScope = captured?.projectScope;
    if (!projectScope) throw new Error("expected projectScope to be set");
    expect(projectScope).toBe(PROJECT_ID);
    expect(isAllProjects(projectScope)).toBe(false);
  });

  // PR #2056 R1 BLOCKING 2 / NON-BLOCKING 2: a thrown db-getter (module import
  // failure, connection error, etc.) must degrade project-scope resolution to
  // ALL_PROJECTS — NOT the whole widget to `state: "degraded"`. That contract
  // lives entirely inside resolveCockpitProjectScope() (see
  // src/cockpit/project-scope.ts's fail-open try/catch, which wraps the
  // db-getter call, the dynamic import, and the resolveProjectScope call all
  // in one boundary) — every consumer of it, including this widget, inherits
  // the guarantee for free. This widget DOES now carry a `getDb` DI seam
  // (added for mt#3016, above) but re-exercising the thrown-getter /
  // thrown-import / thrown-query paths here would be redundant — they're
  // already covered directly, with clean DI (no mock.module, banned by this
  // repo's own custom/no-global-module-mocks ESLint rule), in
  // src/cockpit/project-scope.test.ts.
});
