/**
 * Tests for GitHub Issues API operations — updateIssueStatus terminal mapping.
 *
 * mt#3032: `updateIssueStatus` carried the same DONE-only close defect just fixed
 * in `github-issues-mapping.ts` (PR #2160, mt#3012): it closed the mirrored GitHub
 * issue only for DONE, so a CLOSED task's status update left the issue open.
 *
 * Applies the mt#2310 RFC projection contract (Notion
 * `3a4937f0-3cb4-81f2-8953-d148a63eba1a`, GitHub Issues backend section) here too:
 *
 * - DONE   -> GitHub issue closed, state_reason "completed"
 * - CLOSED -> GitHub issue closed, state_reason "not_planned"
 * - every non-terminal status -> open, state_reason null
 */

import { describe, test, expect, mock } from "bun:test";
import { updateIssueStatus } from "./github-issues-api";
import { TASK_STATUS } from "./taskConstants";

const STATUS_LABELS: Record<string, string> = {
  TODO: "minsky:todo",
  PLANNING: "minsky:planning",
  READY: "minsky:ready",
  "IN-PROGRESS": "minsky:in-progress",
  "IN-REVIEW": "minsky:in-review",
  DONE: "minsky:done",
  BLOCKED: "minsky:blocked",
  CLOSED: "minsky:closed",
};

/**
 * Build a mock Octokit that echoes back whatever labels the caller asked for,
 * so the read-back verification in updateIssueStatus passes, and captures the
 * arguments passed to `issues.update` for assertion.
 */
function makeMockOctokit() {
  const updateCalls: Array<Record<string, unknown>> = [];

  const octokit = {
    rest: {
      issues: {
        get: mock(() =>
          Promise.resolve({
            data: {
              labels: [{ name: "minsky:todo", color: "d73a4a" }],
            },
          })
        ),
        update: mock((params: Record<string, unknown>) => {
          updateCalls.push(params);
          return Promise.resolve({
            data: {
              labels: (params.labels as string[]).map((name) => ({ name })),
            },
          });
        }),
      },
    },
  };

  return { octokit, updateCalls };
}

describe("updateIssueStatus — terminal-status close mapping (mt#3032)", () => {
  test("DONE closes the issue with state_reason completed", async () => {
    const { octokit, updateCalls } = makeMockOctokit();

    await updateIssueStatus(
      octokit as any,
      "test-owner",
      "test-repo",
      "gh#1",
      TASK_STATUS.DONE,
      STATUS_LABELS
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.state).toBe("closed");
    expect(updateCalls[0]?.state_reason).toBe("completed");
  });

  test("CLOSED closes the issue with state_reason not_planned (mt#3032 regression)", async () => {
    // Before this fix, only DONE closed the mirrored issue — a CLOSED
    // (cancelled/superseded) task left its GitHub issue open indefinitely.
    const { octokit, updateCalls } = makeMockOctokit();

    await updateIssueStatus(
      octokit as any,
      "test-owner",
      "test-repo",
      "gh#1",
      TASK_STATUS.CLOSED,
      STATUS_LABELS
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.state).toBe("closed");
    expect(updateCalls[0]?.state_reason).toBe("not_planned");
  });

  test("a non-terminal status (IN-PROGRESS) leaves the issue open and omits state_reason entirely", async () => {
    // state_reason must be OMITTED (not sent as explicit null) for non-terminal
    // statuses, to exactly preserve prior behavior for open/reopen transitions
    // (reviewer-bot R1 finding: an explicit `state_reason: null` for open states
    // was untested prior behavior and a needless departure from the old payload
    // shape, which never included the field at all).
    const { octokit, updateCalls } = makeMockOctokit();

    await updateIssueStatus(
      octokit as any,
      "test-owner",
      "test-repo",
      "gh#1",
      TASK_STATUS.IN_PROGRESS,
      STATUS_LABELS
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.state).toBe("open");
    expect(updateCalls[0]).not.toHaveProperty("state_reason");
  });

  test("still preserves non-status labels alongside the state fields", async () => {
    const { octokit, updateCalls } = makeMockOctokit();
    octokit.rest.issues.get = mock(() =>
      Promise.resolve({
        data: {
          labels: [
            { name: "minsky:todo", color: "d73a4a" },
            { name: "priority:high", color: "ffffff" },
          ],
        },
      })
    );

    await updateIssueStatus(
      octokit as any,
      "test-owner",
      "test-repo",
      "gh#1",
      TASK_STATUS.DONE,
      STATUS_LABELS
    );

    expect(updateCalls[0]?.labels).toEqual(
      expect.arrayContaining(["priority:high", "minsky:done"])
    );
  });
});
