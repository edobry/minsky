/**
 * Acceptance tests for the audited reviewer-convergence-failure bypass (mt#2215).
 *
 * forceBypass is the in-band, audited replacement for the raw `gh api PUT /merge` bypass.
 * It is the CHANGES_REQUESTED-present path that the acceptStaleReviewerSilence waiver
 * explicitly refuses. It:
 *   - requires a non-empty bypassReason,
 *   - requires at least one prior review round,
 *   - refuses when a required status check is failing (CI-not-green),
 *   - refuses when a non-approval merge blocker is active,
 *   - auto-dismisses every non-DISMISSED CHANGES_REQUESTED review using bypassReason,
 *   - writes the canonical audit signature + reason into the merge commit body, and
 *   - always uses merge_method=merge (enforced structurally in github-pr-operations.ts).
 */

import { describe, it, expect, mock } from "bun:test";
import { mergeSessionPr, type SessionMergeParams } from "./session-merge-operations";
import { ValidationError } from "../errors/index";
import type { SessionRecord } from "./types";

const TEST_SESSION_WORKDIR = "/test/session/workdir";
const SHORT_REASON = "verified false-positive";
const REVIEWER_BOT = "minsky-reviewer[bot]";

const botPullRequest = {
  number: 1447,
  url: "https://github.com/test/repo/pull/1447",
  state: "open" as const,
  createdAt: new Date().toISOString(),
  headBranch: "task/mt-2215",
  baseBranch: "main",
  lastSynced: new Date().toISOString(),
  github: {
    id: 1447,
    nodeId: "PR_node_1447",
    htmlUrl: "https://github.com/test/repo/pull/1447",
    author: "minsky-ai[bot]",
  },
};

const botPrSession: SessionRecord = {
  sessionId: "bypass-session",
  repoName: "test/repo",
  createdAt: new Date().toISOString(),
  name: "bypass-session",
  taskId: "mt#2215",
  repoUrl: "https://github.com/test/repo.git",
  backendType: "github",
  prBranch: "task/mt-2215",
  prApproved: true,
  pullRequest: botPullRequest,
};

const successMergeResult = {
  commitHash: "abc123def456",
  mergeDate: new Date().toISOString(),
  mergedBy: "minsky-ai[bot]",
  mergeSha: "abc123",
  mergedAt: new Date().toISOString(),
};

interface FakeBackendMocks {
  merge: ReturnType<typeof mock>;
  dismissReview: ReturnType<typeof mock>;
  getApprovalStatus: ReturnType<typeof mock>;
}

function buildDeps(approvalStatus: unknown): { deps: any; mocks: FakeBackendMocks } {
  const merge = mock(() => Promise.resolve(successMergeResult));
  const dismissReview = mock((prNumber: number, reviewId: number) =>
    Promise.resolve({
      reviewId,
      htmlUrl: `https://github.com/test/repo/pull/${prNumber}#review-${reviewId}`,
      state: "DISMISSED",
    })
  );
  const getApprovalStatus = mock(() => Promise.resolve(approvalStatus));

  const deps = {
    sessionDB: {
      listSessions: mock(() => Promise.resolve([])),
      getSession: mock(() => Promise.resolve(botPrSession)),
      getSessionByTaskId: mock(() => Promise.resolve(botPrSession)),
      addSession: mock(() => Promise.resolve()),
      updateSession: mock(() => Promise.resolve()),
      deleteSession: mock(() => Promise.resolve(true)),
      getRepoPath: mock(() => Promise.resolve("/test/repo/path")),
      getSessionWorkdir: mock(() => Promise.resolve(TEST_SESSION_WORKDIR)),
    },
    persistenceProvider: { capabilities: { sql: false, vector: false } } as any,
    createRepositoryBackend: (_config: any) =>
      Promise.resolve({
        pr: { merge },
        review: { getApprovalStatus, dismissReview },
        getType: () => "github",
      } as any),
    taskService: {
      setTaskStatus: async () => {},
      getTaskStatus: async () => "IN-REVIEW",
      getTask: async () => null,
    } as any,
  };

  return { deps, mocks: { merge, dismissReview, getApprovalStatus } };
}

/** Approval status with a single CHANGES_REQUESTED review (the false-positive case). */
function changesRequestedStatus(overrides: Record<string, unknown> = {}) {
  return {
    isApproved: false,
    canMerge: false,
    hasNonApprovalMergeBlockers: false,
    approvals: [],
    requiredApprovals: 1,
    prState: "open" as const,
    rawReviews: [
      {
        reviewId: "55501",
        reviewerLogin: REVIEWER_BOT,
        state: "CHANGES_REQUESTED",
        submittedAt: new Date().toISOString(),
        body: "False positive: claims X but X is verified correct.",
      },
    ],
    ...overrides,
  };
}

