/**
 * Regression tests: parent-rollup-completion closeout guard (mt#1649).
 *
 * `tasks_status_set` refuses a transition to DONE on a task that HAS children
 * while any child is non-terminal (terminal = DONE/CLOSED per
 * `isTerminalTaskStatus`), naming the incomplete children. Childless tasks to
 * DONE are unaffected. Since mt#2311's single-terminal collapse this one
 * guard also covers umbrella closeout (formerly mt#2606's separate
 * umbrella → COMPLETED guard).
 *
 * Originating incident: mt#1503 was set DONE on 2026-05-04 while its
 * lynchpin child (mt#1073) sat at PLANNING. See the "pinned regression"
 * describe block below for the fixture-level reproduction.
 *
 * Covers both surfaces, mirroring umbrella-closeout-guard.test.ts:
 *   - `assertChildrenCompleteForDone` (the shared helper), and
 *   - the live `setTaskStatusFromParams` facade in packages/domain/src/tasks.ts
 *     (what the `@minsky/domain/tasks` barrel resolves to — the MCP/CLI path).
 *
 * "Children" here means direct (single-level) children only, as returned by
 * `taskGraphService.listChildren` — same scope as the mt#2606 umbrella guard,
 * not a recursive descendant check.
 */

import { describe, it, expect, mock } from "bun:test";
import { setTaskStatusFromParams } from "../tasks";
import { assertChildrenCompleteForDone } from "./commands/mutation-commands";
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
      status: opts.parentStatus ?? "IN-REVIEW",
      kind: opts.parentKind ?? "implementation",
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

