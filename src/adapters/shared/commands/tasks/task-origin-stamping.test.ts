/**
 * The trust boundary on `tasks.origin` (mt#5136): the creation channel is
 * stamped by the CODE PATH that files a task, never taken from the caller.
 *
 * Three properties, each pinned separately because each can regress alone:
 *
 * 1. `tasksCreateParams` — the shared command's parameter map, the ONLY
 *    thing the MCP undeclared-param check (mt#2778) reads — declares no
 *    `origin`. Adding one there would silently open the boundary.
 * 2. The MCP boundary, driven through the real `CommandMapper` wrapping with
 *    the real `tasks.create` schema, rejects `origin` in a payload (AT2).
 * 3. The domain facade (`createTaskFromTitleAndSpec` via `@minsky/domain/tasks`,
 *    the exact import `crud-commands.ts` and `dispatch-command.ts` use)
 *    forwards an adapter-supplied `origin` to the task service, and rejects a
 *    value outside the `TaskOrigin` enum — so an adapter can stamp, and only
 *    a real channel value reaches the row.
 */
import { describe, test, expect, mock } from "bun:test";
import { CommandMapper } from "../../../../mcp/command-mapper";
import type { MinskyMCPServer, ToolDefinition } from "../../../../mcp/server";
import { createMock } from "../../../../utils/test-utils/mocking";
import { convertParametersToZodSchema } from "../../../mcp/shared-command-integration";
import { tasksCreateParams } from "./task-parameters";
import { createTaskFromTitleAndSpec } from "@minsky/domain/tasks";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { Task } from "@minsky/domain/tasks/types";

const SPEC = "## Summary\n\nBody.";

describe("tasks.create declares no origin parameter (mt#5136 SC2)", () => {
  test("the shared params map — the MCP key-set source — has no `origin` key", () => {
    expect(Object.keys(tasksCreateParams)).not.toContain("origin");
  });
});

describe("the MCP boundary rejects a caller-supplied origin (mt#5136 AT2)", () => {
  test("a tasks_create payload carrying `origin` is refused as undeclared, naming the key", async () => {
    const addTool = createMock();
    const mockServer = {
      addTool,
      getProjectContext: createMock(() => ({ repositoryPath: "/test/repo", gitBranch: "main" })),
      start: createMock(),
      getServer: createMock(),
    } as unknown as MinskyMCPServer;
    const mapper = new CommandMapper(mockServer, {
      repositoryPath: "/test/repo",
      gitBranch: "main",
    } as never);

    const executed = mock(async () => "created");
    mapper.addCommand({
      name: "tasks.create",
      description: "the real tasks.create parameter surface",
      parameters: convertParametersToZodSchema(tasksCreateParams),
      handler: executed,
    });
    const tool = addTool.mock.calls[0]?.[0] as ToolDefinition | undefined;
    const handler = tool?.handler;
    if (!handler) throw new Error("expected CommandMapper to register an eager handler");

    await expect(handler({ title: "A task", spec: SPEC, origin: "human" })).rejects.toThrow(
      /Unknown parameter "origin" for "tasks.create"/
    );
    expect(executed).not.toHaveBeenCalled();
  });
});

const STUB_TASK = { id: "mt#new", title: "New task", status: "TODO" } as unknown as Task;

function stubTaskService(create: (title: string, spec: string, options: unknown) => Promise<Task>) {
  return {
    listTasks: async () => [],
    getTask: async () => STUB_TASK,
    getTaskStatus: async () => undefined,
    setTaskStatus: async () => ({ recordsAffected: 1 }),
    createTaskFromTitleAndSpec: create,
    deleteTask: async () => false,
    getWorkspacePath: () => "/test/path",
    getTaskSpecContent: async () => ({ task: STUB_TASK, specPath: "", content: "" }),
  } as unknown as TaskServiceInterface;
}

describe("the domain facade carries the adapter's stamp to the service (mt#5136)", () => {
  test("an adapter-supplied origin reaches createTaskFromTitleAndSpec's options", async () => {
    const create = mock(() => Promise.resolve(STUB_TASK));
    await createTaskFromTitleAndSpec(
      { title: "New task", spec: SPEC, origin: "agent" },
      { taskService: stubTaskService(create) }
    );
    expect(create).toHaveBeenCalledWith(
      "New task",
      SPEC,
      expect.objectContaining({ origin: "agent" })
    );
  });

  test("no stamp → origin is forwarded as undefined, so the row lands NULL (unknown), never a guess", async () => {
    const create = mock((_title: string, _spec: string, _options: unknown) =>
      Promise.resolve(STUB_TASK)
    );
    await createTaskFromTitleAndSpec(
      { title: "New task", spec: SPEC },
      { taskService: stubTaskService(create) }
    );
    const options = create.mock.calls[0]?.[2] as { origin?: unknown } | undefined;
    expect(options).toBeDefined();
    expect(options?.origin).toBeUndefined();
  });

  test("a value outside the TaskOrigin enum is refused before it reaches the service", async () => {
    const create = mock(() => Promise.resolve(STUB_TASK));
    await expect(
      createTaskFromTitleAndSpec(
        { title: "New task", spec: SPEC, origin: "principal" as never },
        { taskService: stubTaskService(create) }
      )
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
