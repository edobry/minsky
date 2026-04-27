/**
 * Regression tests for mt#1378: `session_pr_create` must produce a verifiable
 * receipt for the IN-PROGRESS → IN-REVIEW transition that fires after PR
 * creation, distinguishing skip cases (caller opt-out, no taskId, missing
 * taskService) from attempted-and-failed transitions.
 *
 * Pre-mt#1378 the implementation collapsed all skip/failure paths into a
 * single `log.warn` and a misleading `log.cli("Updated task ...")` that
 * fired even when no update happened — the response had no field reporting
 * the actual outcome, so callers had to call `tasks_status_get` separately
 * to verify the transition succeeded.
 *
 * These tests target `applyInReviewTransition`, the helper extracted from
 * `sessionPrImpl` for direct unit testing. The four spec cases:
 *   (a) successful transition with from=current, to=IN-REVIEW, succeeded=true
 *   (b) noStatusUpdate=true skip with reason matching /skipped/i
 *   (c) missing taskService skip with reason matching /taskService/i
 *   (d) setTaskStatus throw surfaced in reason
 *
 * Plus a source-text regression guard against re-introducing the misleading
 * log line outside the success branch.
 */

import { describe, expect, test } from "bun:test";
/* eslint-disable custom/no-real-fs-in-tests -- intentional source-text assertion; the misleading-log regression check only makes sense against the real file on disk */
import { readFileSync } from "fs";
import { join } from "path";
import { applyInReviewTransition, type StatusTransitionReceipt } from "./session-pr-operations";
import { TASK_STATUS } from "../tasks";
import type { TaskServiceInterface } from "../tasks/taskService";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Minimal TaskServiceInterface stub for the status-transition tests. Only
 * `getTaskStatus` and `setTaskStatus` are exercised; the other methods throw
 * so any unintended call fails loudly.
 */
