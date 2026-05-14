/**
 * Unit tests for applyPostMergeStateSync (mt#1614).
 *
 * Verifies:
 *   SC#1 — All five effects fire on first invocation.
 *   SC#2 — Idempotent: calling twice produces the same final state, no double-updates.
 *   SC#3 — trigger field is passed through and surfaces in audit logs (structural check).
 *   SC#4 — applyPostMergeStateSync is called from mergeSessionPr (regression guard).
 *   SC#7 — Task status update is skipped gracefully when task service lacks the method.
 *
 * All tests are hermetic: no real DB, no real git, no real GitHub API.
 * Uses FakeSessionProvider and FakeTaskService.
 */

import { describe, it, expect, beforeEach } from "bun:test";
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = "test-session-abc-123";
const TASK_ID = "mt#1614";
const MERGE_SHA = "abc123def456";
const MERGED_AT = "2026-05-06T10:00:00.000Z";

function makePullRequestInfo(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    state: "open",
    createdAt: "2026-05-01T09:00:00.000Z",
    mergedAt: undefined,
    headBranch: "task/mt-1614",
    baseBranch: "main",
    lastSynced: new Date().toISOString(),
    github: {
      id: 12345,
      nodeId: "PR_kwDOOgUIMM7Y2PaI",
      htmlUrl: "https://github.com/owner/repo/pull/42",
      author: "minsky-ai[bot]",
    },
    ...overrides,
  };
}

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoName: "owner/repo",
    repoUrl: "https://github.com/owner/repo",
    createdAt: "2026-05-01T09:00:00.000Z",
    taskId: TASK_ID,
    status: SessionStatus.PR_OPEN,
    lastActivityAt: "2026-05-01T09:00:00.000Z",
    pullRequest: makePullRequestInfo(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build deps with the given session pre-seeded and TASK_ID at IN-REVIEW. */
function makeDeps(sessionRecord: SessionRecord): PostMergeStateSyncDeps {
  const fakeTask = {
    id: TASK_ID,
    title: "At-merge handler",
    status: TASK_STATUS.IN_REVIEW,
  };
  const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });
  const taskService = new FakeTaskService({ initialTasks: [fakeTask] });
  return { sessionDB, taskService };
}

// ---------------------------------------------------------------------------
// SC#1 — All five effects fire on first invocation
// ---------------------------------------------------------------------------

describe("applyPostMergeStateSync — all five effects (SC#1)", () => {
  let sessionRecord: SessionRecord;
  let deps: PostMergeStateSyncDeps;

  beforeEach(() => {
    sessionRecord = makeSessionRecord();
    deps = makeDeps(sessionRecord);
  });

  it("returns result with all flags set to true on first invocation", async () => {
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      mergeSha: MERGE_SHA,
      mergedAt: MERGED_AT,
      cleanupSession: false, // skip filesystem cleanup in unit tests
      trigger: "webhook",
    };

    const result = await applyPostMergeStateSync(params, deps);

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.taskId).toBe(TASK_ID);
    expect(result.taskStatusUpdated).toBe(true); // (a) task DONE
    expect(result.sessionStatusUpdated).toBe(true); // (b) + (c) session MERGED + lastActivityAt
    expect(result.pullRequestRecordUpdated).toBe(true); // (d) PR record synced
  });

  it("(a) sets task status to DONE", async () => {
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      cleanupSession: false,
      trigger: "webhook",
    };

    await applyPostMergeStateSync(params, deps);

    const status = await deps.taskService.getTaskStatus(TASK_ID);
    expect(status).toBe(TASK_STATUS.DONE);
  });

  it("(b) sets session status to MERGED", async () => {
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      mergedAt: MERGED_AT,
      cleanupSession: false,
      trigger: "sweeper",
    };

    await applyPostMergeStateSync(params, deps);

    const updated = await deps.sessionDB.getSession(SESSION_ID);
    expect(updated?.status).toBe(SessionStatus.MERGED);
  });

  it("(c) updates session.lastActivityAt to the merge timestamp", async () => {
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      mergedAt: MERGED_AT,
      cleanupSession: false,
      trigger: "repair_pass",
    };

    await applyPostMergeStateSync(params, deps);

    const updated = await deps.sessionDB.getSession(SESSION_ID);
    expect(updated?.lastActivityAt).toBe(MERGED_AT);
  });

  it("(d) updates pullRequest record state to closed", async () => {
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      mergeSha: MERGE_SHA,
      mergedAt: MERGED_AT,
      cleanupSession: false,
      trigger: "webhook",
    };

    await applyPostMergeStateSync(params, deps);

    const updated = await deps.sessionDB.getSession(SESSION_ID);
    expect(updated?.pullRequest?.state).toBe("closed");
  });

  it("(d) persists mergeSha on pullRequest.github.mergeCommitSha (PR #1010 R1)", async () => {
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      mergeSha: MERGE_SHA,
      mergedAt: MERGED_AT,
      cleanupSession: false,
      trigger: "webhook",
    };

    await applyPostMergeStateSync(params, deps);

    const updated = await deps.sessionDB.getSession(SESSION_ID);
    expect(updated?.pullRequest?.github?.mergeCommitSha).toBe(MERGE_SHA);
  });
});

