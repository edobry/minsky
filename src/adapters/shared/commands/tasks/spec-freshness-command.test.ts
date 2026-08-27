/**
 * Baseline-selection tests for `tasks.spec.freshness` (mt#4415).
 *
 * These exercise the COMMAND, not the detection core, because the core was
 * never wrong: `checkSpecFreshness` compares whatever baseline it is handed.
 * The defect was entirely in WHICH timestamp the command handed it — the
 * tasks-table row `updatedAt`, which ANY mutation bumps, instead of the
 * spec-CONTENT timestamp. A test that injects a baseline directly into the core
 * cannot fail against the un-fixed tree, so it would not be a control at all.
 *
 * The changeset resolver is INJECTED rather than patched (`spyOn` on a module
 * import would be the alternative). None of these specs cite a PR, so the
 * resolver is never called — but before mt#4415 the changeset service was
 * still CONSTRUCTED unconditionally, which required a resolvable repo and made
 * this seam untestable offline.
 */
import { describe, test, expect } from "bun:test";
import { createTasksSpecFreshnessCommand } from "./spec-freshness-command";
import type { CommandExecutionContext } from "../../command-registry";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { Task } from "@minsky/domain/tasks/types";

const CITING_TASK = "mt#4342";
const REF_TASK = "mt#4338";

const SPEC_CITING_REF = `## Summary\n\nSequencing depends on ${REF_TASK}, which is IN-REVIEW.\n`;

interface FakeServiceOptions {
  /** The spec-CONTENT timestamp (`task_specs.updated_at`). Omit to model a backend that tracks none. */
  specUpdatedAt?: Date;
  /**
   * The spec AUTHORING timestamp (`task_specs.created_at`) — the drift floor
   * (mt#4420). Omit to model a backend that tracks none, which degrades the
   * check to the pre-mt#4420 last-edit comparison.
   */
  specCreatedAt?: Date;
  /** The tasks-table row timestamp — bumped by any status transition. */
  taskRowUpdatedAt: Date;
  refStatus: string;
  refUpdatedAt: Date;
  specContent?: string;
}

function makeTaskService(opts: FakeServiceOptions): TaskServiceInterface {
  const citingTask = {
    id: CITING_TASK,
    title: "citing task",
    status: "PLANNING",
    updatedAt: opts.taskRowUpdatedAt,
  } as unknown as Task;

  const refTask = {
    id: REF_TASK,
    title: "referenced task",
    status: opts.refStatus,
    updatedAt: opts.refUpdatedAt,
  } as unknown as Task;

  return {
    getTask: async (taskId: string) => {
      if (taskId === CITING_TASK) return citingTask;
      if (taskId === REF_TASK) return refTask;
      return null;
    },
    getTaskSpecContent: async () => ({
      task: citingTask,
      specPath: "",
      content: opts.specContent ?? SPEC_CITING_REF,
      specUpdatedAt: opts.specUpdatedAt,
      specCreatedAt: opts.specCreatedAt,
    }),
  } as unknown as TaskServiceInterface;
}

async function runFreshness(opts: FakeServiceOptions) {
  const taskService = makeTaskService(opts);
  const command = createTasksSpecFreshnessCommand(
    undefined,
    () => taskService,
    // Asserts as a side effect that no PR lookup is needed for these specs:
    // if the command ever calls it, the thrown error fails the test loudly
    // rather than silently returning "not found".
    async () => {
      throw new Error("changeset lookup must not be reached — no spec here cites a PR");
    }
  );

  const result = await command.execute(
    { taskId: CITING_TASK, json: true } as never,
    {} as CommandExecutionContext
  );

  return result as {
    specUpdatedAt: string | null;
    specCreatedAt: string | null;
    baselineUsed: "spec-authored" | "spec-last-edited" | null;
    checked: boolean;
    hasDrift: boolean;
    drift: Array<{ ref: string; currentStatus: string; precedesLastSpecEdit: boolean }>;
    skipped: Array<{ ref: string; reason: string }>;
    message: string;
  };
}

