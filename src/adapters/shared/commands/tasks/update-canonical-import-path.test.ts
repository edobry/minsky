/**
 * Regression test for mt#3190: exercises `updateTaskFromParams` via the EXACT
 * import path the live MCP `tasks.spec.patch` / `tasks.spec.search_replace`
 * tools use — `src/adapters/mcp/task-edit-tools.ts`'s
 * `import("@minsky/domain/tasks")` — not the `taskCommands.ts` barrel.
 *
 * This is the Success Criterion 4 regression guard. Before mt#3190,
 * `packages/domain/src/tasks.ts`'s `updateTaskFromParams` applied BOTH
 * `params.title` and `params.spec`, while `tasks/commands/mutation-commands.ts`'s
 * copy (the one the `taskCommands.ts` barrel exposed) applied ONLY
 * `params.title` and silently dropped `params.spec` — the opposite-direction
 * instance of the "diverging copies" bug class mt#3194 fixed for
 * `getTaskSpecContentFromParams`. Consolidating to the wrong direction here
 * would have made the live MCP `tasks.spec.patch` / `tasks.spec.search_replace`
 * tools silently no-op (both call `updateTaskFromParams` with `spec` set on
 * every invocation). See `tests/adapters/mcp/task-edit-tools.test.ts` for the
 * end-to-end tool-level coverage of the same fix.
 */
import { describe, test, expect, mock } from "bun:test";
import { updateTaskFromParams } from "@minsky/domain/tasks";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { Task } from "@minsky/domain/tasks/types";

const STUB_TASK = { id: "mt#123", title: "Old title", status: "TODO" } as unknown as Task;

function makeStubTaskService(
  updateTaskMock: (taskId: string, updates: Partial<Task>) => Promise<Task>
) {
  return {
    listTasks: async () => [],
    getTask: async () => STUB_TASK,
    getTaskStatus: async () => undefined,
    setTaskStatus: async () => ({ recordsAffected: 1 }),
    createTaskFromTitleAndSpec: async () => STUB_TASK,
    deleteTask: async () => false,
    getWorkspacePath: () => "/test/path",
    getTaskSpecContent: async () => ({ task: STUB_TASK, specPath: "", content: "" }),
    updateTask: updateTaskMock,
  } as unknown as TaskServiceInterface;
}

describe("updateTaskFromParams via @minsky/domain/tasks (mt#3190 — the live CLI/MCP import path)", () => {
  test("params.spec reaches taskService.updateTask — the discrepancy Success Criterion 4 required resolving explicitly", async () => {
    const updateTaskMock = mock((taskId: string, updates: Partial<Task>) =>
      Promise.resolve({ ...STUB_TASK, ...updates })
    );
    const taskService = makeStubTaskService(updateTaskMock);

    await updateTaskFromParams(
      { taskId: "mt#123", spec: "## Summary\n\nNew spec body." },
      { taskService }
    );

    expect(updateTaskMock).toHaveBeenCalledWith(
      "mt#123",
      expect.objectContaining({ spec: "## Summary\n\nNew spec body." })
    );
  });

  test("params.title also still reaches taskService.updateTask (both fields apply, not one at the other's expense)", async () => {
    const updateTaskMock = mock((taskId: string, updates: Partial<Task>) =>
      Promise.resolve({ ...STUB_TASK, ...updates })
    );
    const taskService = makeStubTaskService(updateTaskMock);

    await updateTaskFromParams(
      { taskId: "mt#123", title: "New title", spec: "New spec" },
      { taskService }
    );

    expect(updateTaskMock).toHaveBeenCalledWith(
      "mt#123",
      expect.objectContaining({ title: "New title", spec: "New spec" })
    );
  });

  test("a bare numeric taskId is normalized to the qualified form before reaching taskService.updateTask", async () => {
    const updateTaskMock = mock((taskId: string, updates: Partial<Task>) =>
      Promise.resolve({ ...STUB_TASK, ...updates })
    );
    const taskService = makeStubTaskService(updateTaskMock);

    await updateTaskFromParams({ taskId: "123", title: "New title" }, { taskService });

    expect(updateTaskMock).toHaveBeenCalledWith("mt#123", expect.anything());
  });
});
