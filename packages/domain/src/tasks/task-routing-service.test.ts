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

/**
 * Regression tests for mt#3011: the dependency-completeness checks previously treated a
 * dependency as satisfied only when its status was "DONE" or the nonexistent "CANCELLED"
 * status. "CANCELLED" has never been a valid Minsky task status — the cancellation/terminal
 * state is "CLOSED". As a result, a CLOSED dependency was (incorrectly) still treated as an
 * active blocker by both findAvailableTasks (tasks_available) and generateRoute (tasks_route).
 *
 * These tests fail on the pre-fix code (CLOSED dependencies block) and pass once the checks
 * treat DONE and CLOSED as the two non-blocking terminal statuses.
 */
describe("TaskRoutingService dependency-completeness treats CLOSED as terminal (mt#3011)", () => {
  test("findAvailableTasks: a task whose sole dependency is CLOSED is available (not blocked)", async () => {
    const dependent: Task = { id: "mt#100", title: "Dependent task", status: "TODO" };
    const closedDep: Task = { id: "mt#99", title: "Closed dependency", status: "CLOSED" };

    const taskGraphService = {
      getRelationshipsForTasks: async () => [{ fromTaskId: "mt#100", toTaskId: "mt#99" }],
    } as unknown as TaskGraphService;

    const taskService = {
      listTasks: async () => [dependent],
      getTask: async (id: string) => (id === closedDep.id ? closedDep : null),
    } as unknown as TaskServiceInterface;

    const service = new TaskRoutingService(taskGraphService, taskService);

    const result = await service.findAvailableTasks({ statusFilter: ["TODO"] });

    expect(result).toHaveLength(1);
    expect(result[0].blockedBy).toEqual([]);
    expect(result[0].readinessScore).toBe(1.0);
  });

  test("generateRoute: a task whose sole dependency is CLOSED is routable (not blocked)", async () => {
    const target: Task = { id: "mt#200", title: "Target task", status: "TODO" };
    const closedDep: Task = { id: "mt#199", title: "Closed dependency", status: "CLOSED" };

    const taskGraphService = {
      listDependencies: async (taskId: string) => (taskId === target.id ? [closedDep.id] : []),
    } as unknown as TaskGraphService;

    const taskService = {
      getTask: async (id: string) => {
        if (id === target.id) return target;
        if (id === closedDep.id) return closedDep;
        return null;
      },
    } as unknown as TaskServiceInterface;

    const service = new TaskRoutingService(taskGraphService, taskService);

    const route = await service.generateRoute(target.id);

    expect(route.totalTasks).toBe(2);
    expect(route.blockedTasks).toBe(0);
    expect(route.readyTasks).toBe(2);
  });
});
