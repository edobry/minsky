/**
 * Regression test for mt#3190: exercises `getTaskStatusFromParams` via the
 * EXACT import path the live CLI/MCP `tasks.status.get` command uses —
 * `status-commands.ts`'s `import { getTaskStatusFromParams } from
 * "@minsky/domain/tasks"` — not the `taskCommands.ts` barrel that historically
 * carried the bulk of the existing coverage for the sibling copy in
 * `tasks/commands/query-commands.ts`.
 *
 * Before mt#3190, `packages/domain/src/tasks.ts`'s `getTaskStatusFromParams`
 * had no taskId normalization and no ZodError-to-ValidationError wrapping,
 * while `tasks/commands/query-commands.ts`'s copy had both. Post-
 * consolidation, `tasks.ts` delegates to `query-commands.ts`'s implementation
 * (see `get-canonical-import-path.test.ts` for the sibling `getTaskFromParams`
 * regression test this mirrors).
 */
import { describe, test, expect, mock } from "bun:test";
import { getTaskStatusFromParams } from "@minsky/domain/tasks";
import { ValidationError } from "@minsky/domain/errors";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { Task } from "@minsky/domain/tasks/types";

const STUB_TASK = { id: "mt#123", title: "Test task", status: "IN-PROGRESS" } as unknown as Task;

function makeStubTaskService(getTaskMock: (taskId: string) => Promise<Task | null>) {
  return {
    listTasks: async () => [],
    getTask: getTaskMock,
    getTaskStatus: async () => undefined,
    setTaskStatus: async () => ({ recordsAffected: 1 }),
    createTaskFromTitleAndSpec: async () => STUB_TASK,
    deleteTask: async () => false,
    getWorkspacePath: () => "/test/path",
    getTaskSpecContent: async () => ({ task: STUB_TASK, specPath: "", content: "" }),
  } as unknown as TaskServiceInterface;
}

describe("getTaskStatusFromParams via @minsky/domain/tasks (mt#3190 — the live CLI/MCP import path)", () => {
  test("a bare numeric taskId is normalized to the qualified form before reaching taskService.getTask", async () => {
    const getTaskMock = mock(() => Promise.resolve(STUB_TASK));
    const taskService = makeStubTaskService(getTaskMock);

    const status = await getTaskStatusFromParams({ taskId: "123" }, { taskService });

    expect(getTaskMock).toHaveBeenCalledWith("mt#123");
    expect(status).toBe("IN-PROGRESS");
  });

  test("an empty/missing taskId is rejected with a ValidationError (ZodError wrapped), not a raw ZodError", async () => {
    const getTaskMock = mock(() => Promise.resolve(STUB_TASK));
    const taskService = makeStubTaskService(getTaskMock);

    await expect(getTaskStatusFromParams({}, { taskService })).rejects.toBeInstanceOf(
      ValidationError
    );
  });
});
