/**
 * Regression test for mt#3190: exercises `deleteTaskFromParams` via the EXACT
 * import path the live CLI `tasks.delete` command uses — `crud-commands.ts`'s
 * `await import("@minsky/domain/tasks")` — not the `taskCommands.ts` barrel
 * that historically carried the bulk of the existing coverage for the
 * sibling copy in `tasks/commands/mutation-commands.ts`.
 *
 * Before mt#3190, `packages/domain/src/tasks.ts`'s `deleteTaskFromParams` had
 * no taskId normalization and no ZodError-to-ValidationError wrapping, while
 * `tasks/commands/mutation-commands.ts`'s copy had both. Post-consolidation,
 * `tasks.ts` delegates to `mutation-commands.ts`'s implementation.
 */
import { describe, test, expect, mock } from "bun:test";
import { deleteTaskFromParams } from "@minsky/domain/tasks";
import { ValidationError } from "@minsky/domain/errors";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { Task } from "@minsky/domain/tasks/types";

const STUB_TASK = { id: "mt#123", title: "Test task", status: "TODO" } as unknown as Task;

function makeStubTaskService(
  deleteTaskMock: (taskId: string, options: unknown) => Promise<boolean>
) {
  return {
    listTasks: async () => [],
    getTask: async () => STUB_TASK,
    getTaskStatus: async () => undefined,
    setTaskStatus: async () => ({ recordsAffected: 1 }),
    createTaskFromTitleAndSpec: async () => STUB_TASK,
    deleteTask: deleteTaskMock,
    getWorkspacePath: () => "/test/path",
    getTaskSpecContent: async () => ({ task: STUB_TASK, specPath: "", content: "" }),
  } as unknown as TaskServiceInterface;
}

describe("deleteTaskFromParams via @minsky/domain/tasks (mt#3190 — the live CLI/MCP import path)", () => {
  test("a bare numeric taskId is normalized to the qualified form before reaching taskService.deleteTask", async () => {
    const deleteTaskMock = mock(() => Promise.resolve(true));
    const taskService = makeStubTaskService(deleteTaskMock);

    const result = await deleteTaskFromParams({ taskId: "123", force: true }, { taskService });

    expect(deleteTaskMock).toHaveBeenCalledWith("mt#123", expect.objectContaining({ force: true }));
    // mutation-commands.ts's result additionally includes the deleted
    // `task` (an addition, not a regression — crud-commands.ts's caller
    // only reads `.success`); assert the fields tasks.ts's pre-mt#3190
    // body guaranteed, via objectContaining rather than toEqual.
    expect(result).toEqual(expect.objectContaining({ success: true, taskId: "mt#123" }));
  });

  test("an empty/missing taskId is rejected with a ValidationError (ZodError wrapped)", async () => {
    const deleteTaskMock = mock(() => Promise.resolve(true));
    const taskService = makeStubTaskService(deleteTaskMock);

    await expect(deleteTaskFromParams({}, { taskService })).rejects.toBeInstanceOf(ValidationError);
  });
});
