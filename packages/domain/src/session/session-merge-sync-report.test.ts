/**
 * mt#4381 — the merge path must report whether the post-merge status write LANDED.
 *
 * The defect these tests pin: `applyPostMergeStateSync` detects a failed task-status
 * write and records it in `taskUpdateError` / `partialFailure`, and `mergeSessionPr`
 * discarded both. The caller got `success: true`, full merge metadata, and no field to
 * check — so a task stranded at IN-REVIEW after a real merge was undetectable. Observed
 * live on mt#4373 (PR #3208, merge `59a7b6479`).
 *
 * The discrimination that matters throughout: `taskStatusUpdated: false` means EITHER
 * "already at the terminal status" OR "the write was attempted and failed", and only the
 * error field separates them. Every test below that asserts one asserts the other too.
 */

import { describe, test, expect } from "bun:test";
import type { PostMergeStateSyncResult } from "./session-merge-status-sync";
import { buildMergeSyncReport, classifyTaskSyncOutcome } from "./session-merge-sync-report";

const SESSION_ID = "session-4381";
const TASK_ID = "mt#4381";

/**
 * A sync result in its default (happy) shape. Overrides express the case under test, so
 * each test reads as its own delta rather than repeating eight fields.
 */
function syncResult(overrides: Partial<PostMergeStateSyncResult> = {}): PostMergeStateSyncResult {
  return {
    sessionId: SESSION_ID,
    taskId: TASK_ID,
    taskStatusUpdated: true,
    taskTerminalStatus: "DONE",
    sessionStatusUpdated: true,
    pullRequestRecordUpdated: true,
    partialFailure: false,
    ...overrides,
  } as PostMergeStateSyncResult;
}

describe("AT1 — a FAILED task-status write is reported, not swallowed (mt#4381)", () => {
  // The negative control in fixture form: this is the exact state the live mt#4373
  // stranding produced — the merge landed, the status write did not.
  const failed = syncResult({
    taskStatusUpdated: false,
    taskUpdateError: "PersistenceService not initialized. Call initialize() first.",
    partialFailure: true,
  });

  test("classifies as write-failed, NOT already-terminal", () => {
    expect(classifyTaskSyncOutcome(failed)).toBe("write-failed");
  });

  test("propagates partialFailure and the underlying error to the caller", () => {
    const { fields } = buildMergeSyncReport(failed);

    expect(fields.partialFailure).toBe(true);
    expect(fields.taskUpdateError).toBe(
      "PersistenceService not initialized. Call initialize() first."
    );
    // The flag alone is the trap: false here is TRUE of the no-op case too.
    expect(fields.taskStatusUpdated).toBe(false);
  });

  test("does NOT print 'already marked as' — that exact mis-report is the defect", () => {
    const { lines } = buildMergeSyncReport(failed);
    const joined = lines.join("\n");

    expect(joined).not.toContain("already marked as");
    expect(joined).toContain("NOT updated");
    expect(joined).toContain("PersistenceService not initialized");
  });
});

describe("AT2 — the happy path still reports success (mt#4381)", () => {
  test("classifies as updated and carries partialFailure false", () => {
    const report = buildMergeSyncReport(syncResult());

    expect(report.outcome).toBe("updated");
    expect(report.fields.partialFailure).toBe(false);
    expect(report.fields.taskStatusUpdated).toBe(true);
    expect(report.fields.taskUpdateError).toBeUndefined();
    expect(report.lines.join("\n")).toContain("Task status updated to DONE");
  });
});

describe("AT3 — 'already terminal' stays distinguishable from 'failed' (mt#4381)", () => {
  // Asserted separately from AT1 on purpose: both have taskStatusUpdated false, and
  // collapsing them is the whole defect. If a future change makes these two produce the
  // same outcome, exactly one of AT1/AT3 fails — which is the signal.
  const noop = syncResult({ taskStatusUpdated: false, partialFailure: false });

  test("classifies as already-terminal", () => {
    expect(classifyTaskSyncOutcome(noop)).toBe("already-terminal");
  });

  test("reports no failure, and says so in the CLI line", () => {
    const report = buildMergeSyncReport(noop);

    expect(report.fields.partialFailure).toBe(false);
    expect(report.fields.taskUpdateError).toBeUndefined();
    expect(report.lines.join("\n")).toContain("already marked as DONE");
  });

  test("the two false-flag cases do NOT classify the same", () => {
    const failed = syncResult({
      taskStatusUpdated: false,
      taskUpdateError: "boom",
      partialFailure: true,
    });

    expect(classifyTaskSyncOutcome(noop)).not.toBe(classifyTaskSyncOutcome(failed));
  });
});

describe("AT4 — the CLI surface renders all three outcomes distinctly (mt#4381)", () => {
  test("each outcome produces a different leading line", () => {
    const updated = buildMergeSyncReport(syncResult()).lines[0];
    const already = buildMergeSyncReport(syncResult({ taskStatusUpdated: false })).lines[0];
    const failed = buildMergeSyncReport(
      syncResult({ taskStatusUpdated: false, taskUpdateError: "boom", partialFailure: true })
    ).lines[0];

    expect(new Set([updated, already, failed]).size).toBe(3);
  });

  test("a session-record failure is reported alongside the task outcome", () => {
    const { lines } = buildMergeSyncReport(
      syncResult({ sessionUpdateError: "session write failed", partialFailure: true })
    );

    expect(lines.join("\n")).toContain("Session record NOT updated: session write failed");
  });

  test("a merge with no bound task prints no task line", () => {
    const report = buildMergeSyncReport(
      syncResult({ taskId: undefined, taskStatusUpdated: false, taskTerminalStatus: undefined })
    );

    expect(report.outcome).toBe("no-task");
    expect(report.lines.join("\n")).not.toContain("Task status");
    expect(report.lines.join("\n")).not.toContain("already marked as");
  });
});

describe("cleanup lines are preserved (mt#4381 is additive, SC5)", () => {
  test("directories-removed and cleanup-error lines still render", () => {
    const { lines } = buildMergeSyncReport(
      syncResult({
        sessionCleanup: { performed: true, directoriesRemoved: ["/a", "/b"], errors: ["oops"] },
      })
    );
    const joined = lines.join("\n");

    expect(joined).toContain("Cleaned up 2 session directories");
    expect(joined).toContain("1 cleanup errors occurred");
  });
});
