/**
 * Tests for quality.review Ask emission in mergeSessionPr (mt#1467).
 *
 * Verifies:
 * 1. A quality.review Ask is emitted before each merge attempt (approved sessions).
 * 2. For unapproved sessions: the gate fires BEFORE emission, so no Ask is emitted.
 * 3. If AskRepository.create() throws, the merge path is unaffected.
 * 4. Existing approval-gate semantics remain unchanged.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mergeSessionPr, type SessionMergeParams } from "./session-merge-operations";
import { FakeAskRepository } from "../ask/repository";
import { ValidationError } from "../../errors/index";
import type { SessionRecord } from "./types";

// ---------------------------------------------------------------------------
// Test fixture IDs (shared constants to satisfy no-magic-string-duplication rule)
// ---------------------------------------------------------------------------

const SESSION_IDS = {
  APPROVED_NON_GITHUB: "approved-session",
  APPROVED_GITHUB: "approved-github-session",
  UNAPPROVED: "unapproved-session",
  UNAPPROVED_GITHUB: "unapproved-github-session",
} as const;

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const successMergeResult = {
  commitHash: "abc123def456",
  mergeDate: new Date().toISOString(),
  mergedBy: "test-user",
  mergeSha: "abc123",
  mergedAt: new Date().toISOString(),
};

const approvedNonGitHubSession: SessionRecord = {
  sessionId: SESSION_IDS.APPROVED_NON_GITHUB,
  repoName: "test/repo",
  createdAt: new Date().toISOString(),
  name: SESSION_IDS.APPROVED_NON_GITHUB,
  taskId: "mt#999",
  repoUrl: "https://github.com/test/repo.git",
  prBranch: "pr/approved-session",
  prApproved: true,
  // No backendType / no pullRequest — non-GitHub path
};

const unapprovedNonGitHubSession: SessionRecord = {
  sessionId: SESSION_IDS.UNAPPROVED,
  repoName: "test/repo",
  createdAt: new Date().toISOString(),
  name: SESSION_IDS.UNAPPROVED,
  taskId: "mt#998",
  repoUrl: "https://github.com/test/repo.git",
  prBranch: "pr/unapproved-session",
  prApproved: false,
};

const approvedGitHubSession: SessionRecord = {
  sessionId: SESSION_IDS.APPROVED_GITHUB,
  repoName: "test/repo",
  createdAt: new Date().toISOString(),
  name: SESSION_IDS.APPROVED_GITHUB,
  taskId: "mt#997",
  repoUrl: "https://github.com/test/repo.git",
  backendType: "github",
  prBranch: "task/mt-997",
  prApproved: true,
  pullRequest: {
    number: 42,
    url: "https://github.com/test/repo/pull/42",
    state: "open",
    createdAt: new Date().toISOString(),
    headBranch: "task/mt-997",
    baseBranch: "main",
    lastSynced: new Date().toISOString(),
    github: {
      id: 42,
      nodeId: "PR_node_42",
      htmlUrl: "https://github.com/test/repo/pull/42",
      author: "test-bot",
    },
  },
};

const unapprovedGitHubSession: SessionRecord = {
  sessionId: SESSION_IDS.UNAPPROVED_GITHUB,
  repoName: "test/repo",
  createdAt: new Date().toISOString(),
  name: SESSION_IDS.UNAPPROVED_GITHUB,
  taskId: "mt#996",
  repoUrl: "https://github.com/test/repo.git",
  backendType: "github",
  prBranch: "task/mt-996",
  prApproved: false,
  pullRequest: {
    number: 43,
    url: "https://github.com/test/repo/pull/43",
    state: "open",
    createdAt: new Date().toISOString(),
    headBranch: "task/mt-996",
    baseBranch: "main",
    lastSynced: new Date().toISOString(),
    github: {
      id: 43,
      nodeId: "PR_node_43",
      htmlUrl: "https://github.com/test/repo/pull/43",
      author: "test-bot",
    },
  },
};

// ---------------------------------------------------------------------------
// Shared mock builder
// ---------------------------------------------------------------------------

function buildDeps(
  sessionRecord: SessionRecord,
  options: {
    askRepository?: FakeAskRepository;
    mergeImpl?: () => Promise<typeof successMergeResult>;
    getApprovalStatusImpl?: () => Promise<unknown>;
  } = {}
) {
  const mergeImpl = options.mergeImpl ?? (() => Promise.resolve(successMergeResult));
  const getApprovalStatusImpl =
    options.getApprovalStatusImpl ??
    (() =>
      Promise.resolve({
        isApproved: true,
        canMerge: true,
        hasNonApprovalMergeBlockers: false,
        approvals: [
          {
            reviewId: "r1",
            approvedBy: "reviewer",
            approvedAt: new Date().toISOString(),
            prNumber: sessionRecord.pullRequest?.number ?? 0,
          },
        ],
        requiredApprovals: 1,
        prState: "open" as const,
        rawReviews: [
          {
            reviewId: "r1",
            reviewerLogin: "reviewer",
            state: "APPROVED" as const,
            submittedAt: new Date().toISOString(),
            body: "",
          },
        ],
      }));

  return {
    sessionDB: {
      listSessions: mock(() => Promise.resolve([])),
      getSession: mock(() => Promise.resolve(sessionRecord)),
      getSessionByTaskId: mock(() => Promise.resolve(sessionRecord)),
      addSession: mock(() => Promise.resolve()),
      updateSession: mock(() => Promise.resolve()),
      deleteSession: mock(() => Promise.resolve(true)),
      getRepoPath: mock(() => Promise.resolve("/test/repo")),
      getSessionWorkdir: mock(() => Promise.resolve("/test/session/workdir")),
    },
    taskService: {
      setTaskStatus: async () => {},
      getTaskStatus: async () => "IN-REVIEW",
      getTask: async () => null,
    } as any,
    persistenceProvider: { capabilities: { sql: false, vector: false } } as any,
    createRepositoryBackend: (_config: any) =>
      Promise.resolve({
        pr: { merge: mock(mergeImpl) },
        review: { getApprovalStatus: mock(getApprovalStatusImpl) },
        getType: () => "github",
      } as any),
    askRepository: options.askRepository,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mergeSessionPr — quality.review Ask emission (mt#1467)", () => {
  let fakeAskRepo: FakeAskRepository;

  beforeEach(() => {
    fakeAskRepo = new FakeAskRepository();
  });

  // ── Positive path: Ask is emitted for an approved non-GitHub session ───────

  it("emits exactly one quality.review Ask for an approved non-GitHub session", async () => {
    const deps = buildDeps(approvedNonGitHubSession, { askRepository: fakeAskRepo });

    await mergeSessionPr({ session: SESSION_IDS.APPROVED_NON_GITHUB, json: true }, deps);

    const asks = fakeAskRepo.all;
    expect(asks).toHaveLength(1);

    const ask = asks[0];
    if (!ask) throw new Error("Expected ask to be defined");

    expect(ask.kind).toBe("quality.review");
    expect(ask.state).toBe("detected");
    expect(ask.classifierVersion).toBe("v1");
    expect(ask.parentTaskId).toBe("mt#999");
    expect(ask.parentSessionId).toBe(SESSION_IDS.APPROVED_NON_GITHUB);
    expect(ask.requestor).toContain(SESSION_IDS.APPROVED_NON_GITHUB);
  });

  // ── Positive path: Ask is emitted for an approved GitHub session ──────────

  it("emits exactly one quality.review Ask for an approved GitHub session", async () => {
    const deps = buildDeps(approvedGitHubSession, { askRepository: fakeAskRepo });

    const params: SessionMergeParams = { session: SESSION_IDS.APPROVED_GITHUB, json: true };
    await mergeSessionPr(params, deps);

    const asks = fakeAskRepo.all;
    expect(asks).toHaveLength(1);

    const ask = asks[0];
    if (!ask) throw new Error("Expected ask to be defined");

    expect(ask.kind).toBe("quality.review");
    expect(ask.state).toBe("detected");
    expect(ask.classifierVersion).toBe("v1");
    expect(ask.parentTaskId).toBe("mt#997");
    expect(ask.parentSessionId).toBe(SESSION_IDS.APPROVED_GITHUB);

    // GitHub PR URL should appear in contextRefs as the canonical URL
    const prRef = ask.contextRefs?.find((r) => r.kind === "github-pr");
    if (!prRef) throw new Error("Expected github-pr contextRef to be defined");
    expect(prRef.ref).toBe("https://github.com/test/repo/pull/42");
  });

  // ── Positive path: Ask metadata includes expected fields ─────────────────

  it("includes prNumber, targetBranch, and approvalState in the Ask metadata", async () => {
    const deps = buildDeps(approvedGitHubSession, { askRepository: fakeAskRepo });

    await mergeSessionPr({ session: SESSION_IDS.APPROVED_GITHUB, json: true }, deps);

    const ask = fakeAskRepo.all[0];
    if (!ask) throw new Error("Expected ask to be defined");

    expect(ask.metadata.prNumber).toBe(42);
    expect(ask.metadata.targetBranch).toBe("task/mt-997");
    expect(ask.metadata.approvalState).toBe("approved");
  });

  // ── No-repo path: Ask emission is silently skipped when no askRepository ─

  it("silently skips Ask emission when no askRepository is provided", async () => {
    // No askRepository in deps
    const deps = buildDeps(approvedNonGitHubSession);

    // Should still merge without error
    const result = await mergeSessionPr(
      { session: SESSION_IDS.APPROVED_NON_GITHUB, json: true },
      deps
    );
    expect(result).toBeDefined();
    expect(result.session).toBe(SESSION_IDS.APPROVED_NON_GITHUB);
  });

  // ── Approval gate: unapproved sessions are still rejected ─────────────────

  it("rejects unapproved sessions and does NOT emit an Ask", async () => {
    const deps = buildDeps(unapprovedNonGitHubSession, { askRepository: fakeAskRepo });

    await expect(
      mergeSessionPr({ session: SESSION_IDS.UNAPPROVED, json: true }, deps)
    ).rejects.toThrow(ValidationError);

    await expect(
      mergeSessionPr({ session: SESSION_IDS.UNAPPROVED, json: true }, deps)
    ).rejects.toThrow(/PR must be approved/);

    // Gate fires before Ask emission — no Ask should be emitted
    expect(fakeAskRepo.all).toHaveLength(0);
  });

  // ── Approval gate: unapproved GitHub PR — rejected before Ask emission ────

  it("rejects unapproved GitHub PR and does NOT emit an Ask", async () => {
    const deps = buildDeps(unapprovedGitHubSession, {
      askRepository: fakeAskRepo,
      getApprovalStatusImpl: () =>
        Promise.resolve({
          isApproved: false,
          canMerge: false,
          hasNonApprovalMergeBlockers: false,
          approvals: [],
          requiredApprovals: 1,
          prState: "open" as const,
          rawReviews: [],
        }),
    });

    await expect(
      mergeSessionPr({ session: SESSION_IDS.UNAPPROVED_GITHUB, json: true }, deps)
    ).rejects.toThrow(ValidationError);

    // Approval check fires BEFORE Ask emission — no Ask should be emitted
    expect(fakeAskRepo.all).toHaveLength(0);
  });

  // ── Negative path: AskRepository.create() throws — merge is unaffected ───

  it("proceeds with merge even if AskRepository.create() throws", async () => {
    // Wrap a FakeAskRepository with a throwing create() to simulate DB failure
    const throwingRepo = new FakeAskRepository();
    // Override create() using Object.assign to avoid non-null assertions
    const throwingImpl = async (_input: any): Promise<never> => {
      throw new Error("simulated DB failure");
    };
    Object.assign(throwingRepo, { create: throwingImpl });

    const deps = buildDeps(approvedNonGitHubSession, { askRepository: throwingRepo });

    // Merge must succeed despite the thrown Ask error
    const result = await mergeSessionPr(
      { session: SESSION_IDS.APPROVED_NON_GITHUB, json: true },
      deps
    );

    expect(result).toBeDefined();
    expect(result.session).toBe(SESSION_IDS.APPROVED_NON_GITHUB);
  });

  // ── Negative path: create() throws — still merges approved GitHub session ─

  it("proceeds with GitHub merge even if AskRepository.create() throws", async () => {
    const throwingRepo = new FakeAskRepository();
    const throwingImpl = async (_input: any): Promise<never> => {
      throw new Error("simulated DB failure on GitHub path");
    };
    Object.assign(throwingRepo, { create: throwingImpl });

    const deps = buildDeps(approvedGitHubSession, { askRepository: throwingRepo });

    const result = await mergeSessionPr({ session: SESSION_IDS.APPROVED_GITHUB, json: true }, deps);

    expect(result).toBeDefined();
    expect(result.session).toBe(SESSION_IDS.APPROVED_GITHUB);
  });
});