describe("assertChildrenCompleteForDone (mt#1649)", () => {
  it("allows a childless task to DONE", async () => {
    const taskService = makeTaskService({});
    await expect(
      assertChildrenCompleteForDone({
        taskId: "mt#9000",
        targetStatus: "DONE",
        taskService,
        taskGraphService: makeGraph([]),
      })
    ).resolves.toBeUndefined();
  });

  it("allows DONE when all children are DONE", async () => {
    const taskService = makeTaskService({
      children: [
        { id: "mt#9001", status: "DONE" },
        { id: "mt#9002", status: "DONE" },
      ],
    });
    await expect(
      assertChildrenCompleteForDone({
        taskId: "mt#9000",
        targetStatus: "DONE",
        taskService,
        taskGraphService: makeGraph(["mt#9001", "mt#9002"]),
      })
    ).resolves.toBeUndefined();
  });

  it("allows DONE with a mix of DONE/CLOSED children", async () => {
    const taskService = makeTaskService({
      children: [
        { id: "mt#9001", status: "DONE" },
        { id: "mt#9002", status: "CLOSED" },
        { id: "mt#9003", status: "DONE" },
      ],
    });
    await expect(
      assertChildrenCompleteForDone({
        taskId: "mt#9000",
        targetStatus: "DONE",
        taskService,
        taskGraphService: makeGraph(["mt#9001", "mt#9002", "mt#9003"]),
      })
    ).resolves.toBeUndefined();
  });

  it.each([["IN-REVIEW"], ["READY"], ["TODO"], ["PLANNING"], ["IN-PROGRESS"], ["BLOCKED"]])(
    "denies DONE when a child is %s, naming it",
    async (childStatus) => {
      const taskService = makeTaskService({
        children: [
          { id: "mt#9001", status: "DONE" },
          { id: "mt#9002", status: childStatus },
        ],
      });
      await expect(
        assertChildrenCompleteForDone({
          taskId: "mt#9000",
          targetStatus: "DONE",
          taskService,
          taskGraphService: makeGraph(["mt#9001", "mt#9002"]),
        })
      ).rejects.toThrow(new RegExp(`mt#9002 \\(${childStatus}\\)`));
    }
  );

  it("treats a child id the task service cannot return as incomplete", async () => {
    const taskService = makeTaskService({
      children: [{ id: "mt#9001", status: "DONE" }],
    });
    await expect(
      assertChildrenCompleteForDone({
        taskId: "mt#9000",
        targetStatus: "DONE",
        taskService,
        taskGraphService: makeGraph(["mt#9001", "mt#9099"]),
      })
    ).rejects.toThrow(/mt#9099 \(unreadable\)/);
  });

  it("names ALL incomplete children and includes the three suggested resolutions", async () => {
    const taskService = makeTaskService({
      children: [
        { id: "mt#9001", status: "PLANNING" },
        { id: "mt#9002", status: "TODO" },
      ],
    });
    await expect(
      assertChildrenCompleteForDone({
        taskId: "mt#9000",
        targetStatus: "DONE",
        taskService,
        taskGraphService: makeGraph(["mt#9001", "mt#9002"]),
      })
    ).rejects.toThrow(
      /2 child task\(s\) not terminal.*mt#9001 \(PLANNING\).*mt#9002 \(TODO\).*Set the children to DONE.*Amend the parent's success criteria.*Walk the parent through CLOSED/s
    );
  });

  it("is a no-op for non-DONE targets, regardless of children", async () => {
    const taskService = makeTaskService({
      children: [{ id: "mt#9002", status: "TODO" }],
    });
    await expect(
      assertChildrenCompleteForDone({
        taskId: "mt#9000",
        targetStatus: "IN-REVIEW",
        taskService,
        taskGraphService: makeGraph(["mt#9002"]),
      })
    ).resolves.toBeUndefined();
  });

  it("is a no-op when no taskGraphService is injected (prior behavior preserved)", async () => {
    const taskService = makeTaskService({
      children: [{ id: "mt#9002", status: "TODO" }],
    });
    await expect(
      assertChildrenCompleteForDone({
        taskId: "mt#9000",
        targetStatus: "DONE",
        taskService,
      })
    ).resolves.toBeUndefined();
  });

  it("applies regardless of task kind (state-ops example)", async () => {
    const taskService = makeTaskService({
      parentKind: "state-ops",
      children: [{ id: "mt#9002", status: "IN-PROGRESS" }],
    });
    await expect(
      assertChildrenCompleteForDone({
        taskId: "mt#9000",
        targetStatus: "DONE",
        taskService,
        taskGraphService: makeGraph(["mt#9002"]),
      })
    ).rejects.toThrow(/mt#9002 \(IN-PROGRESS\)/);
  });

  it("fails open (allows DONE) when listChildren throws", async () => {
    const taskService = makeTaskService({});
    const throwingGraph = {
      listChildren: mock(async () => {
        throw new Error("backend unavailable");
      }),
    };
    await expect(
      assertChildrenCompleteForDone({
        taskId: "mt#9000",
        targetStatus: "DONE",
        taskService,
        taskGraphService: throwingGraph,
      })
    ).resolves.toBeUndefined();
  });

  it("fails open (allows DONE) when getTasks throws", async () => {
    const throwingTaskService = {
      getTasks: mock(async () => {
        throw new Error("db connection lost");
      }),
    } as unknown as TaskServiceInterface;
    await expect(
      assertChildrenCompleteForDone({
        taskId: "mt#9000",
        targetStatus: "DONE",
        taskService: throwingTaskService,
        taskGraphService: makeGraph(["mt#9002"]),
      })
    ).resolves.toBeUndefined();
  });
});

describe("setTaskStatusFromParams facade wires the guard (mt#1649, live MCP/CLI path)", () => {
  it("blocks a parent → DONE with an open child and does not write the status", async () => {
    const taskService = makeTaskService({
      parentStatus: "IN-REVIEW",
      children: [{ id: "mt#9002", status: "IN-PROGRESS" }],
    });
    await expect(
      setTaskStatusFromParams(
        { taskId: "mt#9000", status: "DONE" },
        { taskService, taskGraphService: makeGraph(["mt#9002"]) }
      )
    ).rejects.toThrow(/Cannot set task mt#9000 to DONE/);
    expect(taskService.statusSpy.mock.calls.length).toBe(0);
  });

  it("allows a parent → DONE when all children are terminal", async () => {
    const taskService = makeTaskService({
      parentStatus: "IN-REVIEW",
      children: [{ id: "mt#9002", status: "DONE" }],
    });
    await setTaskStatusFromParams(
      { taskId: "mt#9000", status: "DONE" },
      { taskService, taskGraphService: makeGraph(["mt#9002"]) }
    );
    expect(taskService.statusSpy.mock.calls.length).toBe(1);
    const call = taskService.statusSpy.mock.calls[0] as unknown[];
    expect(call[0]).toBe("mt#9000");
    expect(call[1]).toBe("DONE");
  });

  it("allows a childless task → DONE unaffected", async () => {
    const taskService = makeTaskService({ parentStatus: "IN-REVIEW" });
    await setTaskStatusFromParams(
      { taskId: "mt#9000", status: "DONE" },
      { taskService, taskGraphService: makeGraph([]) }
    );
    expect(taskService.statusSpy.mock.calls.length).toBe(1);
  });
});

describe("pinned regression: mt#1503 fixture (parent IN-REVIEW, PLANNING child) refuses DONE", () => {
  it("refuses DONE naming the PLANNING child, mirroring the mt#1503 incident", async () => {
    const taskService = makeTaskService({
      parentStatus: "IN-REVIEW",
      parentKind: "implementation",
      children: [{ id: "mt#1073", status: "PLANNING" }],
    });
    await expect(
      setTaskStatusFromParams(
        { taskId: "mt#9000", status: "DONE" },
        { taskService, taskGraphService: makeGraph(["mt#1073"]) }
      )
    ).rejects.toThrow(/mt#1073 \(PLANNING\)/);
    expect(taskService.statusSpy.mock.calls.length).toBe(0);
  });
});
