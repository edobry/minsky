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
): SessionPrDrivePostMergeDependencies & { waitCalls: Array<{ service: string }> } {
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

  const waitCalls: Array<{ service: string }> = [];

  return {
    sessionDB,
    createBackend: async () => backend,
    listAvailableServices: () => AVAILABLE_SERVICES,
    waitForDeployment: async (service: string) => {
      waitCalls.push({ service });
      return deploymentByService[service] ?? mkDeployment();
    },
    get waitCalls() {
      return waitCalls;
    },
  } as unknown as SessionPrDrivePostMergeDependencies & { waitCalls: Array<{ service: string }> };
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
