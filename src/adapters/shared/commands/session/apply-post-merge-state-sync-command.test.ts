/**
 * Unit tests for createApplyPostMergeStateSyncCommand (mt#1614 GAP 1).
 *
 * Tests the pure helper functions exported from the command file using
 * dependency injection — no mock.module() calls required.
 *
 * Verifies:
 * 1. The command is registered with id "session.apply_post_merge_state_sync".
 * 2. resolveSessionIdFromParams returns sessionId directly when provided.
 * 3. resolveSessionIdFromParams resolves sessionId from taskId when sessionId absent.
 * 4. resolveSessionIdFromParams throws when neither sessionId nor task is provided.
 * 5. resolveSessionIdFromParams throws when task has no matching session.
 * 6. buildPostMergeStateSyncParams maps all fields including trigger default.
 */

import { describe, it, expect } from "bun:test";
import {
  createApplyPostMergeStateSyncCommand,
  resolveSessionIdFromParams,
  buildPostMergeStateSyncParams,
  repairStrandedTask,
  type StrandedTaskRepairDeps,
} from "./apply-post-merge-state-sync-command";

// ---------------------------------------------------------------------------
// Minimal DI stubs (no mock.module required)
// ---------------------------------------------------------------------------

function makeSessionProvider(sessions: Array<{ sessionId: string; taskId?: string }>) {
  return {
    listSessions: async () => sessions,
  };
}

function makeDepsGetter() {
  return async () =>
    ({
      sessionProvider: makeSessionProvider([{ sessionId: "s1", taskId: "mt#42" }]),
      taskService: {},
      gitService: {},
    }) as any;
}

// ---------------------------------------------------------------------------
// Command metadata tests
// ---------------------------------------------------------------------------

