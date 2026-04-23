/**
 * Contract tests for `updateSession` partial-merge semantics.
 *
 * These tests pin the exact behaviour that call-site code in PR #721 relies on
 * after `...sessionRecord` spreads were removed:
 *
 *   1. Unspecified fields are preserved (partial update, not replace)
 *   2. `undefined` values clear the field (force-recreation semantics)
 *   3. Nested objects replace wholesale (shallow merge, not deep)
 *   4. `pullRequest` nested object replaces wholesale (same as #3)
 *
 * Section A: FakeSessionProvider — exercises the call-site pattern through
 *            the provider interface.
 * Section B: updateSessionFn (direct) — exercises the pure function exported
 *            from session-db.ts directly, confirming the contract independently
 *            of FakeSessionProvider.
 */

import { describe, it, expect } from "bun:test";
import { FakeSessionProvider } from "./fake-session-provider";
import { updateSessionFn, initializeSessionDbState } from "./session-db";
import { SessionStatus } from "./types";
import type { SessionRecord } from "./types";

// ---------------------------------------------------------------------------
// Test-only subset types for injecting extra keys without `as unknown as`
// ---------------------------------------------------------------------------

type PrStateWithLegacy = NonNullable<SessionRecord["prState"]> & {
  commitHash?: string;
  extraKey?: string;
  foo?: string;
};

