/**
 * Regression tests: umbrella children-completeness closeout guard (mt#2606).
 *
 * An umbrella task's success terminal is COMPLETED ("objective achieved / all
 * children done"). Before mt#2606 nothing enforced the "all children done"
 * half: `tasks_status_set` would happily complete an umbrella with open
 * children. The guard refuses the transition and names the incomplete
 * children.
 *
 * Covers both surfaces:
 *   - `assertUmbrellaChildrenComplete` (the shared helper), and
 *   - the live `setTaskStatusFromParams` facade in packages/domain/src/tasks.ts
 *     (what the `@minsky/domain/tasks` barrel resolves to — the MCP/CLI path).
 */

import { describe, it, expect, mock } from "bun:test";
import { setTaskStatusFromParams } from "../tasks";
import { assertUmbrellaChildrenComplete } from "./commands/mutation-commands";
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

describe("assertUmbrellaChildrenComplete (mt#2606)", () => {
  it("refuses when a child is non-terminal, naming id and status", async () => {
    const taskService = makeTaskService({
      children: [
        { id: "mt#9001", status: "DONE" },
        { id: "mt#9002", status: "IN-PROGRESS" },
      ],
    });
    await expect(
      assertUmbrellaChildrenComplete({
        taskId: "mt#9000",
        taskKind: "umbrella",
        targetStatus: "COMPLETED",
        taskService,
        taskGraphService: makeGraph(["mt#9001", "mt#9002"]),
      })
    ).rejects.toThrow(/mt#9002 \(IN-PROGRESS\)/);
  });

  it("passes when every child is terminal (DONE/CLOSED/COMPLETED)", async () => {
    const taskService = makeTaskService({
      children: [
        { id: "mt#9001", status: "DONE" },
        { id: "mt#9002", status: "CLOSED" },
        { id: "mt#9003", status: "COMPLETED" },
      ],
    });
    await expect(
      assertUmbrellaChildrenComplete({
        taskId: "mt#9000",
        taskKind: "umbrella",
        targetStatus: "COMPLETED",
        taskService,
        taskGraphService: makeGraph(["mt#9001", "mt#9002", "mt#9003"]),
      })
    ).resolves.toBeUndefined();
  });

  it("treats a child id the task service cannot return as incomplete", async () => {
    const taskService = makeTaskService({
      children: [{ id: "mt#9001", status: "DONE" }],
    });
    await expect(
      assertUmbrellaChildrenComplete({
        taskId: "mt#9000",
        taskKind: "umbrella",
        targetStatus: "COMPLETED",
        taskService,
        taskGraphService: makeGraph(["mt#9001", "mt#9099"]),
      })
    ).rejects.toThrow(/mt#9099 \(unreadable\)/);
  });

  it("is a no-op for non-umbrella kinds and non-COMPLETED targets", async () => {
    const taskService = makeTaskService({
      children: [{ id: "mt#9002", status: "IN-PROGRESS" }],
    });
    await expect(
      assertUmbrellaChildrenComplete({
        taskId: "mt#9000",
        taskKind: "implementation",
        targetStatus: "COMPLETED",
        taskService,
        taskGraphService: makeGraph(["mt#9002"]),
      })
    ).resolves.toBeUndefined();
    await expect(
      assertUmbrellaChildrenComplete({
        taskId: "mt#9000",
        taskKind: "umbrella",
        targetStatus: "IN-PROGRESS",
        taskService,
        taskGraphService: makeGraph(["mt#9002"]),
      })
    ).resolves.toBeUndefined();
  });

  it("is a no-op when no taskGraphService is injected (prior behavior preserved)", async () => {
    const taskService = makeTaskService({
      children: [{ id: "mt#9002", status: "IN-PROGRESS" }],
    });
    await expect(
      assertUmbrellaChildrenComplete({
        taskId: "mt#9000",
        taskKind: "umbrella",
        targetStatus: "COMPLETED",
        taskService,
      })
    ).resolves.toBeUndefined();
  });

  it("fails open (allows COMPLETED) when listChildren throws (mt#1649 R1)", async () => {
    const taskService = makeTaskService({});
    const throwingGraph = {
      listChildren: mock(async () => {
        throw new Error("backend unavailable");
      }),
    };
    await expect(
      assertUmbrellaChildrenComplete({
        taskId: "mt#9000",
        taskKind: "umbrella",
        targetStatus: "COMPLETED",
        taskService,
        taskGraphService: throwingGraph,
      })
    ).resolves.toBeUndefined();
  });

  it("fails open (allows COMPLETED) when getTasks throws (mt#1649 R1)", async () => {
    const throwingTaskService = {
      getTasks: mock(async () => {
        throw new Error("db connection lost");
      }),
    } as unknown as TaskServiceInterface;
    await expect(
      assertUmbrellaChildrenComplete({
        taskId: "mt#9000",
        taskKind: "umbrella",
        targetStatus: "COMPLETED",
        taskService: throwingTaskService,
        taskGraphService: makeGraph(["mt#9002"]),
      })
    ).resolves.toBeUndefined();
  });
});

describe("setTaskStatusFromParams facade wires the guard (mt#2606, live MCP/CLI path)", () => {
  it("blocks umbrella → COMPLETED with an open child and does not write the status", async () => {
    const taskService = makeTaskService({
      children: [{ id: "mt#9002", status: "TODO" }],
    });
    await expect(
      setTaskStatusFromParams(
        { taskId: "mt#9000", status: "COMPLETED" },
        { taskService, taskGraphService: makeGraph(["mt#9002"]) }
      )
    ).rejects.toThrow(/Cannot complete umbrella task mt#9000/);
    expect(taskService.statusSpy.mock.calls.length).toBe(0);
  });

  it("allows umbrella → COMPLETED when all children are terminal", async () => {
    const taskService = makeTaskService({
      children: [{ id: "mt#9002", status: "DONE" }],
    });
    await setTaskStatusFromParams(
      { taskId: "mt#9000", status: "COMPLETED" },
      { taskService, taskGraphService: makeGraph(["mt#9002"]) }
    );
    expect(taskService.statusSpy.mock.calls.length).toBe(1);
    const call = taskService.statusSpy.mock.calls[0] as unknown[];
    expect(call[0]).toBe("mt#9000");
    expect(call[1]).toBe("COMPLETED");
  });

  it("validates transitions server-side via the delegation (implementation kind cannot reach COMPLETED)", async () => {
    const taskService = makeTaskService({
      parentKind: "implementation",
      parentStatus: "TODO",
    });
    await expect(
      setTaskStatusFromParams({ taskId: "mt#9000", status: "COMPLETED" }, { taskService })
    ).rejects.toThrow(/transition/i);
    expect(taskService.statusSpy.mock.calls.length).toBe(0);
  });
});
