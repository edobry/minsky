/**
 * Tests for session.pr.drive's postMerge deploy-watch mode (mt#2647).
 *
 * Covers: explicit services override, deploy-surface auto-detection from
 * the PR's changed files (via findAffectedServices), the no-deploy-surface
 * skip path, and per-service deployment-wait composition.
 */
import { describe, expect, test } from "bun:test";
import {
  sessionPrDrivePostMerge,
  type SessionPrDrivePostMergeDependencies,
} from "./pr-drive-post-merge-subcommand";
import type { DeploymentRecord } from "../../deployment/index";
import type { PrChangedFile, RepositoryBackend } from "../../repository/index";
import type { SessionProviderInterface, SessionRecord } from "../types";

const SESSION_ID = "test-session";
const PR_NUMBER = 456;
const AVAILABLE_SERVICES = ["reviewer", "cockpit", "site"];

function mkDeployment(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    id: "dep-1",
    status: "SUCCESS",
    commitHash: "abc123",
    commitMessage: "test",
    imageDigest: null,
    createdAt: "2026-07-07T00:00:00Z",
    finishedAt: "2026-07-07T00:05:00Z",
    durationMs: 300_000,
    url: null,
    ...overrides,
  };
}

function makeDeps(
  changedFiles: PrChangedFile[],
  deploymentByService: Record<string, DeploymentRecord> = {}
): SessionPrDrivePostMergeDependencies & {
  waitCalls: Array<{ service: string; notBefore?: string }>;
} {
  const sessionRecord: SessionRecord = {
    session: SESSION_ID,
    repoName: "edobry-minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: "2026-07-07T00:00:00Z",
    pullRequest: { number: PR_NUMBER, branch: "task/mt-test", baseBranch: "main" },
    taskId: "mt#2647",
  } as unknown as SessionRecord;

  const sessionDB = {
    getSession: async (id: string) => (id === SESSION_ID ? sessionRecord : null),
  } as unknown as SessionProviderInterface;

  const backend: RepositoryBackend = {
    review: {
      listChangedFiles: async () => changedFiles,
    },
  } as unknown as RepositoryBackend;

  const waitCalls: Array<{ service: string; notBefore?: string }> = [];

  return {
    sessionDB,
    createBackend: async () => backend,
    listAvailableServices: () => AVAILABLE_SERVICES,
    waitForDeployment: async (service: string, options?: { notBefore?: string }) => {
      // mt#3890: the options are recorded, not just the service name — whether
      // the bound reaches the adapter is the thing under test.
      waitCalls.push({ service, notBefore: options?.notBefore });
      return deploymentByService[service] ?? mkDeployment();
    },
    get waitCalls() {
      return waitCalls;
    },
  } as unknown as SessionPrDrivePostMergeDependencies & {
    waitCalls: Array<{ service: string; notBefore?: string }>;
  };
}

describe("sessionPrDrivePostMerge", () => {
  test("explicit services override skips changed-file detection", async () => {
    const deps = makeDeps([]);
    const result = await sessionPrDrivePostMerge(
      { sessionId: SESSION_ID, services: ["reviewer"] },
      deps
    );

    expect(result.skipped).toBe(false);
    expect(result.watchedServices).toEqual(["reviewer"]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.service).toBe("reviewer");
    expect(result.results[0]?.deployment.status).toBe("SUCCESS");
    expect(result.matchedFiles).toEqual([]);
  });

  test("auto-detects the affected service from a services/<name>/... deploy-surface file", async () => {
    const deps = makeDeps([{ filename: "services/reviewer/Dockerfile", status: "modified" }]);
    const result = await sessionPrDrivePostMerge({ sessionId: SESSION_ID }, deps);

    expect(result.skipped).toBe(false);
    expect(result.watchedServices).toEqual(["reviewer"]);
    expect(result.matchedFiles).toEqual(["services/reviewer/Dockerfile"]);
    expect(deps.waitCalls).toEqual([{ service: "reviewer" }]);
  });

  test("an infra/ change auto-detects as broad impact across every available service", async () => {
    const deps = makeDeps([{ filename: "infra/index.ts", status: "modified" }]);
    const result = await sessionPrDrivePostMerge({ sessionId: SESSION_ID }, deps);

    expect(result.skipped).toBe(false);
    expect(result.watchedServices).toEqual(["cockpit", "reviewer", "site"]);
    expect(deps.waitCalls).toHaveLength(3);
  });

  test("no deploy-surface files changed -> skipped, no deployment waits performed", async () => {
    const deps = makeDeps([{ filename: "src/domain/session.ts", status: "modified" }]);
    const result = await sessionPrDrivePostMerge({ sessionId: SESSION_ID }, deps);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("no deploy-surface files changed by this PR");
    expect(result.watchedServices).toEqual([]);
    expect(deps.waitCalls).toHaveLength(0);
  });

  test("empty explicit services list is skipped rather than treated as auto-detect", async () => {
    const deps = makeDeps([{ filename: "infra/index.ts", status: "modified" }]);
    const result = await sessionPrDrivePostMerge({ sessionId: SESSION_ID, services: [] }, deps);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("explicit services list was empty");
    // Confirms the empty override did NOT fall through to auto-detection
    // (which would have matched infra/index.ts as broad impact).
    expect(deps.waitCalls).toHaveLength(0);
  });

  test("reports a FAILED terminal deployment without throwing", async () => {
    const deps = makeDeps([{ filename: "services/cockpit/deploy.config.ts", status: "modified" }], {
      cockpit: mkDeployment({ status: "FAILED", id: "dep-fail" }),
    });
    const result = await sessionPrDrivePostMerge({ sessionId: SESSION_ID }, deps);

    expect(result.skipped).toBe(false);
    expect(result.results[0]?.deployment.status).toBe("FAILED");
  });
});