describe("createApplyPostMergeStateSyncCommand — metadata", () => {
  it("registers with id 'session.apply_post_merge_state_sync'", () => {
    const cmd = createApplyPostMergeStateSyncCommand(makeDepsGetter());
    expect(cmd.id).toBe("session.apply_post_merge_state_sync");
  });

  it("is marked mutating", () => {
    const cmd = createApplyPostMergeStateSyncCommand(makeDepsGetter());
    expect(cmd.mutating).toBe(true);
  });

  it("has a defined execute handler", () => {
    const cmd = createApplyPostMergeStateSyncCommand(makeDepsGetter());
    expect(typeof cmd.execute).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// resolveSessionIdFromParams tests
// ---------------------------------------------------------------------------

describe("resolveSessionIdFromParams", () => {
  it("returns sessionId directly when provided", async () => {
    const provider = makeSessionProvider([]);
    const result = await resolveSessionIdFromParams(
      { sessionId: "explicit-session" },
      { sessionProvider: provider as any }
    );
    expect(result).toBe("explicit-session");
  });

  it("resolves sessionId by looking up taskId", async () => {
    const provider = makeSessionProvider([
      { sessionId: "s1", taskId: "mt#42" },
      { sessionId: "s2", taskId: "mt#99" },
    ]);
    const result = await resolveSessionIdFromParams(
      { task: "mt#42" },
      { sessionProvider: provider as any }
    );
    expect(result).toBe("s1");
  });

  it("prefers explicit sessionId over task when both are provided", async () => {
    const provider = makeSessionProvider([{ sessionId: "from-task", taskId: "mt#42" }]);
    const result = await resolveSessionIdFromParams(
      { sessionId: "explicit", task: "mt#42" },
      { sessionProvider: provider as any }
    );
    expect(result).toBe("explicit");
  });

  it("throws when neither sessionId nor task is provided", async () => {
    const provider = makeSessionProvider([]);
    await expect(
      resolveSessionIdFromParams({}, { sessionProvider: provider as any })
    ).rejects.toThrow(/sessionId or task must be provided/);
  });

  it("throws when task has no matching session", async () => {
    const provider = makeSessionProvider([{ sessionId: "s1", taskId: "mt#1" }]);
    await expect(
      resolveSessionIdFromParams({ task: "mt#999" }, { sessionProvider: provider as any })
    ).rejects.toThrow(/No session found for task mt#999/);
  });

  // mt#4403 AT1. The two cases below differ by ONE parameter, and that is the
  // point: `mergeSha` is the repair signal. The throwing case immediately above
  // is this test's negative control — same missing session, no `mergeSha`, and
  // the pre-fix behaviour is preserved rather than reverted, so both branches
  // are live and a regression in either is visible.
  it("returns null — not a throw — for the repair case: task + mergeSha, no session row", async () => {
    const provider = makeSessionProvider([{ sessionId: "s1", taskId: "mt#1" }]);
    const resolved = await resolveSessionIdFromParams(
      { task: "mt#4299", mergeSha: "dc0f331c6" },
      { sessionProvider: provider as any }
    );
    expect(resolved).toBeNull();
  });

  it("the no-mergeSha throw names the repair affordance, so the caller knows one exists", async () => {
    const provider = makeSessionProvider([]);
    await expect(
      resolveSessionIdFromParams({ task: "mt#4299" }, { sessionProvider: provider as any })
    ).rejects.toThrow(/pass mergeSha/);
  });
});

// ---------------------------------------------------------------------------
// repairStrandedTask — mt#4403 AT2 / AT3
// ---------------------------------------------------------------------------

function makeRepairDeps(overrides: Partial<StrandedTaskRepairDeps> & { status?: string } = {}): {
  deps: StrandedTaskRepairDeps;
  writes: Array<{ taskId: string; status: string }>;
  audit: Array<{ outcome: string; previousStatus?: string }>;
} {
  const writes: Array<{ taskId: string; status: string }> = [];
  const audit: Array<{ outcome: string; previousStatus?: string }> = [];
  const deps: StrandedTaskRepairDeps = {
    getTaskStatus: async () => overrides.status ?? "IN-REVIEW",
    setTaskStatus: async (taskId, status) => {
      writes.push({ taskId, status });
    },
    isMergedCommit: async () => true,
    recordReconcile: async (entry) => {
      audit.push({ outcome: entry.outcome, previousStatus: entry.previousStatus });
    },
    ...(overrides.isMergedCommit ? { isMergedCommit: overrides.isMergedCommit } : {}),
  };
  return { deps, writes, audit };
}

const REPAIR_ARGS = { taskId: "mt#4299", mergeSha: "dc0f331c6", trigger: "repair_pass" };

describe("repairStrandedTask (mt#4403)", () => {
  it("AT2 — repairs an IN-REVIEW task when the commit belongs to a merged PR", async () => {
    const { deps, writes, audit } = makeRepairDeps();

    const result = await repairStrandedTask(REPAIR_ARGS, deps);

    expect(result.repaired).toBe(true);
    expect(result.previousStatus).toBe("IN-REVIEW");
    expect(writes).toEqual([{ taskId: "mt#4299", status: "DONE" }]);
    expect(audit).toEqual([{ outcome: "repaired", previousStatus: "IN-REVIEW" }]);
  });

  it("AT3 — REFUSES when the commit belongs to no merged PR, and writes nothing", async () => {
    const { deps, writes, audit } = makeRepairDeps({ isMergedCommit: async () => false });

    const result = await repairStrandedTask(REPAIR_ARGS, deps);

    expect(result.repaired).toBe(false);
    expect(result.refusedReason).toMatch(/does not belong to a merged/);
    // The load-bearing assertion: the task is untouched. A refusal that still
    // wrote would be indistinguishable from a repair in the task's own record.
    expect(writes).toEqual([]);
    expect(audit).toEqual([{ outcome: "refused-not-merged", previousStatus: undefined }]);
  });

  it("AT3 — verifies the merge BEFORE reading the task, so a bogus SHA costs no task read", async () => {
    let statusReads = 0;
    const { deps } = makeRepairDeps({ isMergedCommit: async () => false });
    const counting: StrandedTaskRepairDeps = {
      ...deps,
      getTaskStatus: async () => {
        statusReads += 1;
        return "IN-REVIEW";
      },
    };

    await repairStrandedTask(REPAIR_ARGS, counting);

    expect(statusReads).toBe(0);
  });

  it("refuses to force DONE from a status that is not IN-REVIEW", async () => {
    const { deps, writes, audit } = makeRepairDeps({ status: "BLOCKED" });

    const result = await repairStrandedTask(REPAIR_ARGS, deps);

    expect(result.repaired).toBe(false);
    expect(result.refusedReason).toMatch(/expected status IN-REVIEW but found BLOCKED/);
    expect(writes).toEqual([]);
    expect(audit).toEqual([{ outcome: "refused-wrong-status", previousStatus: "BLOCKED" }]);
  });

  it("is idempotent on an already-DONE task: no write, no refusal", async () => {
    const { deps, writes, audit } = makeRepairDeps({ status: "DONE" });

    const result = await repairStrandedTask(REPAIR_ARGS, deps);

    // Neither repaired nor refused — the tool's own description promises it is
    // "safe to call multiple times for the same merge event", so a second call
    // must not read as an error.
    expect(result.repaired).toBe(false);
    expect(result.refusedReason).toBeUndefined();
    expect(writes).toEqual([]);
    expect(audit).toEqual([{ outcome: "already-done", previousStatus: "DONE" }]);
  });

  it("records an audit entry on EVERY path, including the refusals", async () => {
    // RFC Rule 3's use-rate counter is only a health signal if it counts the
    // failures too — a reconcile path that logged only its successes would go
    // quietest exactly when it is misbehaving.
    for (const setup of [
      {},
      { isMergedCommit: async () => false },
      { status: "BLOCKED" },
      { status: "DONE" },
    ]) {
      const { deps, audit } = makeRepairDeps(setup as any);
      await repairStrandedTask(REPAIR_ARGS, deps);
      expect(audit).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// buildPostMergeStateSyncParams tests
// ---------------------------------------------------------------------------

describe("buildPostMergeStateSyncParams", () => {
  it("maps all explicit fields", () => {
    const result = buildPostMergeStateSyncParams("my-session", {
      mergeSha: "abc123",
      mergedAt: "2026-05-08T12:00:00Z",
      cleanupSession: false,
      trigger: "webhook",
    });
    expect(result.sessionId).toBe("my-session");
    expect(result.mergeSha).toBe("abc123");
    expect(result.mergedAt).toBe("2026-05-08T12:00:00Z");
    expect(result.cleanupSession).toBe(false);
    expect(result.trigger).toBe("webhook");
  });

  it("defaults trigger to 'unknown' when not provided", () => {
    const result = buildPostMergeStateSyncParams("my-session", {});
    expect(result.trigger).toBe("unknown");
  });

  it("passes through undefined optional fields", () => {
    const result = buildPostMergeStateSyncParams("my-session", {});
    expect(result.mergeSha).toBeUndefined();
    expect(result.mergedAt).toBeUndefined();
    expect(result.cleanupSession).toBeUndefined();
  });
});