describe("session merge — audited force-bypass (mt#2215)", () => {
  it("rejects when forceBypass=true but bypassReason is missing", async () => {
    const { deps, mocks } = buildDeps(changesRequestedStatus());
    const params: SessionMergeParams = {
      session: "bypass-session",
      json: true,
      forceBypass: true,
    };

    await expect(mergeSessionPr(params, deps)).rejects.toThrow(ValidationError);
    await expect(mergeSessionPr(params, deps)).rejects.toThrow(/non-empty bypassReason/);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("rejects when forceBypass=true but bypassReason is whitespace-only", async () => {
    const { deps, mocks } = buildDeps(changesRequestedStatus());
    const params: SessionMergeParams = {
      session: "bypass-session",
      json: true,
      forceBypass: true,
      bypassReason: "   ",
    };

    await expect(mergeSessionPr(params, deps)).rejects.toThrow(/non-empty bypassReason/);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("rejects when no prior review round has occurred", async () => {
    const { deps, mocks } = buildDeps(changesRequestedStatus({ rawReviews: [] }));
    const params: SessionMergeParams = {
      session: "bypass-session",
      json: true,
      forceBypass: true,
      bypassReason: SHORT_REASON,
    };

    await expect(mergeSessionPr(params, deps)).rejects.toThrow(/at least one prior review round/);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("rejects when a required status check is failing (CI-not-green)", async () => {
    const { deps, mocks } = buildDeps(
      changesRequestedStatus({
        metadata: {
          github: {
            statusChecks: [
              { context: "bundle-boot-smoke", state: "failure" },
              { context: "build", state: "success" },
            ],
          },
        },
      })
    );
    const params: SessionMergeParams = {
      session: "bypass-session",
      json: true,
      forceBypass: true,
      bypassReason: SHORT_REASON,
    };

    await expect(mergeSessionPr(params, deps)).rejects.toThrow(/status check\(s\) failing/);
    await expect(mergeSessionPr(params, deps)).rejects.toThrow(/bundle-boot-smoke/);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("rejects when a non-approval merge blocker is active", async () => {
    const { deps, mocks } = buildDeps(
      changesRequestedStatus({
        hasNonApprovalMergeBlockers: true,
        nonApprovalBlockerDescription: "merge conflicts",
        prState: "open",
      })
    );
    const params: SessionMergeParams = {
      session: "bypass-session",
      json: true,
      forceBypass: true,
      bypassReason: SHORT_REASON,
    };

    await expect(mergeSessionPr(params, deps)).rejects.toThrow(/non-approval merge blocker/);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("dismisses CHANGES_REQUESTED, merges, and writes the canonical audit signature", async () => {
    const { deps, mocks } = buildDeps(changesRequestedStatus());
    const reason = "PR #1447 reviewer CHANGES_REQUESTED is a verified false-positive (mt#2211)";
    const params: SessionMergeParams = {
      session: "bypass-session",
      json: true,
      forceBypass: true,
      bypassReason: reason,
    };

    const result = await mergeSessionPr(params, deps);

    expect(result).toBeDefined();
    expect(result.session).toBe("bypass-session");

    // The blocking review was dismissed via the backend primitive, using the reason as evidence.
    expect(mocks.dismissReview).toHaveBeenCalledTimes(1);
    expect(mocks.dismissReview).toHaveBeenCalledWith(1447, 55501, { message: reason });

    // The merge was invoked, and the third argument carries the canonical audit signature.
    expect(mocks.merge).toHaveBeenCalledTimes(1);
    const mergeOptions = mocks.merge.mock.calls[0][2] as { bypassAuditMessage?: string };
    expect(mergeOptions.bypassAuditMessage).toBeDefined();
    expect(mergeOptions.bypassAuditMessage).toContain(
      "Bot self-approval bypass per feedback_self_authored_pr_merge_constraints"
    );
    expect(mergeOptions.bypassAuditMessage).toContain(reason);
    expect(mergeOptions.bypassAuditMessage).toContain("55501");
  });

  it("does not set the bypass audit signature on the standard approved path", async () => {
    const approvedStatus = {
      isApproved: true,
      canMerge: true,
      hasNonApprovalMergeBlockers: false,
      approvals: [
        {
          reviewId: "r2",
          approvedBy: REVIEWER_BOT,
          approvedAt: new Date().toISOString(),
          prNumber: 1447,
        },
      ],
      requiredApprovals: 1,
      prState: "open" as const,
      rawReviews: [
        {
          reviewId: "r2",
          reviewerLogin: REVIEWER_BOT,
          state: "APPROVED",
          submittedAt: new Date().toISOString(),
        },
      ],
    };
    const { deps, mocks } = buildDeps(approvedStatus);

    // No forceBypass flag — standard path must be unchanged.
    const result = await mergeSessionPr({ session: "bypass-session", json: true }, deps);

    expect(result).toBeDefined();
    expect(mocks.dismissReview).not.toHaveBeenCalled();
    expect(mocks.merge).toHaveBeenCalledTimes(1);
    const mergeOptions = mocks.merge.mock.calls[0][2] as { bypassAuditMessage?: string };
    expect(mergeOptions.bypassAuditMessage).toBeUndefined();
  });
});
