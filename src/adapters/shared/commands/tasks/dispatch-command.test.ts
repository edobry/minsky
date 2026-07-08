/**
 * Evidence-gate tests for tasks_dispatch (mt#2488).
 *
 * Verifies the tool-boundary evidence gate: a dispatch whose premise is not well-formed
 * is BLOCKED before any side effect; a dispatch with a well-formed premise passes the
 * gate. The deps are throwing stubs — on an env without native subagent support the gate
 * passes straight to the harness check (no dep touched); on an env WITH support it reaches
 * a stub. Either way the assertion is that the failure (if any) is NOT an evidence-gate
 * error, i.e. the gate let it through.
 *
 * This is environment-AGNOSTIC by construction (NOT environment-sensitive): the assertions
 * hold regardless of what `hasNativeSubagentSupport()` returns in this env. `mock.module`
 * is deliberately avoided — bun runs test files in one shared process, so a module mock of
 * harness-detection could leak into sibling test files that rely on the real implementation.
 */
import { describe, test, expect } from "bun:test";
import { createTasksDispatchCommand } from "./dispatch-command";
import { ValidationError } from "@minsky/domain/errors";

const throwingDep = () => {
  throw new Error("dispatch dependency should not be reached in this test");
};

function makeCommand() {
  return createTasksDispatchCommand(
    throwingDep as never,
    throwingDep as never,
    throwingDep as never,
    throwingDep as never
  );
}

const validPremise = {
  premiseClaim: "cold-start-migrate is red because of this PR's new init slug-stamping",
  premiseFalsifier: "check whether the same check is red on main and other open branches",
  premiseEvidence: "forge_check_runs_list <main-sha> shows it red on main too — not this PR",
};

const EVIDENCE_ERROR = /evidence argument|not well-formed/;

describe("tasks_dispatch evidence gate (mt#2488)", () => {
  test("blocks a dispatch with an absent premise", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({ title: "t", instructions: "i", type: "implementation" } as never)
    ).rejects.toThrow(ValidationError);
  });

  test("blocks a dispatch whose premise fields are empty", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        title: "t",
        instructions: "i",
        type: "implementation",
        premiseClaim: "",
        premiseFalsifier: "",
        premiseEvidence: "",
      } as never)
    ).rejects.toThrow(EVIDENCE_ERROR);
  });

  test("blocks a dispatch whose premise is below the substance floor", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        title: "t",
        instructions: "i",
        type: "implementation",
        premiseClaim: "ok",
        premiseFalsifier: "ok",
        premiseEvidence: "ok",
      } as never)
    ).rejects.toThrow(EVIDENCE_ERROR);
  });

  test("a well-formed premise passes the evidence gate", async () => {
    const cmd = makeCommand();
    let caught: unknown;
    let result: unknown;
    try {
      result = await cmd.execute({
        title: "t",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never);
    } catch (err) {
      caught = err;
    }
    // The gate let it through: any failure past it is a harness/dep concern, NOT an
    // evidence-gate ValidationError.
    if (caught !== undefined) {
      expect((caught as Error).message).not.toMatch(EVIDENCE_ERROR);
    } else {
      expect(result).toBeDefined();
    }
  });
});

/**
 * Mode-selection tests for the existing-taskId dispatch mode (mt#2657).
 *
 * `validateDispatchMode` runs right after the evidence gate and before the harness check, so —
 * like the evidence gate tests above — these assertions are deterministic regardless of what
 * `hasNativeSubagentSupport()` returns in this environment.
 */
const MODE_ERROR =
  /requires either `taskId`|are mutually exclusive|only applies to new-task creation/;

describe("tasks_dispatch mode selection (mt#2657)", () => {
  test("blocks when neither taskId nor title is provided", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never)
    ).rejects.toThrow(MODE_ERROR);
  });

  // R1 review fix (PR #1837 review 4651483333): both taskId and title were previously
  // accepted together — taskId silently won, ignoring title. Now rejected outright.
  test("blocks when both taskId and title are provided", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        taskId: "mt#2657",
        title: "t",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never)
    ).rejects.toThrow(/mutually exclusive/);
  });

  test("blocks when both taskId and parentTaskId are provided", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        taskId: "mt#2657",
        parentTaskId: "mt#1",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never)
    ).rejects.toThrow(MODE_ERROR);
  });

  // R1 review fix (PR #1837 review 4651474893): description was previously silently
  // ignored in existing-task mode, risking operator confusion. Now rejected outright.
  test("blocks when both taskId and description are provided", async () => {
    const cmd = makeCommand();
    await expect(
      cmd.execute({
        taskId: "mt#2657",
        description: "spec content",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never)
    ).rejects.toThrow(/only applies to new-task creation/);
  });

  test("title-only (no taskId) passes mode selection unaffected (backward compat)", async () => {
    const cmd = makeCommand();
    let caught: unknown;
    let result: unknown;
    try {
      result = await cmd.execute({
        title: "t",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never);
    } catch (err) {
      caught = err;
    }
    if (caught !== undefined) {
      expect((caught as Error).message).not.toMatch(MODE_ERROR);
    } else {
      expect(result).toBeDefined();
    }
  });

  test("taskId-only (existing-task mode) passes mode selection", async () => {
    const cmd = makeCommand();
    let caught: unknown;
    let result: unknown;
    try {
      result = await cmd.execute({
        taskId: "mt#2657",
        instructions: "i",
        type: "implementation",
        ...validPremise,
      } as never);
    } catch (err) {
      caught = err;
    }
    // The mode gate let it through: any failure past it is a harness/dep concern (the deps are
    // throwing stubs), NOT a mode-selection ValidationError.
    if (caught !== undefined) {
      expect((caught as Error).message).not.toMatch(MODE_ERROR);
    } else {
      expect(result).toBeDefined();
    }
  });
});
