/**
 * Regression tests: findings-gated DONE for state-ops tasks (mt#455).
 *
 * A state-ops task's deliverable IS its findings — so ANY transition to DONE
 * on a state-ops task requires a populated closeout-evidence section
 * (`## Closeout evidence`, `## Findings`, or `## Outcome`), not just the
 * classic READY → DONE external-deliverable path. Exercised through the live
 * `setTaskStatusFromParams` facade (the `@minsky/domain/tasks` barrel target —
 * the MCP/CLI path).
 */

import { describe, it, expect, mock } from "bun:test";
import { setTaskStatusFromParams } from "../tasks";
import type { TaskServiceInterface } from "./taskService";

function makeTaskService(opts: {
  kind?: string;
  status?: string;
  spec?: string;
}): TaskServiceInterface & { statusSpy: ReturnType<typeof mock> } {
  const statusSpy = mock(async () => {});
  const service = {
    getTask: mock(async () => ({
      id: "mt#9100",
      title: "Investigation task",
      status: opts.status ?? "IN-PROGRESS",
      kind: opts.kind ?? "state-ops",
      backend: "minsky",
    })),
    getTaskSpecContent: mock(async () => ({
      task: null,
      specPath: "",
      content: opts.spec ?? "",
    })),
    getTasks: mock(async () => []),
    setTaskStatus: statusSpy,
    listBackends: () => [],
    statusSpy,
  } as unknown as TaskServiceInterface & { statusSpy: ReturnType<typeof mock> };
  return service;
}

describe("state-ops findings-gated DONE (mt#455)", () => {
  it("refuses state-ops IN-PROGRESS → DONE without a closeout-evidence section", async () => {
    const taskService = makeTaskService({
      spec: "## Summary\nInvestigate the thing.\n",
    });
    await expect(
      setTaskStatusFromParams({ taskId: "mt#9100", status: "DONE" }, { taskService })
    ).rejects.toThrow(/Findings/);
    expect(taskService.statusSpy.mock.calls.length).toBe(0);
  });

  it("allows state-ops IN-PROGRESS → DONE with a populated ## Findings section", async () => {
    const taskService = makeTaskService({
      spec: "## Summary\nInvestigate.\n\n## Findings\nRoot cause identified: X.\n",
    });
    await setTaskStatusFromParams({ taskId: "mt#9100", status: "DONE" }, { taskService });
    expect(taskService.statusSpy.mock.calls.length).toBe(1);
    const call = taskService.statusSpy.mock.calls[0] as unknown[];
    expect(call[1]).toBe("DONE");
  });

  it("allows state-ops IN-PROGRESS → DONE with a populated ## Outcome section", async () => {
    const taskService = makeTaskService({
      spec: "## Outcome\nDecision recorded; no code change needed.\n",
    });
    await setTaskStatusFromParams({ taskId: "mt#9100", status: "DONE" }, { taskService });
    expect(taskService.statusSpy.mock.calls.length).toBe(1);
  });

  it("accepts ## Outcome as a synonym on the classic implementation READY → DONE path", async () => {
    const taskService = makeTaskService({
      kind: "implementation",
      status: "READY",
      spec: "## Outcome\nPublished to Notion: https://example.com/page\n",
    });
    await setTaskStatusFromParams({ taskId: "mt#9100", status: "DONE" }, { taskService });
    expect(taskService.statusSpy.mock.calls.length).toBe(1);
  });

  it("reports invalid transitions as such, not as missing evidence (guard ordering, PR #1937 R1)", async () => {
    // state-ops TODO → DONE is illegal (TODO → PLANNING/CLOSED only). The error
    // must be the invalid-transition one — the evidence gate runs after
    // validateStatusTransition and must not mask it.
    const taskService = makeTaskService({
      status: "TODO",
      spec: "## Summary\nNo evidence.\n",
    });
    await expect(
      setTaskStatusFromParams({ taskId: "mt#9100", status: "DONE" }, { taskService })
    ).rejects.toThrow(/Cannot transition from TODO to DONE/);
    expect(taskService.statusSpy.mock.calls.length).toBe(0);
  });

  it("does not evidence-gate non-DONE state-ops transitions", async () => {
    const taskService = makeTaskService({
      status: "READY",
      spec: "## Summary\nNo evidence yet.\n",
    });
    await setTaskStatusFromParams({ taskId: "mt#9100", status: "IN-PROGRESS" }, { taskService });
    expect(taskService.statusSpy.mock.calls.length).toBe(1);
  });
});