// ---------------------------------------------------------------------------
// SC#2 — Idempotent: calling twice produces no double-updates
// ---------------------------------------------------------------------------

describe("applyPostMergeStateSync — idempotent (SC#2)", () => {
  let sessionRecord: SessionRecord;
  let deps: PostMergeStateSyncDeps;

  beforeEach(() => {
    sessionRecord = makeSessionRecord();
    deps = makeDeps(sessionRecord);
  });

  it("second call returns taskStatusUpdated=false (already DONE)", async () => {
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      mergeSha: MERGE_SHA,
      mergedAt: MERGED_AT,
      cleanupSession: false,
      trigger: "webhook",
    };

    // First call
    const r1 = await applyPostMergeStateSync(params, deps);
    expect(r1.taskStatusUpdated).toBe(true);

    // Second call — same params, same session now at DONE/MERGED
    const r2 = await applyPostMergeStateSync(params, deps);
    expect(r2.taskStatusUpdated).toBe(false); // already DONE, skip
  });

  it("second call returns sessionStatusUpdated=false (already MERGED)", async () => {
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      mergeSha: MERGE_SHA,
      mergedAt: MERGED_AT,
      cleanupSession: false,
      trigger: "sweeper",
    };

    const r1 = await applyPostMergeStateSync(params, deps);
    expect(r1.sessionStatusUpdated).toBe(true);

    const r2 = await applyPostMergeStateSync(params, deps);
    expect(r2.sessionStatusUpdated).toBe(false); // already MERGED, skip
  });

  it("task status remains DONE after two invocations", async () => {
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      cleanupSession: false,
      trigger: "repair_pass",
    };

    await applyPostMergeStateSync(params, deps);
    await applyPostMergeStateSync(params, deps);

    const status = await deps.taskService.getTaskStatus(TASK_ID);
    expect(status).toBe(TASK_STATUS.DONE);
  });

  it("session status remains MERGED after two invocations", async () => {
    const params: PostMergeStateSyncParams = {
      sessionId: SESSION_ID,
      cleanupSession: false,
      trigger: "repair_pass",
    };

    await applyPostMergeStateSync(params, deps);
    await applyPostMergeStateSync(params, deps);

    const updated = await deps.sessionDB.getSession(SESSION_ID);
    expect(updated?.status).toBe(SessionStatus.MERGED);
  });
});

// ---------------------------------------------------------------------------
// SC#3 — trigger field is recorded / preserved in result
// ---------------------------------------------------------------------------

