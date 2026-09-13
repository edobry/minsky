/**
 * CRITICAL acceptance test (mt#3330 AT1, rewritten by mt#5130 AT4): after a
 * mining run, `tasks_available` routing must return ZERO `engprod-proposal`
 * tasks — before AND after the BLOCKED → TODO migration. Verified against the
 * REAL `TaskRoutingService`, not a mock of it.
 *
 * Until mt#5130 the containment was `status: "BLOCKED"` against the service's
 * `["TODO", "IN-PROGRESS"]` default filter. It is now the computed autonomy
 * class: the `engprod-proposal` tag resolves `principal-gated`, which the
 * consumer never serves, whatever the status. The fake signal source below
 * answers "spec present, sections absent" for every id, so an untagged task
 * resolves `pull-only` and the exclusion under test is the tag's alone.
 */

import { describe, test, expect } from "bun:test";
import { TaskRoutingService } from "../tasks/task-routing-service";
import type { AutonomySignalSource } from "../tasks/autonomy-class-store";
import type { TaskGraphService } from "../tasks/task-graph-service";
import type { TaskServiceInterface } from "../tasks/taskService";
import type { Task } from "../tasks/types";
import { ENGPROD_ACCEPTED_TAG, ENGPROD_PROPOSAL_TAG } from "./types";

function stubTaskGraphService(): TaskGraphService {
  return {
    getRelationshipsForTasks: async () => [],
    listDependencies: async () => [],
  } as unknown as TaskGraphService;
}

function stubTaskService(tasks: Task[]): TaskServiceInterface {
  return {
    listTasks: async () => tasks,
    getTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
  } as unknown as TaskServiceInterface;
}

/** Every id has a spec row with no Scope/Summary — the minimal well-formed input. */
function stubSignalSource(): AutonomySignalSource {
  return {
    loadSpecSignals: async (ids) =>
      new Map(ids.map((id) => [id, { scope: null, summary: null, origin: null }])),
  };
}

function service(tasks: Task[]): TaskRoutingService {
  return new TaskRoutingService(stubTaskGraphService(), stubTaskService(tasks), stubSignalSource());
}

/** The 15-shape fixture: what the live proposals look like on each side of the migration. */
function proposals(status: "BLOCKED" | "TODO"): Task[] {
  return Array.from({ length: 15 }, (_, i) => ({
    id: `mt#${3419 + i}`,
    title: `EngProd proposal: session_exec -> session_exec (${i}x/${i} sessions)`,
    status,
    tags: [ENGPROD_PROPOSAL_TAG],
  }));
}

describe("AT4: engprod-proposal containment against the real TaskRoutingService", () => {
  test("BEFORE the migration (BLOCKED): zero proposals served, and the exclusion is not even counted — the status filter drops them first", async () => {
    const human: Task = { id: "mt#5001", title: "Human task", status: "TODO", tags: [] };
    const result = await service([...proposals("BLOCKED"), human]).findAvailableTasksWithClass();

    expect(result.tasks.map((t) => t.taskId)).toEqual(["mt#5001"]);
    expect(result.tasks[0]?.autonomyClass).toBe("pull-only");
    expect(result.excludedByClass).toEqual({ principalGated: 0, unknown: 0 });
  });

  test("AFTER the migration (TODO + tag): zero proposals served, all 15 counted principal-gated", async () => {
    const human: Task = { id: "mt#5001", title: "Human task", status: "TODO", tags: [] };
    const inProgress: Task = {
      id: "mt#5002",
      title: "Human task 2",
      status: "IN-PROGRESS",
      tags: [],
    };
    const result = await service([
      ...proposals("TODO"),
      human,
      inProgress,
    ]).findAvailableTasksWithClass();

    expect(result.tasks.map((t) => t.taskId).sort()).toEqual(["mt#5001", "mt#5002"]);
    expect(result.excludedByClass).toEqual({ principalGated: 15, unknown: 0 });
  });

  test("the old `findAvailableTasks` shape denies the same way — no caller can be served a proposal", async () => {
    const available = await service(proposals("TODO")).findAvailableTasks();
    expect(available).toHaveLength(0);
  });

  test("an ACCEPTED proposal (tag swapped to engprod-accepted) is routable again, like any agent-filed TODO", async () => {
    const accepted: Task = {
      id: "mt#7000",
      title: "EngProd proposal: Read -> Edit (accepted)",
      status: "TODO",
      tags: [ENGPROD_ACCEPTED_TAG],
    };
    const result = await service([accepted]).findAvailableTasksWithClass();

    expect(result.tasks.map((t) => t.taskId)).toEqual(["mt#7000"]);
    expect(result.tasks[0]?.autonomyClass).toBe("pull-only");
  });

  test("a PLANNED proposal that still carries the pending tag stays withheld — planning is not curation", async () => {
    const planned: Task = {
      id: "mt#7001",
      title: "EngProd proposal: Bash -> Bash",
      status: "IN-PROGRESS",
      tags: [ENGPROD_PROPOSAL_TAG],
    };
    const result = await service([planned]).findAvailableTasksWithClass();
    expect(result.tasks).toHaveLength(0);
    expect(result.excludedByClass.principalGated).toBe(1);
  });

  test("tasks_route: a proposal target is marked principal-gated, never 'ready' (AT4's route half)", async () => {
    const target = proposals("TODO")[0] as Task;
    const route = await service([target]).generateRoute(target.id);

    // The target is always its own depth-0 step; with no dependencies it is
    // the only one, and its class keeps it out of the ready count.
    expect(route.steps.map((s) => s.taskId)).toEqual([target.id]);
    expect(route.steps[0]?.autonomyClass).toBe("principal-gated");
    expect(route.readyTasks).toBe(0);
    expect(route.blockedTasks).toBe(1);
    expect(route.targetAutonomyClass).toBe("principal-gated");
    expect(route.targetAutonomyReasons).toContain(`tag ${ENGPROD_PROPOSAL_TAG}`);
  });
});