/**
 * mt#3890, reviewer round 1: the `notBefore` mechanism only matters if the
 * production post-merge watch actually passes it. PR #2750's first revision
 * shipped the mechanism with no caller — the bot correctly flagged that the
 * legacy unbounded path was still the only one in use.
 */
describe("sessionPrDrivePostMerge deployment bound (mt#3890)", () => {
  const MERGED_AT = "2026-08-09T03:50:26.330Z";

  test("threads mergedAt to every service's deployment wait", async () => {
    const deps = makeDeps([]);
    const result = await sessionPrDrivePostMerge(
      { sessionId: SESSION_ID, services: ["reviewer", "minsky-mcp"], mergedAt: MERGED_AT },
      deps
    );

    expect(result.deployBoundApplied).toBe(true);
    expect(deps.waitCalls).toHaveLength(2);
    // Every service, not just the first — an unbounded wait on any one of them
    // is a deploy that can silently pass.
    for (const call of deps.waitCalls) {
      expect(call.notBefore).toBe(MERGED_AT);
    }
  });

  test("reports deployBoundApplied: false when no mergedAt is supplied", async () => {
    const deps = makeDeps([]);
    const result = await sessionPrDrivePostMerge(
      { sessionId: SESSION_ID, services: ["reviewer"] },
      deps
    );

    // The unbounded watch still runs (back-compat), but the result says so —
    // a SUCCESS from it is not evidence this merge deployed, and the caller
    // can now tell the difference.
    expect(result.deployBoundApplied).toBe(false);
    expect(deps.waitCalls[0]?.notBefore).toBeUndefined();
  });

  test("a skipped watch reports the bound as applied, not as unbounded", async () => {
    const deps = makeDeps([]);
    const result = await sessionPrDrivePostMerge({ sessionId: SESSION_ID, services: [] }, deps);

    expect(result.skipped).toBe(true);
    expect(result.deployBoundApplied).toBe(true);
    expect(deps.waitCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Per-service build identity (mt#4583)
// ---------------------------------------------------------------------------
//
// PR #3349 R1 caught the shape these guard: `mergedCommitSha` reached the
// implementation but was dropped before it could affect anything, and typecheck
// passed either way. A wiring assertion is the only thing that can see that.

describe("sessionPrDrivePostMerge build identity (mt#4583)", () => {
  const MERGE_SHA = "b65baf9402d64e78d368ae17e2a805fe29b55126";
  const NEIGHBOUR_SHA = "ce9af92bf0432cf8059527f1f9d721441503878a";

  test("mergedCommitSha reaches the verdict — confirmed when the deployment names it", async () => {
    const deps = makeDeps([], {
      reviewer: mkDeployment({ commitHash: MERGE_SHA }),
    });

    const result = await sessionPrDrivePostMerge(
      { sessionId: SESSION_ID, services: ["reviewer"], mergedCommitSha: MERGE_SHA },
      deps
    );

    expect(result.results[0]?.buildIdentity).toBe("confirmed");
  });

  test("a neighbouring merge's deployment is a mismatch — the incident's shape, per service", async () => {
    const deps = makeDeps([], {
      reviewer: mkDeployment({ commitHash: NEIGHBOUR_SHA }),
    });

    const result = await sessionPrDrivePostMerge(
      { sessionId: SESSION_ID, services: ["reviewer"], mergedCommitSha: MERGE_SHA },
      deps
    );

    // A deploy DID succeed — which is exactly why status alone was not enough.
    expect(result.results[0]?.deployment.status).toBe("SUCCESS");
    expect(result.results[0]?.buildIdentity).toBe("mismatch");
    expect(result.results[0]?.buildIdentityReason).toContain("not yours");
  });

  test("indeterminate when no merge commit is supplied — omission is not a pass", async () => {
    const deps = makeDeps([], { reviewer: mkDeployment({ commitHash: MERGE_SHA }) });

    const result = await sessionPrDrivePostMerge(
      { sessionId: SESSION_ID, services: ["reviewer"] },
      deps
    );

    expect(result.results[0]?.buildIdentity).toBe("indeterminate");
  });

  test("verdicts are per service — one can carry the merge while another serves a neighbour's build", async () => {
    const deps = makeDeps([{ filename: "infra/index.ts", status: "modified" }], {
      cockpit: mkDeployment({ commitHash: MERGE_SHA }),
      reviewer: mkDeployment({ commitHash: NEIGHBOUR_SHA }),
      site: mkDeployment({ commitHash: null }),
    });

    const result = await sessionPrDrivePostMerge(
      { sessionId: SESSION_ID, mergedCommitSha: MERGE_SHA },
      deps
    );

    const byService = Object.fromEntries(result.results.map((r) => [r.service, r.buildIdentity]));
    expect(byService).toEqual({
      cockpit: "confirmed",
      reviewer: "mismatch",
      site: "indeterminate",
    });
  });
});

describe("sessionPrDrivePostMerge session resolution after cleanup (mt#4425)", () => {
  /**
   * Post-merge mode runs AFTER the merge, and a successful merge cleans the
   * session up — so failing to resolve `--task` here is the ORDINARY state, not
   * an exotic one. It used to surface as a bare `No session found for task ID`,
   * which reads as a dead end at exactly the moment the caller is mid-deploy-
   * verification and has two working alternatives available.
   */
  function depsWithNoSessionForTask(): SessionPrDrivePostMergeDependencies {
    const deps = makeDeps([]);
    // Both stubs are needed to reach the REAL failure. With `listSessions`
    // missing the resolver dies on the mock's own shape instead, which would
    // make these tests assert that the guard wraps any error — a weaker claim
    // than the one under test, and one that would pass even if the genuine
    // session-absent path stopped behaving this way.
    Object.assign(deps.sessionDB as unknown as Record<string, unknown>, {
      getSessionByTaskId: async () => null,
      listSessions: async () => [],
    });
    return deps;
  }

  test("names the explicit-services alternative", async () => {
    await expect(
      sessionPrDrivePostMerge({ task: "mt#4425" }, depsWithNoSessionForTask())
    ).rejects.toThrow(/services/);
  });

  test("names verify-deploy.ts, which needs no session at all", async () => {
    await expect(
      sessionPrDrivePostMerge({ task: "mt#4425" }, depsWithNoSessionForTask())
    ).rejects.toThrow(/verify-deploy\.ts/);
  });

  test("says the failure is EXPECTED after a merge rather than implying a fault", async () => {
    await expect(
      sessionPrDrivePostMerge({ task: "mt#4425" }, depsWithNoSessionForTask())
    ).rejects.toThrow(/EXPECTED/);
  });

  test("preserves the underlying resolution error rather than swallowing it", async () => {
    await expect(
      sessionPrDrivePostMerge({ task: "mt#4425" }, depsWithNoSessionForTask())
    ).rejects.toThrow(/No session found for task ID/);
  });

  test("a non-not-found failure propagates unchanged rather than being relabelled", async () => {
    // PR #3394 R1 BLOCKING: the guidance wrapper originally caught EVERY error,
    // so a backend outage, an auth failure, or the ValidationError raised when a
    // task matches multiple sessions all became "no session found" — sending
    // callers that branch on error type, and observability, to the wrong cause.
    const deps = makeDeps([]);
    Object.assign(deps.sessionDB as unknown as Record<string, unknown>, {
      getSessionByTaskId: async () => {
        throw new Error("backend unavailable: connection refused");
      },
      listSessions: async () => [],
    });

    await expect(sessionPrDrivePostMerge({ task: "mt#4425" }, deps)).rejects.toThrow(
      /backend unavailable/
    );
    // And it must NOT acquire the post-merge guidance, which would be actively
    // misleading for a failure that has nothing to do with session cleanup.
    await expect(sessionPrDrivePostMerge({ task: "mt#4425" }, deps)).rejects.not.toThrow(
      /verify-deploy\.ts/
    );
  });

  test("negative control: a resolvable session still auto-detects, no throw", async () => {
    // Same code path, session present — so the guard above is specific to the
    // resolution failure and is not swallowing the happy path.
    const result = await sessionPrDrivePostMerge(
      { sessionId: SESSION_ID, services: ["reviewer"] },
      makeDeps([])
    );
    expect(result.skipped).toBe(false);
    expect(result.watchedServices).toEqual(["reviewer"]);
  });
});
