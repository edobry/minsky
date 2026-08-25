/**
 * Regression test for mt#3190: exercises `createTaskFromParams` and
 * `createTaskFromTitleAndSpec` via the EXACT import path the live CLI/MCP
 * `tasks.create` command and `tasks.dispatch`'s new-task-mode use —
 * `crud-commands.ts` / `dispatch-command.ts`'s
 * `await import("@minsky/domain/tasks")` — not the `taskCommands.ts` barrel
 * that historically carried the bulk of the existing coverage for the
 * sibling copies in `tasks/commands/mutation-commands.ts`
 * (`mutation-commands-kind.test.ts`).
 *
 * Before mt#3190, `packages/domain/src/tasks.ts`'s `createTaskFromParams`
 * simply forwarded to its own local `createTaskFromTitleAndSpec` (both
 * validated via `taskCreateParamsSchema`, which additionally accepts a
 * deprecated `description` alias for `spec`), while
 * `tasks/commands/mutation-commands.ts` held two fully independent bodies —
 * `createTaskFromParams` (same schema) and `createTaskFromTitleAndSpec`
 * (a narrower `taskCreateFromTitleAndSpecParamsSchema` with no `description`
 * support). No production consumer of the facade's `createTaskFromParams` (as
 * opposed to `createTaskFromTitleAndSpec`) was found during the mt#3190 audit,
 * so this test only needs to confirm the delegation reaches
 * `taskService.createTaskFromTitleAndSpec` correctly for both entry points.
 */
import { describe, test, expect, mock } from "bun:test";
import { createTaskFromParams, createTaskFromTitleAndSpec } from "@minsky/domain/tasks";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { Task } from "@minsky/domain/tasks/types";

const STUB_TASK = { id: "mt#new", title: "New task", status: "TODO" } as unknown as Task;
const LEGACY_DESCRIPTION = "Legacy description text";

function makeStubTaskService(
  createMock: (title: string, spec: string, options: unknown) => Promise<Task>
) {
  return {
    listTasks: async () => [],
    getTask: async () => STUB_TASK,
    getTaskStatus: async () => undefined,
    setTaskStatus: async () => ({ recordsAffected: 1 }),
    createTaskFromTitleAndSpec: createMock,
    deleteTask: async () => false,
    getWorkspacePath: () => "/test/path",
    getTaskSpecContent: async () => ({ task: STUB_TASK, specPath: "", content: "" }),
  } as unknown as TaskServiceInterface;
}

describe("createTaskFromTitleAndSpec via @minsky/domain/tasks (mt#3190 — the live CLI/MCP import path)", () => {
  test("forwards title/spec/tags/backend to taskService.createTaskFromTitleAndSpec", async () => {
    const createMock = mock(() => Promise.resolve(STUB_TASK));
    const taskService = makeStubTaskService(createMock);

    await createTaskFromTitleAndSpec(
      { title: "New task", spec: "## Summary\n\nBody.", tags: ["tech-debt"], backend: "minsky" },
      { taskService }
    );

    expect(createMock).toHaveBeenCalledWith(
      "New task",
      "## Summary\n\nBody.",
      expect.objectContaining({ tags: ["tech-debt"], backend: "minsky" })
    );
  });

  test("`description` alone (no `spec`) is rejected — unlike createTaskFromParams below, this narrower schema has no deprecated-alias fallback", async () => {
    const createMock = mock(() => Promise.resolve(STUB_TASK));
    const taskService = makeStubTaskService(createMock);

    await expect(
      createTaskFromTitleAndSpec(
        { title: "New task", description: LEGACY_DESCRIPTION } as unknown as Record<
          string,
          unknown
        >,
        { taskService }
      )
    ).rejects.toThrow();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("createTaskFromParams via @minsky/domain/tasks (mt#3190 — no live production consumer, verified by grep)", () => {
  test("the deprecated `description` alias still resolves into the spec argument", async () => {
    const createMock = mock(() => Promise.resolve(STUB_TASK));
    const taskService = makeStubTaskService(createMock);

    await createTaskFromParams(
      { title: "New task", description: LEGACY_DESCRIPTION },
      { taskService }
    );

    expect(createMock).toHaveBeenCalledWith("New task", LEGACY_DESCRIPTION, expect.anything());
  });
});
