/**
 * Regression tests: umbrella closeout through the unified DONE guard.
 *
 * History: mt#2606 shipped a dedicated umbrella → COMPLETED children-
 * completeness guard (`assertUmbrellaChildrenComplete`). mt#2311 collapsed
 * the workflows to a single success terminal (DONE), removed COMPLETED, and
 * folded umbrella closeout into the any-kind parent-DONE guard
 * (`assertChildrenCompleteForDone`, mt#1649 — helper-level coverage lives in
 * parent-done-closeout-guard.test.ts). These tests pin the umbrella-flavored
 * behavior on the LIVE `setTaskStatusFromParams` facade in
 * packages/domain/src/tasks.ts (what the `@minsky/domain/tasks` barrel
 * resolves to — the MCP/CLI path):
 *
 *   1. umbrella IN-PROGRESS → DONE refused while a child is open, error
 *      naming the child, no status write.
 *   2. umbrella IN-PROGRESS → DONE allowed when all children are terminal.
 *   3. the retired COMPLETED value is rejected at the parameter boundary.
 */

import { describe, it, expect, mock } from "bun:test";
import { setTaskStatusFromParams } from "../tasks";
import type { TaskServiceInterface } from "./taskService";

type ChildFixture = { id: string; status: string };

function makeGraph(childIds: string[]) {
  return { listChildren: mock(async () => childIds) };
}

function makeTaskService(opts: {
  parentKind?: string;
  parentStatus?: string;
  children?: ChildFixture[];
}): TaskServiceInterface & { statusSpy: ReturnType<typeof mock> } {
  const statusSpy = mock(async () => {});
  const service = {
    getTask: mock(async () => ({
      id: "mt#9000",
      title: "Parent",
      status: opts.parentStatus ?? "IN-PROGRESS",
      kind: opts.parentKind ?? "umbrella",
      backend: "minsky",
    })),
    getTasks: mock(async (ids: string[]) =>
      (opts.children ?? []).filter((c) => ids.includes(c.id))
    ),
    setTaskStatus: statusSpy,
    listBackends: () => [],
    statusSpy,
  } as unknown as TaskServiceInterface & { statusSpy: ReturnType<typeof mock> };
  return service;
}

describe("umbrella closeout via the unified DONE guard (mt#2311; formerly mt#2606)", () => {
  it("blocks umbrella → DONE with an open child, naming it, and does not write the status", async () => {
    const taskService = makeTaskService({
      children: [
        { id: "mt#9001", status: "DONE" },
        { id: "mt#9002", status: "TODO" },
      ],
    });
    await expect(
      setTaskStatusFromParams(
        { taskId: "mt#9000", status: "DONE" },
        { taskService, taskGraphService: makeGraph(["mt#9001", "mt#9002"]) }
      )
    ).rejects.toThrow(/mt#9002 \(TODO\)/);
    expect(taskService.statusSpy.mock.calls.length).toBe(0);
  });

  it("allows umbrella → DONE when all children are terminal (DONE/CLOSED)", async () => {
    const taskService = makeTaskService({
      children: [
        { id: "mt#9001", status: "DONE" },
        { id: "mt#9002", status: "CLOSED" },
      ],
    });
    await setTaskStatusFromParams(
      { taskId: "mt#9000", status: "DONE" },
      { taskService, taskGraphService: makeGraph(["mt#9001", "mt#9002"]) }
    );
    expect(taskService.statusSpy.mock.calls.length).toBe(1);
    const call = taskService.statusSpy.mock.calls[0] as unknown[];
    expect(call[0]).toBe("mt#9000");
    expect(call[1]).toBe("DONE");
  });

  it("allows a childless umbrella → DONE", async () => {
    const taskService = makeTaskService({ children: [] });
    await setTaskStatusFromParams(
      { taskId: "mt#9000", status: "DONE" },
      { taskService, taskGraphService: makeGraph([]) }
    );
    expect(taskService.statusSpy.mock.calls.length).toBe(1);
  });

  it("rejects the retired COMPLETED value at the parameter boundary", async () => {
    const taskService = makeTaskService({});
    await expect(
      setTaskStatusFromParams(
        { taskId: "mt#9000", status: "COMPLETED" },
        { taskService, taskGraphService: makeGraph([]) }
      )
    ).rejects.toThrow(/Invalid option|Invalid parameters/);
    expect(taskService.statusSpy.mock.calls.length).toBe(0);
  });
});
