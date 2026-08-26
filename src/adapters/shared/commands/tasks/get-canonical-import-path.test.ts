/**
 * Regression test for mt#3190: exercises `getTaskFromParams` via the EXACT
 * import path the live CLI/MCP `tasks.get` command uses — `crud-commands.ts`'s
 * `await import("@minsky/domain/tasks")` — not the `taskCommands.ts` barrel
 * that `index-embeddings-command.ts` imports directly
 * (`from "@minsky/domain/tasks/taskCommands"`) and that historically carried
 * the bulk of the existing coverage for the sibling copy in
 * `tasks/commands/query-commands.ts`.
 *
 * Before mt#3190, `packages/domain/src/tasks.ts`'s `getTaskFromParams` had no
 * taskId normalization (`normalizeTaskIdInput`) and no session/repo
 * resolution, while `tasks/commands/query-commands.ts`'s copy had both. Post-
 * consolidation, `tasks.ts` delegates to `query-commands.ts`'s implementation,
 * so this test doubles as a regression guard against the two diverging again
 * (mirrors `list-canonical-import-path.test.ts` / `spec-canonical-import-path.test.ts`
 * for the same-shaped mt#2783 / mt#3194 precedents).
 */
import { describe, test, expect, mock } from "bun:test";
import { getTaskFromParams } from "@minsky/domain/tasks";
import { ResourceNotFoundError } from "@minsky/domain/errors";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { Task } from "@minsky/domain/tasks/types";

const STUB_TASK = { id: "mt#123", title: "Test task", status: "TODO" } as unknown as Task;

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

describe("getTaskFromParams via @minsky/domain/tasks (mt#3190 — the live CLI/MCP import path)", () => {
  test("a bare numeric taskId is normalized to the qualified form before reaching taskService.getTask", async () => {
    const getTaskMock = mock((taskId: string) => Promise.resolve(STUB_TASK));
    const taskService = makeStubTaskService(getTaskMock);

    await getTaskFromParams({ taskId: "123" }, { taskService });

    // Confirms normalizeTaskIdInput actually ran on this import path — the
    // exact behavior tasks.ts's pre-mt#3190 body never had.
    expect(getTaskMock).toHaveBeenCalledWith("mt#123");
  });

  test("a not-found task throws ResourceNotFoundError", async () => {
    const getTaskMock = mock(() => Promise.resolve(null));
    const taskService = makeStubTaskService(getTaskMock);

    await expect(getTaskFromParams({ taskId: "mt#999" }, { taskService })).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
  });

  test("a session param with no injected taskService does not hit the session-provider throw (workspace resolution falls back to cwd)", async () => {
    // No taskService AND no persistenceProvider injected, with a `session`
    // param present — the shape that would reach
    // tasks/commands/shared-helpers.ts's session-aware resolveRepoPath
    // default, which throws "sessionProvider is required..." immediately.
    // This facade overrides that default (resolveMainWorkspacePath) to
    // preserve its pre-mt#3190 process.cwd()-based resolution, matching the
    // mt#3194 precedent for getTaskSpecContentFromParams. If the override
    // works, resolution succeeds and the call proceeds to (and fails on) the
    // NEXT step instead — the missing persistenceProvider.
    await expect(
      getTaskFromParams({ taskId: "mt#test", session: "some-session" }, {})
    ).rejects.toThrow(/persistenceProvider is required/);
  });
});
