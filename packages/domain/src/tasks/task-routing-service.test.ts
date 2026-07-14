/**
 * Regression tests for TaskRoutingService.findAvailableTasks' kind filter (mt#2762).
 *
 * `tasks_available` forwards its `kind` param into `findAvailableTasks`, which in turn
 * forwards it to `taskService.listTasks({ kind })` — the same server-side filtering
 * contract as `tasks_list` (listTasksFromParams). This test verifies the forwarding
 * with a stubbed TaskServiceInterface (`listTasks` records the options it was called
 * with) and a minimal TaskGraphService stub, since findAvailableTasks does not
 * validate `kind` itself — validation happens upstream (assertKnownKind) in the
 * command handler (routing-commands.ts).
 */
import { describe, test, expect, mock } from "bun:test";
import { TaskRoutingService } from "./task-routing-service";
import type { TaskGraphService } from "./task-graph-service";
import type { TaskServiceInterface } from "./taskService";
import type { Task } from "./types";

function makeStubTaskGraphService(): TaskGraphService {
  return {
    getRelationshipsForTasks: async () => [],
  } as unknown as TaskGraphService;
}

describe("TaskRoutingService.findAvailableTasks kind filter (mt#2762)", () => {
  test("forwards kind to taskService.listTasks (server-side)", async () => {
    const listTasksMock = mock(() => Promise.resolve([] as Task[]));
    const taskService = {
      listTasks: listTasksMock,
      getTask: async () => null,
    } as unknown as TaskServiceInterface;

    const service = new TaskRoutingService(makeStubTaskGraphService(), taskService);

    await service.findAvailableTasks({
      statusFilter: ["TODO"],
      kind: "umbrella",
    });

    expect(listTasksMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "TODO", kind: "umbrella" })
    );
  });

  test("kind is undefined when not requested (no filter applied)", async () => {
    const listTasksMock = mock(() => Promise.resolve([] as Task[]));
    const taskService = {
      listTasks: listTasksMock,
      getTask: async () => null,
    } as unknown as TaskServiceInterface;

    const service = new TaskRoutingService(makeStubTaskGraphService(), taskService);

    await service.findAvailableTasks({ statusFilter: ["TODO"] });

    expect(listTasksMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "TODO", kind: undefined })
    );
  });

  test("results are scoped to whatever taskService.listTasks returns for the kind filter", async () => {
    const umbrellaTasks: Task[] = [
      { id: "mt#1552", title: "Umbrella A", status: "IN-PROGRESS", kind: "umbrella" },
      { id: "mt#2230", title: "Umbrella B", status: "TODO", kind: "umbrella" },
    ];
    const listTasksMock = mock(() => Promise.resolve(umbrellaTasks));
    const taskService = {
      listTasks: listTasksMock,
      getTask: async (id: string) => umbrellaTasks.find((t) => t.id === id) ?? null,
    } as unknown as TaskServiceInterface;

    const service = new TaskRoutingService(makeStubTaskGraphService(), taskService);

    const result = await service.findAvailableTasks({
      statusFilter: ["TODO", "IN-PROGRESS"],
      kind: "umbrella",
    });

    expect(result.map((t) => t.taskId).sort()).toEqual(["mt#1552", "mt#2230"]);
  });
});
