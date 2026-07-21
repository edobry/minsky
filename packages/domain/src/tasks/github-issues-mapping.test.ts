/**
 * Tests for GitHub Issues task backend mapping/conversion utilities.
 *
 * mt#3012: verifies the projection contract defined by the mt#2310 RFC
 * (GitHub Issues backend section, Notion `3a4937f0-3cb4-81f2-8953-d148a63eba1a`):
 *
 * - DONE   -> GitHub issue closed, state_reason "completed"
 * - CLOSED -> GitHub issue closed, state_reason "not_planned"
 * - every non-terminal status -> open, state_reason null
 *
 * Before this fix, `convertTaskDataToIssueFormat` only closed the mirrored
 * GitHub issue for DONE — a task cancelled/superseded via CLOSED left its
 * issue open indefinitely.
 *
 * Also verifies the reverse mapping (`getTaskStatusFromIssue`) tolerates any
 * `state_reason` value — including ones GitHub added after this code was
 * written (e.g. `duplicate`, added Dec 2024) — without throwing.
 */

import { describe, test, expect } from "bun:test";
import {
  convertTaskDataToIssueFormat,
  getIssueStateForTaskStatus,
  getTaskStatusFromIssue,
} from "./github-issues-mapping";
import { TASK_STATUS, TaskStatus } from "./taskConstants";
import type { TaskData } from "../../../../src/types/tasks/taskData";

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

const NON_TERMINAL_STATUSES: TaskStatus[] = [
  TaskStatus.TODO,
  TaskStatus.PLANNING,
  TaskStatus.READY,
  TaskStatus.IN_PROGRESS,
  TaskStatus.IN_REVIEW,
  TaskStatus.BLOCKED,
];

function makeTask(status: TaskStatus): TaskData {
  return {
    id: "gh#1",
    title: "Test task",
    spec: "body",
    status,
    tags: [],
  };
}

describe("getIssueStateForTaskStatus — projection contract (mt#2310 RFC)", () => {
  test("DONE maps to closed + state_reason completed", () => {
    expect(getIssueStateForTaskStatus(TaskStatus.DONE)).toEqual({
      state: "closed",
      state_reason: "completed",
    });
  });

  test("CLOSED maps to closed + state_reason not_planned", () => {
    expect(getIssueStateForTaskStatus(TaskStatus.CLOSED)).toEqual({
      state: "closed",
      state_reason: "not_planned",
    });
  });

  for (const status of NON_TERMINAL_STATUSES) {
    test(`${status} maps to open + state_reason null`, () => {
      expect(getIssueStateForTaskStatus(status)).toEqual({
        state: "open",
        state_reason: null,
      });
    });
  }
});

describe("convertTaskDataToIssueFormat — projection contract (mt#2310 RFC)", () => {
  test("DONE task closes the issue with state_reason completed", () => {
    const result = convertTaskDataToIssueFormat(makeTask(TaskStatus.DONE), STATUS_LABELS);
    expect(result.state).toBe("closed");
    expect(result.state_reason).toBe("completed");
  });

  test("CLOSED task closes the issue with state_reason not_planned (mt#3012 regression)", () => {
    // Before mt#3012, only DONE closed the mirrored issue — a CLOSED
    // (cancelled/superseded) task left its GitHub issue open indefinitely.
    const result = convertTaskDataToIssueFormat(makeTask(TaskStatus.CLOSED), STATUS_LABELS);
    expect(result.state).toBe("closed");
    expect(result.state_reason).toBe("not_planned");
  });

  for (const status of NON_TERMINAL_STATUSES) {
    test(`${status} task leaves the issue open`, () => {
      const result = convertTaskDataToIssueFormat(makeTask(status), STATUS_LABELS);
      expect(result.state).toBe("open");
      expect(result.state_reason).toBeNull();
    });
  }

  test("still includes title, body, and labels alongside state fields", () => {
    const result = convertTaskDataToIssueFormat(makeTask(TaskStatus.DONE), STATUS_LABELS);
    expect(result.title).toBe("Test task");
    expect(result.body).toBe("body");
    expect(result.labels).toEqual(["minsky:done"]);
  });
});

describe("getTaskStatusFromIssue — reverse mapping tolerance (mt#3012)", () => {
  test("a matching status label takes priority over state/state_reason", () => {
    const status = getTaskStatusFromIssue(
      { labels: ["minsky:done"], state: "closed", state_reason: "not_planned" },
      STATUS_LABELS
    );
    expect(status).toBe(TASK_STATUS.DONE);
  });

  test("falls back to DONE for a closed issue with state_reason completed and no matching label", () => {
    const status = getTaskStatusFromIssue(
      { labels: [], state: "closed", state_reason: "completed" },
      STATUS_LABELS
    );
    expect(status).toBe(TASK_STATUS.DONE);
  });

  test("falls back to CLOSED for a closed issue with state_reason not_planned and no matching label", () => {
    const status = getTaskStatusFromIssue(
      { labels: [], state: "closed", state_reason: "not_planned" },
      STATUS_LABELS
    );
    expect(status).toBe(TASK_STATUS.CLOSED);
  });

  test("tolerates an unrecognized state_reason value without throwing (GitHub's Dec 2024 `duplicate` addition)", () => {
    expect(() =>
      getTaskStatusFromIssue(
        { labels: [], state: "closed", state_reason: "duplicate" },
        STATUS_LABELS
      )
    ).not.toThrow();

    const status = getTaskStatusFromIssue(
      { labels: [], state: "closed", state_reason: "duplicate" },
      STATUS_LABELS
    );
    expect(status).toBe(TASK_STATUS.CLOSED);
  });

  test("tolerates a null state_reason on a closed issue without throwing", () => {
    const status = getTaskStatusFromIssue(
      { labels: [], state: "closed", state_reason: null },
      STATUS_LABELS
    );
    expect(status).toBe(TASK_STATUS.CLOSED);
  });

  test("falls back to TODO for an open issue with no matching label", () => {
    const status = getTaskStatusFromIssue(
      { labels: [], state: "open", state_reason: null },
      STATUS_LABELS
    );
    expect(status).toBe(TASK_STATUS.TODO);
  });

  test("does not throw and defaults to TODO when state/state_reason are absent entirely", () => {
    expect(() => getTaskStatusFromIssue({ labels: [] }, STATUS_LABELS)).not.toThrow();
    expect(getTaskStatusFromIssue({ labels: [] }, STATUS_LABELS)).toBe(TASK_STATUS.TODO);
  });
});

describe("round trip: task status -> issue format -> task status (mt#3012 acceptance)", () => {
  for (const status of [TaskStatus.DONE, TaskStatus.CLOSED, TaskStatus.IN_PROGRESS]) {
    test(`${status} round trips through convertTaskDataToIssueFormat + getTaskStatusFromIssue`, () => {
      const issueFormat = convertTaskDataToIssueFormat(makeTask(status), STATUS_LABELS);
      const roundTripped = getTaskStatusFromIssue(
        {
          labels: (issueFormat.labels as string[]).map((name) => ({ name })),
          state: issueFormat.state as string,
          state_reason: issueFormat.state_reason as string | null,
        },
        STATUS_LABELS
      );
      expect(roundTripped).toBe(status);
    });
  }
});