describe("tasks.spec.freshness baseline selection (mt#4415)", () => {
  test("AT1: a ref that changed before a status transition still reports drift after it", async () => {
    // The spec's text was last written here...
    const specUpdatedAt = new Date("2026-08-19T00:00:00.000Z");
    // ...the cited ref changed AFTER that, so this drift is real...
    const refUpdatedAt = new Date("2026-08-19T20:26:00.000Z");
    // ...and then a status transition bumped the task ROW to ~now.
    const taskRowUpdatedAt = new Date("2026-08-22T00:03:45.758Z");

    // Guard the control itself. The whole point is that the task-row timestamp
    // is LATER than the ref's change: that ordering is what made the old
    // baseline suppress the row. If it ever stops holding, this test would pass
    // against the un-fixed tree too and quietly stop being a control.
    expect(taskRowUpdatedAt.getTime()).toBeGreaterThan(refUpdatedAt.getTime());
    expect(refUpdatedAt.getTime()).toBeGreaterThan(specUpdatedAt.getTime());

    const result = await runFreshness({
      specUpdatedAt,
      taskRowUpdatedAt,
      refStatus: "DONE",
      refUpdatedAt,
    });

    expect(result.checked).toBe(true);
    expect(result.hasDrift).toBe(true);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toMatchObject({ ref: REF_TASK, currentStatus: "DONE" });
    // The baseline reported back is the spec-content timestamp, not the row's.
    expect(result.specUpdatedAt).toBe(specUpdatedAt.toISOString());
  });

  test("AT2: refs that genuinely have not changed still report no drift after a transition", async () => {
    const specUpdatedAt = new Date("2026-08-19T00:00:00.000Z");
    // The ref last changed BEFORE the spec was written — nothing to report.
    const refUpdatedAt = new Date("2026-08-18T09:00:00.000Z");
    const taskRowUpdatedAt = new Date("2026-08-22T00:03:45.758Z");

    const result = await runFreshness({
      specUpdatedAt,
      taskRowUpdatedAt,
      refStatus: "IN-REVIEW",
      refUpdatedAt,
    });

    // Checked and clean — distinct from AT4's not-checked case below.
    expect(result.checked).toBe(true);
    expect(result.hasDrift).toBe(false);
    expect(result.drift).toHaveLength(0);
    expect(result.message).toContain("No drift");
  });

  test("AT3: replay of the observed case — mt#4342's spec citing mt#4338", async () => {
    // The exact shape recorded in mt#4415: `tasks_status_set` (TODO → PLANNING)
    // and `tasks_spec_freshness` ran in the same turn at 00:03:45.758Z, and the
    // check returned hasDrift: false while mt#4338 had been DONE for three days.
    const specUpdatedAt = new Date("2026-08-18T22:00:00.000Z");
    const refWentDoneAt = new Date("2026-08-19T20:26:00.000Z");
    const statusTransitionAt = new Date("2026-08-22T00:03:45.758Z");

    const result = await runFreshness({
      specUpdatedAt,
      taskRowUpdatedAt: statusTransitionAt,
      refStatus: "DONE",
      refUpdatedAt: refWentDoneAt,
    });

    expect(result.hasDrift).toBe(true);
    expect(result.drift[0]).toMatchObject({ ref: REF_TASK, currentStatus: "DONE" });
    // Three days of real drift, which the old baseline reported as zero.
    expect(result.specUpdatedAt).toBe(specUpdatedAt.toISOString());
  });

  test("AT4: a backend tracking no spec-content timestamp reports not-checked, not a clean pass", async () => {
    const result = await runFreshness({
      specUpdatedAt: undefined,
      taskRowUpdatedAt: new Date("2026-08-22T00:03:45.758Z"),
      refStatus: "DONE",
      refUpdatedAt: new Date("2026-08-19T20:26:00.000Z"),
    });

    expect(result.checked).toBe(false);
    expect(result.specUpdatedAt).toBeNull();
    // hasDrift is still false — which is exactly why `checked` has to be read
    // first. A consumer looking only at hasDrift cannot tell these apart.
    expect(result.hasDrift).toBe(false);
    expect(result.message).toContain("NOT CHECKED");
    expect(result.message).not.toContain("No drift");
    expect(result.skipped).toEqual([
      {
        ref: "*",
        reason:
          "no spec-content timestamp for this task's backend — no baseline to compare against, so no refs were checked",
      },
    ]);
  });

  test("the task-row timestamp is not consulted, even when it is the only one present", async () => {
    // A spec-content timestamp of `undefined` must NOT silently fall back to
    // the row timestamp: that fallback is the defect, and it would turn AT4
    // back into a clean pass.
    const result = await runFreshness({
      specUpdatedAt: undefined,
      taskRowUpdatedAt: new Date("2026-08-01T00:00:00.000Z"), // old enough that the ref WOULD drift
      refStatus: "DONE",
      refUpdatedAt: new Date("2026-08-19T20:26:00.000Z"),
    });

    expect(result.checked).toBe(false);
    expect(result.drift).toHaveLength(0);
  });
});

