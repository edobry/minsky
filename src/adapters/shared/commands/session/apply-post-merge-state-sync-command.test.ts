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
