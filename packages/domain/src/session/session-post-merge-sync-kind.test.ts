/**
 * Regression test: applyPostMergeStateSync kind-aware terminal state (mt#1872)
 *
 * Before this fix, the post-merge handler hardcoded `setTaskStatus(taskId, DONE)`.
 * For umbrella-kind tasks (mt#1812) DONE isn't a valid state — the umbrella
 * workflow's terminal is COMPLETED. The validateStatusTransition call inside
 * the persistence layer would throw, the surrounding catch would swallow the
 * error (setting partialFailure), and the task would silently remain in
 * IN-PROGRESS. This is the same failure-class that produced mt#1768.
 *
 * Tests verify:
 *   1. Implementation-kind task at IN-REVIEW → DONE (existing behavior preserved).
 *   2. Umbrella-kind task at IN-PROGRESS → COMPLETED (new dispatch).
 *   3. Already-at-target idempotency: implementation already DONE → no-op.
 *   4. Already-at-target idempotency: umbrella already COMPLETED → no-op.
 *   5. Back-compat: task without `kind` field defaults to implementation behavior.
 */

import { describe, it, expect } from "bun:test";
import {
  applyPostMergeStateSync,
  type PostMergeStateSyncParams,
  type PostMergeStateSyncDeps,
} from "./session-merge-operations";
import { FakeSessionProvider } from "./fake-session-provider";
import { FakeTaskService } from "../tasks/fake-task-service";
import { SessionStatus } from "./types";
import type { SessionRecord } from "./types";
import type { PullRequestInfo } from "./session-db";
import { TASK_STATUS } from "../tasks/taskConstants";

const SESSION_ID = "kind-test-session-zzz";
const TASK_ID = "mt#9999";
const MERGE_SHA = "f00f00";
const MERGED_AT = "2026-05-17T10:00:00.000Z";

function makePR(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 999,
    url: "https://github.com/owner/repo/pull/999",
    state: "open",
    createdAt: "2026-05-17T09:00:00.000Z",
    mergedAt: undefined,
    headBranch: "task/mt-9999",
    baseBranch: "main",
    lastSynced: new Date().toISOString(),
    github: {
      id: 99999,
      nodeId: "PR_test",
      htmlUrl: "https://github.com/owner/repo/pull/999",
      author: "minsky-ai[bot]",
    },
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoName: "owner/repo",
    repoUrl: "https://github.com/owner/repo",
    createdAt: "2026-05-17T09:00:00.000Z",
    taskId: TASK_ID,
    status: SessionStatus.PR_OPEN,
    lastActivityAt: "2026-05-17T09:00:00.000Z",
    pullRequest: makePR(),
    ...overrides,
  };
}

function makeDeps(opts: { kind?: string; initialStatus: string }): PostMergeStateSyncDeps {
  const fakeTask: any = {
    id: TASK_ID,
    title: "Kind dispatch test",
    status: opts.initialStatus,
  };
  if (opts.kind !== undefined) {
    fakeTask.kind = opts.kind;
  }
  return {
    sessionDB: new FakeSessionProvider({ initialSessions: [makeSession()] }),
    taskService: new FakeTaskService({ initialTasks: [fakeTask] }),
  };
}

describe("applyPostMergeStateSync kind-aware terminal state (mt#1872)", () => {
  it("implementation kind at IN-REVIEW → transitions to DONE", async () => {
    const deps = makeDeps({ kind: "implementation", initialStatus: TASK_STATUS.IN_REVIEW });
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      mergeSha: MERGE_SHA,
      mergedAt: MERGED_AT,
      cleanupSession: false,
      trigger: "test",
    };

    const result = await applyPostMergeStateSync(params, deps);

    expect(result.taskStatusUpdated).toBe(true);
    expect(result.taskUpdateError).toBeUndefined();
    const status = await deps.taskService.getTaskStatus(TASK_ID);
    expect(status).toBe(TASK_STATUS.DONE);
  });

  it("umbrella kind at IN-PROGRESS → transitions to COMPLETED (not DONE)", async () => {
    const deps = makeDeps({ kind: "umbrella", initialStatus: TASK_STATUS.IN_PROGRESS });
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      mergeSha: MERGE_SHA,
      mergedAt: MERGED_AT,
      cleanupSession: false,
      trigger: "test",
    };

    const result = await applyPostMergeStateSync(params, deps);

    expect(result.taskStatusUpdated).toBe(true);
    expect(result.taskUpdateError).toBeUndefined();
    expect(result.taskTerminalStatus).toBe(TASK_STATUS.COMPLETED);
    const status = await deps.taskService.getTaskStatus(TASK_ID);
    expect(status).toBe(TASK_STATUS.COMPLETED);
    // Adjacent post-merge effects must remain intact (mergeSha/mergedAt provided):
    // session.status → MERGED and the pullRequest record update both still land.
    expect(result.sessionStatusUpdated).toBe(true);
    expect(result.pullRequestRecordUpdated).toBe(true);
  });

  it("implementation kind already at DONE → idempotent no-op", async () => {
    const deps = makeDeps({ kind: "implementation", initialStatus: TASK_STATUS.DONE });
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      cleanupSession: false,
      trigger: "test",
    };

    const result = await applyPostMergeStateSync(params, deps);

    expect(result.taskStatusUpdated).toBe(false);
    expect(result.taskUpdateError).toBeUndefined();
  });

  it("umbrella kind already at COMPLETED → idempotent no-op", async () => {
    const deps = makeDeps({ kind: "umbrella", initialStatus: TASK_STATUS.COMPLETED });
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      cleanupSession: false,
      trigger: "test",
    };

    const result = await applyPostMergeStateSync(params, deps);

    expect(result.taskStatusUpdated).toBe(false);
    expect(result.taskUpdateError).toBeUndefined();
  });

  it("task without kind field defaults to implementation behavior (back-compat)", async () => {
    const deps = makeDeps({ initialStatus: TASK_STATUS.IN_REVIEW }); // no kind
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      cleanupSession: false,
      trigger: "test",
    };

    const result = await applyPostMergeStateSync(params, deps);

    expect(result.taskStatusUpdated).toBe(true);
    const status = await deps.taskService.getTaskStatus(TASK_ID);
    expect(status).toBe(TASK_STATUS.DONE);
  });
});
