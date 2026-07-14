/**
 * Regression tests for packages/domain/src/tasks.ts's listTasksFromParams — mt#2762.
 *
 * IMPORTANT: this is a SEPARATE implementation from
 * packages/domain/src/tasks/commands/query-commands.ts's listTasksFromParams (covered by
 * packages/domain/src/tasks/taskCommands.test.ts). packages/domain/src/tasks/index.ts
 * re-exports listTasksFromParams from "../tasks" (this file), and that barrel is what
 * `@minsky/domain/tasks` resolves to — the import used by the actual CLI/MCP
 * `tasks.list` command (src/adapters/shared/commands/tasks/crud-commands.ts). So THIS
 * file's listTasksFromParams is the one that must forward `kind`, even though the
 * query-commands.ts copy also forwards it for its own (different) callers
 * (e.g. index-embeddings-command.ts).
 *
 * Discovered while implementing mt#2762: `--kind umbrella` had no effect via the CLI
 * despite query-commands.ts's listTasksFromParams correctly forwarding kind — because
 * the CLI command never reaches that function. See mt#2783 for the tracked follow-up
 * to reconcile the duplicate implementations.
 */
import { describe, test, expect, mock } from "bun:test";
import { listTasksFromParams } from "./tasks";
import { ValidationError } from "./errors/index";
import type { TaskServiceInterface } from "./tasks/taskService";
import type { Task } from "./tasks/types";

function makeStubTaskService(listTasksMock: (options?: unknown) => Promise<Task[]>) {
  return {
    listTasks: listTasksMock,
    getTask: async () => null,
    getTasks: async () => [],
    getTaskStatus: async () => undefined,
    setTaskStatus: async () => {},
    createTaskFromTitleAndSpec: async () => ({ id: "#test", title: "Test", status: "TODO" }),
    deleteTask: async () => false,
    getWorkspacePath: () => "/test/path",
    getTaskSpecContent: async () => ({ task: {} as Task, specPath: "", content: "" }),
  } as unknown as TaskServiceInterface;
}

describe("packages/domain/src/tasks.ts listTasksFromParams kind filter (mt#2762)", () => {
  test("forwards a valid kind filter to taskService.listTasks (server-side)", async () => {
    const listTasksMock = mock(() => Promise.resolve([] as Task[]));
    const taskService = makeStubTaskService(listTasksMock);

    await listTasksFromParams({ all: true, kind: "umbrella", json: false }, { taskService });

    expect(listTasksMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "umbrella", all: true })
    );
  });

  test("an unknown kind is rejected with a ValidationError naming valid kinds, before the query runs", async () => {
    const listTasksMock = mock(() => Promise.resolve([] as Task[]));
    const taskService = makeStubTaskService(listTasksMock);

    await expect(
      listTasksFromParams({ all: true, kind: "not-a-real-kind", json: false }, { taskService })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(listTasksMock).not.toHaveBeenCalled();
  });

  test("no kind filter forwards kind: undefined (no filter applied)", async () => {
    const listTasksMock = mock(() => Promise.resolve([] as Task[]));
    const taskService = makeStubTaskService(listTasksMock);

    await listTasksFromParams({ all: true, json: false }, { taskService });

    expect(listTasksMock).toHaveBeenCalledWith(expect.objectContaining({ kind: undefined }));
  });
});
