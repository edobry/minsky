/**
 * CRITICAL acceptance test (mt#3330 AT1): after a mining run, `tasks_available`
 * routing must return ZERO `engprod-proposal` tasks. Verified against the
 * REAL `TaskRoutingService` — not a mock of it — per the task's explicit
 * instruction: "routing serves TODO/IN-PROGRESS only — verify against the
 * real task-routing-service in a test."
 *
 * `findAvailableTasks`'s default `statusFilter` is `["TODO", "IN-PROGRESS"]`
 * (task-routing-service.ts). With more than one status in the filter, the
 * service does NOT delegate status filtering to the backend — it fetches
 * all tasks and filters client-side via
 * `statusFilteredTasks.filter((task) => statusFilter.includes(task.status))`
 * — so a fake `listTasks` that ignores its options and returns every task
 * (mirroring a real un-filtered backend call) still exercises the REAL
 * exclusion logic this test cares about.
 */

import { describe, test, expect } from "bun:test";
import { TaskRoutingService } from "../tasks/task-routing-service";
import type { TaskGraphService } from "../tasks/task-graph-service";
import type { TaskServiceInterface } from "../tasks/taskService";
import type { Task } from "../tasks/types";
import { ENGPROD_PROPOSAL_TAG } from "./types";

function stubTaskGraphService(): TaskGraphService {
  return { getRelationshipsForTasks: async () => [] } as unknown as TaskGraphService;
}

function stubTaskService(tasks: Task[]): TaskServiceInterface {
  return {
    listTasks: async () => tasks,
    getTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
  } as unknown as TaskServiceInterface;
}

describe("AT1: engprod-proposal containment against the real TaskRoutingService", () => {
  test("a BLOCKED engprod-proposal task is excluded from findAvailableTasks (tasks_available)", async () => {
    const proposalTask: Task = {
      id: "mt#5000",
      title: "EngProd proposal: Read -> Edit",
      status: "BLOCKED",
      tags: [ENGPROD_PROPOSAL_TAG],
    };
    const humanTodoTask: Task = { id: "mt#5001", title: "Human task", status: "TODO", tags: [] };
    const humanInProgressTask: Task = {
      id: "mt#5002",
      title: "Human task 2",
      status: "IN-PROGRESS",
      tags: [],
    };

    const service = new TaskRoutingService(
      stubTaskGraphService(),
      stubTaskService([proposalTask, humanTodoTask, humanInProgressTask])
    );

    const available = await service.findAvailableTasks();

    expect(available.map((t) => t.taskId)).not.toContain("mt#5000");
    expect(available.map((t) => t.taskId).sort()).toEqual(["mt#5001", "mt#5002"]);
  });

  test("zero engprod-proposal tasks surface even when every live task is a proposal", async () => {
    const proposals: Task[] = [
      { id: "mt#6000", title: "p1", status: "BLOCKED", tags: [ENGPROD_PROPOSAL_TAG] },
      { id: "mt#6001", title: "p2", status: "BLOCKED", tags: [ENGPROD_PROPOSAL_TAG] },
    ];
    const service = new TaskRoutingService(stubTaskGraphService(), stubTaskService(proposals));

    const available = await service.findAvailableTasks();

    expect(available).toHaveLength(0);
  });

  test("an ACCEPTED (unblocked) former proposal becomes routable again, like any TODO task", async () => {
    // Once a principal unblocks a proposal task (moves it to TODO), it is
    // ordinary routable work — containment only holds WHILE BLOCKED.
    const acceptedProposal: Task = {
      id: "mt#7000",
      title: "Accepted proposal",
      status: "TODO",
      tags: [ENGPROD_PROPOSAL_TAG],
    };
    const service = new TaskRoutingService(
      stubTaskGraphService(),
      stubTaskService([acceptedProposal])
    );

    const available = await service.findAvailableTasks();

    expect(available.map((t) => t.taskId)).toContain("mt#7000");
  });
});