/**
 * mt#4420 — the command must hand the core the AUTHORING timestamp too.
 *
 * These live at the command seam for the same reason the mt#4415 block above
 * does: the core compares whatever floor it is handed, so a test that injects
 * one directly cannot fail against the un-fixed tree. What was wrong is WHICH
 * timestamps the command reads off the spec row, and that is only observable
 * here.
 *
 * Timeline shared by this block:
 *
 *   AUTHORED 08-20 ──── ref goes DONE 08-22 ──── spec EDITED 08-26
 */
describe("tasks.spec.freshness reports drift predating the caller's own edit (mt#4420)", () => {
  const AUTHORED = new Date("2026-08-20T00:00:00.000Z");
  const REF_WENT_DONE = new Date("2026-08-22T00:00:00.000Z");
  const SPEC_EDITED = new Date("2026-08-26T00:00:00.000Z");

  test("AT1: drift that predates the last spec edit is reported, and marked as predating it", async () => {
    // Guard the control itself, as the mt#4415 block does above: the ref must
    // have changed BEFORE the last edit and AFTER authoring. If that ordering
    // ever stops holding, this test would pass against the un-fixed tree and
    // silently stop being a control.
    expect(REF_WENT_DONE.getTime()).toBeGreaterThan(AUTHORED.getTime());
    expect(SPEC_EDITED.getTime()).toBeGreaterThan(REF_WENT_DONE.getTime());

    const result = await runFreshness({
      specUpdatedAt: SPEC_EDITED,
      specCreatedAt: AUTHORED,
      taskRowUpdatedAt: SPEC_EDITED,
      refStatus: "DONE",
      refUpdatedAt: REF_WENT_DONE,
    });

    expect(result.checked).toBe(true);
    expect(result.hasDrift).toBe(true);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toMatchObject({
      ref: REF_TASK,
      currentStatus: "DONE",
      precedesLastSpecEdit: true,
    });
    expect(result.baselineUsed).toBe("spec-authored");
    expect(result.specCreatedAt).toBe(AUTHORED.toISOString());
  });

  test("the message names the baseline and calls out the drift the last editor may not have seen", async () => {
    const result = await runFreshness({
      specUpdatedAt: SPEC_EDITED,
      specCreatedAt: AUTHORED,
      taskRowUpdatedAt: SPEC_EDITED,
      refStatus: "DONE",
      refUpdatedAt: REF_WENT_DONE,
    });

    // The old message said "changed state after the spec content was last
    // edited", which for this row is simply false — it changed before.
    expect(result.message).toContain("since the spec was authored");
    expect(result.message).toContain("1 of them BEFORE the spec was last edited");
    expect(result.message).not.toContain("No drift");
  });

  test("AT3: a ref last changed before authoring is still not reported (no new false positives)", async () => {
    const result = await runFreshness({
      specUpdatedAt: SPEC_EDITED,
      specCreatedAt: AUTHORED,
      taskRowUpdatedAt: SPEC_EDITED,
      refStatus: "IN-REVIEW",
      refUpdatedAt: new Date("2026-08-19T00:00:00.000Z"), // before AUTHORED
    });

    expect(result.checked).toBe(true);
    expect(result.hasDrift).toBe(false);
    expect(result.drift).toHaveLength(0);
    expect(result.baselineUsed).toBe("spec-authored");
  });

  test("a clean pass on the degraded baseline says so rather than reading as the full check", async () => {
    // No authoring timestamp: the 08-22 drift sits below the 08-26 baseline and
    // is invisible, exactly as before mt#4420. The result must not render that
    // as an unqualified clean pass — this is the reporting half of the defect.
    const result = await runFreshness({
      specUpdatedAt: SPEC_EDITED,
      specCreatedAt: undefined,
      taskRowUpdatedAt: SPEC_EDITED,
      refStatus: "DONE",
      refUpdatedAt: REF_WENT_DONE,
    });

    expect(result.checked).toBe(true);
    expect(result.hasDrift).toBe(false);
    expect(result.baselineUsed).toBe("spec-last-edited");
    expect(result.message).toContain("NO authoring timestamp");
    expect(result.message).toContain("Weaker than a clean pass");
  });
});