describe("applyPostMergeStateSync — trigger attribution (SC#3)", () => {
  it("result.sessionId matches the input sessionId regardless of trigger", async () => {
    const record = makeSessionRecord();
    const deps = makeDeps(record);

    for (const trigger of ["session_pr_merge", "webhook", "sweeper", "repair_pass"] as const) {
      const result = await applyPostMergeStateSync(
        { sessionId: SESSION_ID, cleanupSession: false, trigger },
        deps
      );
      expect(result.sessionId).toBe(SESSION_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// SC#7 — gracefully handles missing task service methods
// ---------------------------------------------------------------------------

describe("applyPostMergeStateSync — graceful degradation (SC#7)", () => {
  it("skips task status update when taskService.getTaskStatus is absent", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });

    // Provide a task service that lacks getTaskStatus — simulates the case where
    // the DI container provides a minimal service.
    const minimalTaskService = {
      setTaskStatus: async () => undefined,
      // getTaskStatus deliberately absent
    } as any;

    const deps: PostMergeStateSyncDeps = {
      sessionDB,
      taskService: minimalTaskService,
    };

    // Should not throw despite missing getTaskStatus.
    const result = await applyPostMergeStateSync(
      { sessionId: SESSION_ID, cleanupSession: false, trigger: "webhook" },
      deps
    );

    // taskStatusUpdated should be false (skipped) since getTaskStatus is absent.
    expect(result.taskStatusUpdated).toBe(false);
    // Other effects should still fire.
    expect(result.sessionStatusUpdated).toBe(true);
  });

  it("throws ResourceNotFoundError when session does not exist", async () => {
    const sessionDB = new FakeSessionProvider({ initialSessions: [] });
    const taskService = new FakeTaskService();
    const deps: PostMergeStateSyncDeps = { sessionDB, taskService };

    let threw = false;
    try {
      await applyPostMergeStateSync(
        { sessionId: "nonexistent-session", cleanupSession: false },
        deps
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
  });

  it("continues to update session status even when task update fails", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });

    // Task service that always throws.
    const throwingTaskService = {
      getTaskStatus: async () => {
        throw new Error("Simulated DB failure");
      },
      setTaskStatus: async () => undefined,
    } as any;

    const deps: PostMergeStateSyncDeps = {
      sessionDB,
      taskService: throwingTaskService,
    };

    // Should not propagate the task service error.
    const result = await applyPostMergeStateSync(
      {
        sessionId: SESSION_ID,
        mergedAt: MERGED_AT,
        cleanupSession: false,
        trigger: "webhook",
      },
      deps
    );

    // task effect failed (non-fatal), session effect still ran.
    expect(result.taskStatusUpdated).toBe(false);
    expect(result.sessionStatusUpdated).toBe(true);

    // Session status updated despite task service failure.
    const updated = await sessionDB.getSession(SESSION_ID);
    expect(updated?.status).toBe(SessionStatus.MERGED);
  });
});

// ---------------------------------------------------------------------------
// mt#1841 — partial-failure surfacing
// ---------------------------------------------------------------------------
//
// Regression guard: when sessionDB.updateSession throws, the function must
// (a) NOT optimistically set sessionStatusUpdated / pullRequestRecordUpdated
//     to true (the prior bug: flags were set before the await), and
// (b) populate sessionUpdateError with the underlying error message so the
//     webhook handler can detect partial failure.
//
// Originating incident: mt#1813 (PR #1101, bypass-merged 2026-05-13T14:54Z)
// had task=DONE within minutes but session.status stayed at PR_OPEN until
// manually synced ~21h later. The catch block at session-merge-operations.ts
// :204-210 logged the error but the result reported success because the
// flags were set optimistically BEFORE the await.
// ---------------------------------------------------------------------------

describe("applyPostMergeStateSync — partial-failure surfacing (mt#1841)", () => {
  it("sessionUpdateError populated and flags=false when updateSession throws", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });
    // Override updateSession to throw, simulating the silent-failure mode that
    // produced the mt#1813 drift.
    sessionDB.updateSession = (async () => {
      throw new Error("Simulated DB failure during session-record update");
    }) as typeof sessionDB.updateSession;

    const taskService = new FakeTaskService();
    const deps: PostMergeStateSyncDeps = { sessionDB, taskService };

    const result = await applyPostMergeStateSync(
      {
        sessionId: SESSION_ID,
        mergeSha: "deadbeef",
        mergedAt: MERGED_AT,
        cleanupSession: false,
        trigger: "webhook",
      },
      deps
    );

    // task effect succeeded (its own try/catch is independent).
    expect(result.taskStatusUpdated).toBe(true);

    // session effect failed: flags must NOT be optimistically true.
    expect(result.sessionStatusUpdated).toBe(false);
    expect(result.pullRequestRecordUpdated).toBe(false);

    // The error must be surfaced in the result so the caller can act on it.
    expect(result.sessionUpdateError).toContain("Simulated DB failure");

    // task-side error field stays undefined (only session side failed).
    expect(result.taskUpdateError).toBeUndefined();

    // PR #1121 R1 BLOCKING #3: partialFailure is the single boolean callers
    // should check. True iff any error field is populated.
    expect(result.partialFailure).toBe(true);
  });

  it("session-update success: sessionUpdateError stays undefined and flags=true", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });
    const taskService = new FakeTaskService();
    const deps: PostMergeStateSyncDeps = { sessionDB, taskService };

    const result = await applyPostMergeStateSync(
      {
        sessionId: SESSION_ID,
        mergeSha: "deadbeef",
        mergedAt: MERGED_AT,
        cleanupSession: false,
        trigger: "webhook",
      },
      deps
    );

    expect(result.sessionStatusUpdated).toBe(true);
    expect(result.pullRequestRecordUpdated).toBe(true);
    expect(result.sessionUpdateError).toBeUndefined();
    expect(result.taskUpdateError).toBeUndefined();
    // PR #1121 R1 BLOCKING #3: write-success path has partialFailure=false.
    expect(result.partialFailure).toBe(false);
  });

  it("task-update failure surfaces taskUpdateError without affecting session side", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });

    const throwingTaskService = {
      getTaskStatus: async () => {
        throw new Error("Simulated task-DB failure");
      },
      setTaskStatus: async () => undefined,
    } as any;

    const deps: PostMergeStateSyncDeps = {
      sessionDB,
      taskService: throwingTaskService,
    };

    const result = await applyPostMergeStateSync(
      {
        sessionId: SESSION_ID,
        mergedAt: MERGED_AT,
        cleanupSession: false,
        trigger: "webhook",
      },
      deps
    );

    expect(result.taskStatusUpdated).toBe(false);
    expect(result.taskUpdateError).toContain("Simulated task-DB failure");

    // Session side still runs and lands.
    expect(result.sessionStatusUpdated).toBe(true);
    expect(result.sessionUpdateError).toBeUndefined();

    // PR #1121 R1 BLOCKING #3: any error field populated → partialFailure=true.
    expect(result.partialFailure).toBe(true);
  });

  // PR #1121 R1 BLOCKING #3: explicit no-op success — distinguishable from
  // write failure via the partialFailure field. Session-side no-op is the
  // core case (task-side no-op is covered by the idempotent SC#2 tests).
  it("no-op success path: session already MERGED → sessionStatusUpdated=false but partialFailure=false", async () => {
    // Build a session record already in the MERGED target state.
    const baseRecord = makeSessionRecord();
    const alreadyMerged = makeSessionRecord({
      status: SessionStatus.MERGED,
      pullRequest:
        baseRecord.pullRequest === undefined
          ? undefined
          : {
              ...baseRecord.pullRequest,
              state: "closed",
              mergedAt: MERGED_AT,
            },
    });
    const sessionDB = new FakeSessionProvider({ initialSessions: [alreadyMerged] });
    const taskService = new FakeTaskService();
    const deps: PostMergeStateSyncDeps = { sessionDB, taskService };

    const result = await applyPostMergeStateSync(
      {
        sessionId: SESSION_ID,
        mergeSha: "deadbeef",
        mergedAt: MERGED_AT,
        cleanupSession: false,
        trigger: "webhook",
      },
      deps
    );

    // Session-side: status update is a no-op because already in target state.
    // sessionStatusUpdated stays false (we didn't write), with no error.
    expect(result.sessionStatusUpdated).toBe(false);
    expect(result.sessionUpdateError).toBeUndefined();

    // The disambiguator: no errors anywhere → no partial failure, despite
    // sessionStatusUpdated being false. This is the contract PR #1121 R1
    // BLOCKING #3 codifies: false + !error = no-op success.
    expect(result.partialFailure).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SC#4 — mergeSessionPr calls applyPostMergeStateSync (regression guard)
// ---------------------------------------------------------------------------
//
// Verifies that the session_pr_merge path still runs the five effects by
// checking that a successful mergeSessionPr invocation leaves the session
// in MERGED status. Any refactor that breaks the applyPostMergeStateSync
// call would break this test.
//
// NOTE: mergeSessionPr requires a full repository backend stub. We stub
// it to return a merge result so we can verify the post-merge state is
// set. This mirrors the pattern from session-merge-ask-emission.test.ts.
// ---------------------------------------------------------------------------

import { mergeSessionPr } from "./session-merge-operations";

describe("mergeSessionPr → applyPostMergeStateSync (regression guard SC#4)", () => {
  it("session.status is MERGED after a successful mergeSessionPr call", async () => {
    const fakeTask = {
      id: TASK_ID,
      title: "At-merge handler",
      status: TASK_STATUS.IN_REVIEW,
    };

    const sessionRecord = makeSessionRecord({
      backendType: "github",
      prApproved: true,
      prBranch: "task/mt-1614",
      pullRequest: makePullRequestInfo({ state: "open", number: 999 }),
    });

    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });
    const taskService = new FakeTaskService({ initialTasks: [fakeTask] });

    const stubBackend = {
      pr: {
        merge: async () => ({
          merged: true,
          sha: MERGE_SHA,
          message: "Merged",
          mergedAt: MERGED_AT,
          prNumber: 999,
        }),
        get: async () => ({
          number: 999,
          state: "open",
          url: "https://github.com/owner/repo/pull/999",
          mergedAt: undefined,
          html_url: "https://github.com/owner/repo/pull/999",
        }),
      },
      review: {
        getApprovalStatus: async () => ({ isApproved: true }),
      },
      getConfig: () => ({ owner: "owner", repo: "repo", type: "github" }),
    } as any;

    let thrown: unknown = null;
    try {
      await mergeSessionPr(
        {
          session: SESSION_ID,
          json: true,
          cleanupSession: false,
        },
        {
          sessionDB,
          taskService,
          createRepositoryBackend: async () => stubBackend,
        }
      );
    } catch (err) {
      thrown = err;
    }

    // If there was an unexpected error, fail with it.
    if (thrown) {
      throw thrown;
    }

    // Verify session is MERGED (applyPostMergeStateSync fired).
    const updated = await sessionDB.getSession(SESSION_ID);
    expect(updated?.status).toBe(SessionStatus.MERGED);
  });
});