function makeTaskService(opts: {
  initialStatus?: string;
  setShouldThrow?: Error;
  getShouldThrow?: Error;
}): TaskServiceInterface & {
  setCalls: Array<{ taskId: string; status: string }>;
  getCalls: string[];
} {
  let currentStatus: string | undefined = opts.initialStatus;
  const setCalls: Array<{ taskId: string; status: string }> = [];
  const getCalls: string[] = [];

  return {
    setCalls,
    getCalls,
    async getTaskStatus(taskId: string): Promise<string | undefined> {
      getCalls.push(taskId);
      if (opts.getShouldThrow) throw opts.getShouldThrow;
      return currentStatus;
    },
    async setTaskStatus(taskId: string, status: string): Promise<void> {
      setCalls.push({ taskId, status });
      if (opts.setShouldThrow) throw opts.setShouldThrow;
      currentStatus = status;
    },
    async listTasks() {
      throw new Error("not used");
    },
    async getTask() {
      throw new Error("not used");
    },
    async createTaskFromTitleAndSpec() {
      throw new Error("not used");
    },
    async deleteTask() {
      throw new Error("not used");
    },
    async getTasks() {
      throw new Error("not used");
    },
    async getTaskSpecContent() {
      throw new Error("not used");
    },
    getWorkspacePath() {
      return "/tmp/test-workspace";
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyInReviewTransition (mt#1378)", () => {
  describe("(a) successful transition", () => {
    test("returns succeeded=true with from=current, to=IN-REVIEW", async () => {
      const taskService = makeTaskService({ initialStatus: "IN-PROGRESS" });

      const receipt = await applyInReviewTransition(false, "mt#999", taskService);

      expect(receipt.succeeded).toBe(true);
      expect(receipt.from).toBe("IN-PROGRESS");
      expect(receipt.to).toBe(TASK_STATUS.IN_REVIEW);
      expect(receipt.reason).toBeUndefined();

      // Verify the actual write happened with the right arguments
      expect(taskService.setCalls).toHaveLength(1);
      expect(taskService.setCalls[0]).toEqual({
        taskId: "mt#999",
        status: TASK_STATUS.IN_REVIEW,
      });
      // And the pre-transition read
      expect(taskService.getCalls).toEqual(["mt#999"]);
    });

    test("read failure is non-fatal — write still attempted, from=null in receipt", async () => {
      const taskService = makeTaskService({
        initialStatus: "IN-PROGRESS",
        getShouldThrow: new Error("DB read timed out"),
      });

      const receipt = await applyInReviewTransition(false, "mt#999", taskService);

      expect(receipt.succeeded).toBe(true);
      expect(receipt.from).toBeNull();
      expect(receipt.to).toBe(TASK_STATUS.IN_REVIEW);
      // The write still happened despite the read failure
      expect(taskService.setCalls).toHaveLength(1);
    });
  });

  describe("(b) noStatusUpdate skip", () => {
    test("returns succeeded=false with reason matching /skipped/i and no taskService call", async () => {
      const taskService = makeTaskService({ initialStatus: "IN-PROGRESS" });

      const receipt = await applyInReviewTransition(true, "mt#999", taskService);

      expect(receipt.succeeded).toBe(false);
      expect(receipt.from).toBeNull();
      expect(receipt.to).toBeNull();
      expect(receipt.reason).toMatch(/skipped/i);
      expect(receipt.reason).toContain("noStatusUpdate");

      // No taskService methods should have been called
      expect(taskService.setCalls).toHaveLength(0);
      expect(taskService.getCalls).toHaveLength(0);
    });
  });

  describe("(c) missing taskService skip", () => {
    test("returns succeeded=false with reason matching /taskService/i", async () => {
      const receipt: StatusTransitionReceipt = await applyInReviewTransition(
        false,
        "mt#999",
        undefined
      );

      expect(receipt.succeeded).toBe(false);
      expect(receipt.from).toBeNull();
      expect(receipt.to).toBeNull();
      expect(receipt.reason).toMatch(/taskService/i);
      expect(receipt.reason).toContain("skipped");
    });
  });

  describe("missing taskId skip", () => {
    test("returns succeeded=false with reason naming the missing taskId", async () => {
      const taskService = makeTaskService({ initialStatus: "IN-PROGRESS" });

      const receipt = await applyInReviewTransition(false, undefined, taskService);

      expect(receipt.succeeded).toBe(false);
      expect(receipt.from).toBeNull();
      expect(receipt.to).toBeNull();
      expect(receipt.reason).toMatch(/taskId/i);

      // No taskService methods should have been called
      expect(taskService.setCalls).toHaveLength(0);
      expect(taskService.getCalls).toHaveLength(0);
    });

    test("treats null taskId same as undefined", async () => {
      const taskService = makeTaskService({ initialStatus: "IN-PROGRESS" });

      const receipt = await applyInReviewTransition(false, null, taskService);

      expect(receipt.succeeded).toBe(false);
      expect(receipt.reason).toMatch(/taskId/i);
    });

    test("treats empty-string taskId same as undefined", async () => {
      const taskService = makeTaskService({ initialStatus: "IN-PROGRESS" });

      const receipt = await applyInReviewTransition(false, "", taskService);

      expect(receipt.succeeded).toBe(false);
      expect(receipt.reason).toMatch(/taskId/i);
    });
  });

  describe("(d) setTaskStatus throw surfaced in receipt", () => {
    test("returns succeeded=false with reason naming the thrown error message", async () => {
      const taskService = makeTaskService({
        initialStatus: "IN-PROGRESS",
        setShouldThrow: new Error("Postgres connection refused"),
      });

      const receipt = await applyInReviewTransition(false, "mt#999", taskService);

      expect(receipt.succeeded).toBe(false);
      expect(receipt.from).toBe("IN-PROGRESS"); // pre-transition state was readable
      expect(receipt.to).toBe(TASK_STATUS.IN_REVIEW); // we attempted this transition
      expect(receipt.reason).toContain("setTaskStatus threw");
      expect(receipt.reason).toContain("Postgres connection refused");

      // The write was attempted exactly once (the failure is captured, not retried)
      expect(taskService.setCalls).toHaveLength(1);
    });

    test("does NOT throw — the PR creation flow continues even when status write fails", async () => {
      const taskService = makeTaskService({
        initialStatus: "IN-PROGRESS",
        setShouldThrow: new Error("validation: target status invalid"),
      });

      // The whole point of returning a receipt rather than re-throwing is that
      // the PR was already created on GitHub — the caller still needs the URL
      // and can decide whether to retry the status write separately.
      let didThrow = false;
      try {
        await applyInReviewTransition(false, "mt#999", taskService);
      } catch {
        didThrow = true;
      }
      expect(didThrow).toBe(false);
    });
  });

  describe("precedence ordering", () => {
    test("noStatusUpdate=true beats missing taskService (no taskService call needed)", async () => {
      // When the caller explicitly opted out, we don't even check whether
      // taskService is available — the opt-out is authoritative.
      const receipt = await applyInReviewTransition(true, "mt#999", undefined);
      expect(receipt.reason).toContain("noStatusUpdate");
    });

    test("missing taskId beats missing taskService", async () => {
      // No task to update is a more fundamental skip than "we don't have the
      // tool to update it" — surface the more specific reason.
      const receipt = await applyInReviewTransition(false, undefined, undefined);
      expect(receipt.reason).toMatch(/taskId/i);
      expect(receipt.reason).not.toMatch(/taskService/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Source-text regression guard (mt#1378 acceptance criterion)
// ---------------------------------------------------------------------------

describe("session-pr-operations.ts source guard (mt#1378)", () => {
  test("misleading 'Updated task ... status to IN-REVIEW' log only appears inside applyInReviewTransition success branch", () => {
    // Pre-mt#1378 the log fired unconditionally after the if/else, including
    // on the "No taskService" skip path. The fix moves the log inside the
    // success branch only. This guard asserts there is exactly one
    // occurrence in the file (the one inside applyInReviewTransition's
    // success branch) and that it is preceded by a successful setTaskStatus
    // call rather than by a skip-branch log.warn.
    const source: string = readFileSync(
      join(__dirname, "session-pr-operations.ts"),
      "utf-8"
    ) as string;

    // 1. Exactly one occurrence of the success log line.
    const matches: RegExpMatchArray | null = source.match(
      /Updated task \$\{[^}]+\} status to IN-REVIEW/g
    );
    expect(matches).toHaveLength(1);

    // 2. The success log appears AFTER `await taskService.setTaskStatus(...)`,
    //    not after a skip-branch log.warn.
    const successLogIndex: number = source.indexOf("Updated task ${taskId} status to IN-REVIEW");
    expect(successLogIndex).toBeGreaterThan(-1);

    const before: string = source.slice(0, successLogIndex);
    const lastSetTaskStatusBefore: number = before.lastIndexOf("taskService.setTaskStatus");
    const lastWarnBefore: number = before.lastIndexOf("log.warn");

    // The most recent control-flow event before the log must be the setTaskStatus
    // call, not a log.warn (which would mean the log is on the skip path).
    expect(lastSetTaskStatusBefore).toBeGreaterThan(lastWarnBefore);
  });
});
