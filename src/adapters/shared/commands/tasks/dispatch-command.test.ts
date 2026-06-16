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
