/**
 * Regression test for mt#2783: exercises `listTasksFromParams` via the EXACT
 * import path the live CLI/MCP `tasks.list` command uses —
 * `crud-commands.ts`'s `await import("@minsky/domain/tasks")` — not the
 * `taskCommands.ts` barrel that historically carried the bulk of the existing
 * test coverage (`packages/domain/src/tasks/taskCommands.test.ts`).
 *
 * Before mt#2783, `packages/domain/src/tasks.ts` and
 * `packages/domain/src/tasks/commands/query-commands.ts` held independent
 * `listTasksFromParams` implementations. A fix applied only to the
 * barrel-tested copy (`query-commands.ts`) had zero effect on this path — the
 * one the CLI/MCP actually calls — as happened in mt#2762 (the `kind` filter
 * had no effect via `bun src/cli.ts tasks list --kind umbrella` despite full
 * test coverage on the other copy). Post-consolidation, `tasks.ts`'s
 * `listTasksFromParams` delegates to `query-commands.ts`'s implementation, so
 * this test doubles as a regression guard against the two diverging again:
 * if `tasks.ts` ever stops delegating (or `query-commands.ts` stops
 * forwarding a filter), this test — which imports from the same specifier
 * the production command uses — fails.
 */
import { describe, test, expect, mock } from "bun:test";
import { listTasksFromParams } from "@minsky/domain/tasks";
import { ALL_PROJECTS } from "@minsky/domain/project/scope";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { Task } from "@minsky/domain/tasks/types";

function makeStubTaskService(
  listTasksMock: (options?: unknown) => Promise<Task[]>
): TaskServiceInterface {
  return {
    listTasks: listTasksMock,
    getTask: async () => null,
    getTaskStatus: async () => undefined,
    setTaskStatus: async () => ({ recordsAffected: 1 }),
    createTaskFromTitleAndSpec: async () =>
      ({ id: "#test", title: "Test", status: "TODO" }) as unknown as Task,
    deleteTask: async () => false,
    getWorkspacePath: () => "/test/path",
    getTaskSpecContent: async () => ({ task: {} as Task, specPath: "", content: "" }),
  } as unknown as TaskServiceInterface;
}

describe("listTasksFromParams via @minsky/domain/tasks (mt#2783 — the live CLI/MCP import path)", () => {
  test("forwards status/kind/tags filters to taskService.listTasks (server-side)", async () => {
    const listTasksMock = mock(() => Promise.resolve([] as Task[]));
    const taskService = makeStubTaskService(listTasksMock);

    await listTasksFromParams(
      {
        status: "TODO",
        kind: "umbrella",
        tags: ["di-cleanup"],
        all: true,
        allProjects: true,
        json: false,
      },
      { taskService }
    );

    expect(listTasksMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "TODO",
        kind: "umbrella",
        tags: ["di-cleanup"],
        all: true,
      })
    );
  });

  test("allProjects: true resolves projectScope to ALL_PROJECTS (skips scope filter)", async () => {
    const listTasksMock = mock(() => Promise.resolve([] as Task[]));
    const taskService = makeStubTaskService(listTasksMock);

    await listTasksFromParams({ all: true, allProjects: true, json: false }, { taskService });

    expect(listTasksMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectScope: ALL_PROJECTS })
    );
  });

  test("no persistenceProvider injected defaults projectScope to ALL_PROJECTS without throwing", async () => {
    const listTasksMock = mock(() => Promise.resolve([] as Task[]));
    const taskService = makeStubTaskService(listTasksMock);

    // No persistenceProvider in deps — ADR-021 resolution requires
    // `getDatabaseConnection`, which is unavailable without one, so this must
    // fall back to ALL_PROJECTS rather than throw (mirrors CLI/MCP callers
    // that don't have a SQL-capable provider on hand, e.g. non-minsky backends).
    await listTasksFromParams({ all: true, json: false }, { taskService });

    expect(listTasksMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectScope: ALL_PROJECTS })
    );
  });

  test("an unknown kind is rejected with a ValidationError before the query runs", async () => {
    const { ValidationError } = await import("@minsky/domain/errors");
    const listTasksMock = mock(() => Promise.resolve([] as Task[]));
    const taskService = makeStubTaskService(listTasksMock);

    await expect(
      listTasksFromParams({ all: true, kind: "not-a-real-kind", json: false }, { taskService })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(listTasksMock).not.toHaveBeenCalled();
  });
});