type PullRequestWithLegacy = NonNullable<SessionRecord["pullRequest"]> & {
  extraKey?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = "test-partial-merge";
const PR_BRANCH = "pr/test-partial-merge";

function makeFullSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session: SESSION_ID,
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: "2024-01-01T00:00:00.000Z",
    taskId: "mt#1121",
    lastActivityAt: "2024-01-02T00:00:00.000Z",
    lastCommitHash: "abc123",
    lastCommitMessage: "initial commit",
    commitCount: 3,
    status: SessionStatus.ACTIVE,
    agentId: "agent-42",
    prBranch: PR_BRANCH,
    prApproved: false,
    prState: {
      branchName: PR_BRANCH,
      exists: true,
      lastChecked: "2024-01-01T12:00:00.000Z",
      createdAt: "2024-01-01T10:00:00.000Z",
    },
    pullRequest: {
      number: 99,
      url: "https://github.com/edobry/minsky/pull/99",
      state: "open",
      createdAt: "2024-01-01T10:00:00.000Z",
      headBranch: PR_BRANCH,
      baseBranch: "main",
      lastSynced: "2024-01-02T00:00:00.000Z",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Unspecified fields are preserved
// ---------------------------------------------------------------------------

describe("updateSession — unspecified fields are preserved", () => {
  it("only updates the targeted field; all other fields remain unchanged", async () => {
    const initial = makeFullSession();
    const sessionDB = new FakeSessionProvider({ initialSessions: [initial] });

    await sessionDB.updateSession(SESSION_ID, {
      lastActivityAt: "2024-06-01T00:00:00.000Z",
    });

    const updated = await sessionDB.getSession(SESSION_ID);
    expect(updated).not.toBeNull();
    if (!updated) return;

    // Updated field has the new value
    expect(updated.lastActivityAt).toBe("2024-06-01T00:00:00.000Z");

    // Every other field is untouched
    expect(updated.session).toBe(SESSION_ID);
    expect(updated.repoName).toBe("minsky");
    expect(updated.repoUrl).toBe("https://github.com/edobry/minsky.git");
    expect(updated.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(updated.taskId).toBe("mt#1121");
    expect(updated.lastCommitHash).toBe("abc123");
    expect(updated.lastCommitMessage).toBe("initial commit");
    expect(updated.commitCount).toBe(3);
    expect(updated.status).toBe(SessionStatus.ACTIVE);
    expect(updated.agentId).toBe("agent-42");
    expect(updated.prBranch).toBe(PR_BRANCH);
    expect(updated.prApproved).toBe(false);
    expect(updated.prState).toBeDefined();
    expect(updated.prState?.branchName).toBe(PR_BRANCH);
    expect(updated.prState?.exists).toBe(true);
    expect(updated.pullRequest).toBeDefined();
    expect(updated.pullRequest?.number).toBe(99);
  });

  it("multiple consecutive partial updates accumulate independently", async () => {
    const initial = makeFullSession();
    const sessionDB = new FakeSessionProvider({ initialSessions: [initial] });

    await sessionDB.updateSession(SESSION_ID, { commitCount: 4 });
    await sessionDB.updateSession(SESSION_ID, { agentId: "agent-99" });

    const updated = await sessionDB.getSession(SESSION_ID);
    expect(updated).not.toBeNull();
    if (!updated) return;

    expect(updated.commitCount).toBe(4);
    expect(updated.agentId).toBe("agent-99");
    // Fields from neither update are still original
    expect(updated.lastCommitHash).toBe("abc123");
    expect(updated.repoName).toBe("minsky");
  });
});

// ---------------------------------------------------------------------------
// 2. `undefined` clears the field (force-recreation semantics)
// ---------------------------------------------------------------------------

describe("updateSession — undefined clears the field", () => {
  it("clears prBranch when update passes undefined", async () => {
    const initial = makeFullSession({ prBranch: "pr/x" });
    const sessionDB = new FakeSessionProvider({ initialSessions: [initial] });

    await sessionDB.updateSession(SESSION_ID, {
      prBranch: undefined,
    });

    const updated = await sessionDB.getSession(SESSION_ID);
    expect(updated).not.toBeNull();
    if (!updated) return;

    // FakeSessionProvider spreads { ...existing, prBranch: undefined };
    // the key remains but the value is undefined — either absent or undefined is
    // acceptable as the "cleared" signal at call sites.
    expect(updated.prBranch == null).toBe(true);
  });

  it("clears prState when update passes undefined", async () => {
    const initial = makeFullSession();
    const sessionDB = new FakeSessionProvider({ initialSessions: [initial] });

    await sessionDB.updateSession(SESSION_ID, {
      prState: undefined,
    });

    const updated = await sessionDB.getSession(SESSION_ID);
    expect(updated).not.toBeNull();
    if (!updated) return;

    expect(updated.prState == null).toBe(true);
  });

  it("clears both prBranch and prState together", async () => {
    const initial = makeFullSession({ prBranch: "pr/x" });
    const sessionDB = new FakeSessionProvider({ initialSessions: [initial] });

    await sessionDB.updateSession(SESSION_ID, {
      prBranch: undefined,
      prState: undefined,
    });

    const updated = await sessionDB.getSession(SESSION_ID);
    expect(updated).not.toBeNull();
    if (!updated) return;

    expect(updated.prBranch == null).toBe(true);
    expect(updated.prState == null).toBe(true);

    // Other fields unaffected
    expect(updated.repoName).toBe("minsky");
    expect(updated.taskId).toBe("mt#1121");
  });
});

// ---------------------------------------------------------------------------
// 3. Nested objects replace wholesale (shallow merge)
// ---------------------------------------------------------------------------

describe("updateSession — nested objects replace wholesale (shallow merge)", () => {
  it("replaces prState entirely with the new object, dropping old extra keys", async () => {
    // Seed with a prState that carries an extra key (simulates legacy blob)
    const prStateWithExtra: PrStateWithLegacy = {
      branchName: "pr/old",
      exists: true,
      lastChecked: "t0",
      createdAt: "t-create",
      // Simulate a stale key that should not survive after replacement
      extraKey: "should-disappear",
    };
    const initial = makeFullSession({
      prState: prStateWithExtra,
    });
    const sessionDB = new FakeSessionProvider({ initialSessions: [initial] });

    await sessionDB.updateSession(SESSION_ID, {
      prState: {
        branchName: "pr/new",
        exists: false,
        lastChecked: "t1",
      },
    });

    const updated = await sessionDB.getSession(SESSION_ID);
    expect(updated).not.toBeNull();
    if (!updated) return;

    const prState = updated.prState;
    expect(prState).toBeDefined();
    if (!prState) return;

    // New values present
    expect(prState.branchName).toBe("pr/new");
    expect(prState.exists).toBe(false);
    expect(prState.lastChecked).toBe("t1");

    // createdAt was in original but NOT in the new update object — it should be gone
    // (shallow replace, not deep merge)
    expect(prState.createdAt).toBeUndefined();

    // Extra legacy key should not be present
    expect((prState as Record<string, unknown>)["extraKey"]).toBeUndefined();
  });

  it("preserves fields in prState that are included in the replacement object", async () => {
    const initial = makeFullSession();
    const sessionDB = new FakeSessionProvider({ initialSessions: [initial] });

    const newPrState = {
      branchName: "pr/updated",
      exists: true,
      lastChecked: "2024-03-01T00:00:00.000Z",
      createdAt: "2024-01-01T10:00:00.000Z",
      mergedAt: "2024-03-01T12:00:00.000Z",
    };

    await sessionDB.updateSession(SESSION_ID, { prState: newPrState });

    const updated = await sessionDB.getSession(SESSION_ID);
    expect(updated).not.toBeNull();
    if (!updated) return;

    expect(updated.prState?.branchName).toBe("pr/updated");
    expect(updated.prState?.exists).toBe(true);
    expect(updated.prState?.mergedAt).toBe("2024-03-01T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// 4. pullRequest nested-object replacement
//    (covers pr-get-subcommand.ts:~231-234 call site from mt#1121)
// ---------------------------------------------------------------------------

describe("updateSession — pullRequest nested object replaces wholesale", () => {
  it("replaces pullRequest entirely, dropping extra keys from original", async () => {
    const pullRequestWithExtra: PullRequestWithLegacy = {
      number: 1,
      url: "https://github.com/edobry/minsky/pull/1",
      state: "open",
      createdAt: "2024-01-01T10:00:00.000Z",
      headBranch: "pr/old",
      baseBranch: "main",
      lastSynced: "2024-01-02T00:00:00.000Z",
      // Extra key that should vanish after replacement
      extraKey: "should-vanish",
    };
    const initial = makeFullSession({
      pullRequest: pullRequestWithExtra,
    });
    const sessionDB = new FakeSessionProvider({ initialSessions: [initial] });

    const newPullRequest = {
      number: 2,
      url: "https://github.com/edobry/minsky/pull/2",
      state: "open" as const,
      createdAt: "2024-02-01T10:00:00.000Z",
      headBranch: "pr/new",
      baseBranch: "main",
      lastSynced: "2024-02-02T00:00:00.000Z",
    };

    await sessionDB.updateSession(SESSION_ID, {
      pullRequest: newPullRequest,
    });

    const updated = await sessionDB.getSession(SESSION_ID);
    expect(updated).not.toBeNull();
    if (!updated) return;

    const pr = updated.pullRequest;
    expect(pr).toBeDefined();
    if (!pr) return;

    // New values present
    expect(pr.number).toBe(2);
    expect(pr.url).toBe("https://github.com/edobry/minsky/pull/2");
    expect(pr.headBranch).toBe("pr/new");

    // Extra key from original should be gone
    expect((pr as unknown as Record<string, unknown>)["extraKey"]).toBeUndefined();
  });

  it("pullRequest update does not affect unrelated session fields", async () => {
    const initial = makeFullSession();
    const sessionDB = new FakeSessionProvider({ initialSessions: [initial] });

    await sessionDB.updateSession(SESSION_ID, {
      pullRequest: {
        number: 100,
        url: "https://github.com/edobry/minsky/pull/100",
        state: "open" as const,
        createdAt: "2024-03-01T10:00:00.000Z",
        headBranch: PR_BRANCH,
        baseBranch: "main",
        lastSynced: "2024-03-01T12:00:00.000Z",
      },
    });

    const updated = await sessionDB.getSession(SESSION_ID);
    expect(updated).not.toBeNull();
    if (!updated) return;

    // Unrelated fields unchanged
    expect(updated.repoName).toBe("minsky");
    expect(updated.taskId).toBe("mt#1121");
    expect(updated.agentId).toBe("agent-42");
    expect(updated.prBranch).toBe(PR_BRANCH);
    expect(updated.prState?.branchName).toBe(PR_BRANCH);

    // Updated field
    expect(updated.pullRequest?.number).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// B. updateSessionFn (direct) — contract
//    Tests the pure function exported from session-db.ts directly, without
//    any provider wrapper, to confirm the contract independently.
// ---------------------------------------------------------------------------

describe("updateSessionFn (direct) — contract", () => {
  function makeStateWith(record: SessionRecord) {
    const state = initializeSessionDbState({ baseDir: "/test" });
    return { ...state, sessions: [record] };
  }

  it("partial merge: unspecified fields are preserved", () => {
    const record = makeFullSession();
    const state = makeStateWith(record);

    const next = updateSessionFn(state, SESSION_ID, {
      lastActivityAt: "2024-06-01T00:00:00.000Z",
    });

    const updated = next.sessions.find((s) => s.session === SESSION_ID);
    expect(updated).toBeDefined();
    if (!updated) return;

    // Updated field
    expect(updated.lastActivityAt).toBe("2024-06-01T00:00:00.000Z");

    // All other fields preserved
    expect(updated.repoName).toBe("minsky");
    expect(updated.repoUrl).toBe("https://github.com/edobry/minsky.git");
    expect(updated.taskId).toBe("mt#1121");
    expect(updated.lastCommitHash).toBe("abc123");
    expect(updated.commitCount).toBe(3);
    expect(updated.status).toBe(SessionStatus.ACTIVE);
    expect(updated.agentId).toBe("agent-42");
    expect(updated.prBranch).toBe(PR_BRANCH);
    expect(updated.prApproved).toBe(false);
    expect(updated.prState?.branchName).toBe(PR_BRANCH);
    expect(updated.pullRequest?.number).toBe(99);
  });

  it("undefined clears the field", () => {
    const record = makeFullSession({ prBranch: "pr/to-clear" });
    const state = makeStateWith(record);

    const next = updateSessionFn(state, SESSION_ID, {
      prBranch: undefined,
      prState: undefined,
    });

    const updated = next.sessions.find((s) => s.session === SESSION_ID);
    expect(updated).toBeDefined();
    if (!updated) return;

    expect(updated.prBranch == null).toBe(true);
    expect(updated.prState == null).toBe(true);

    // Unrelated fields untouched
    expect(updated.repoName).toBe("minsky");
    expect(updated.taskId).toBe("mt#1121");
  });

  it("nested object replaces wholesale (shallow merge, not deep)", () => {
    const prStateWithExtra: PrStateWithLegacy = {
      branchName: "pr/old",
      exists: true,
      lastChecked: "t0",
      createdAt: "t-create",
      extraKey: "should-disappear",
    };
    const record = makeFullSession({ prState: prStateWithExtra });
    const state = makeStateWith(record);

    const next = updateSessionFn(state, SESSION_ID, {
      prState: {
        branchName: "pr/new",
        exists: false,
        lastChecked: "t1",
        // Note: createdAt intentionally omitted — should be gone after replace
      },
    });

    const updated = next.sessions.find((s) => s.session === SESSION_ID);
    expect(updated).toBeDefined();
    if (!updated) return;

    const prState = updated.prState;
    expect(prState).toBeDefined();
    if (!prState) return;

    // New values present
    expect(prState.branchName).toBe("pr/new");
    expect(prState.exists).toBe(false);
    expect(prState.lastChecked).toBe("t1");

    // createdAt was in the original but not in the replacement — should be gone
    expect(prState.createdAt).toBeUndefined();

    // Extra legacy key must not survive
    expect((prState as Record<string, unknown>)["extraKey"]).toBeUndefined();
  });
});
