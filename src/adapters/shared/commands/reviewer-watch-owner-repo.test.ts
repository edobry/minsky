/**
 * Tests for reviewer-watch owner/repo resolution (mt#2455).
 *
 * `resolveWatchConfig` / `resolveWatchOwnerRepo` used to fall back to the
 * hardcoded literals `"edobry"` / `"minsky"` when nothing else resolved —
 * baking Minsky's own repo into shipped domain-adjacent code. This pins the
 * new resolution chain (params → env → project config → git origin) and the
 * loud, defined-absent-behavior error when none of those sources resolve
 * (matching the `botLogin` precedent from mt#2392 in the same file).
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  resolveWatchConfig,
  resolveWatchOwnerRepo,
  type ResolveWatchConfigDeps,
} from "./reviewer-watch";
import type { GitHubRepoDetectionDeps } from "@minsky/domain/tasks/githubBackendConfig";

const OWNER_ENV = "MINSKY_REVIEWER_WATCH_OWNER";
const REPO_ENV = "MINSKY_REVIEWER_WATCH_REPO";
const ENV_KEYS = [OWNER_ENV, REPO_ENV] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Set both watch env vars at once (or clear with `undefined`). */
function setWatchEnv(owner: string | undefined, repo: string | undefined): void {
  if (owner === undefined) delete process.env[OWNER_ENV];
  else process.env[OWNER_ENV] = owner;
  if (repo === undefined) delete process.env[REPO_ENV];
  else process.env[REPO_ENV] = repo;
}

/** Git-detection deps that assert `origin` is never even consulted. */
const noGitWorkTree: GitHubRepoDetectionDeps = {
  execSync: () => {
    throw new Error("execSync should not be called when not inside a git work tree");
  },
  isDirectory: () => false,
  isInsideGitWorkTree: () => false,
};

/** Git-detection deps that resolve `origin` to a fixed GitHub HTTPS remote. */
function gitOriginResolvesTo(owner: string, repo: string): GitHubRepoDetectionDeps {
  return {
    execSync: () => `https://github.com/${owner}/${repo}.git`,
    isDirectory: () => false,
    isInsideGitWorkTree: () => true,
  };
}

/** Deps with every source disabled — the "nothing resolvable" baseline. */
const nothingResolvable: ResolveWatchConfigDeps = {
  githubConfig: {},
  gitDetection: noGitWorkTree,
};

/** Capture a thrown error (or undefined) from a resolver call. */
function captureThrown(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("resolveWatchOwnerRepo (mt#2455)", () => {
  it("explicit params win over every other source", () => {
    setWatchEnv("env-owner", "env-repo");
    const result = resolveWatchOwnerRepo(
      { owner: "param-owner", repo: "param-repo" },
      {
        githubConfig: { organization: "config-owner", repository: "config-repo" },
        gitDetection: gitOriginResolvesTo("origin-owner", "origin-repo"),
      }
    );
    expect(result).toEqual({ owner: "param-owner", repo: "param-repo" });
  });

  it("env vars win over config and git origin when params are absent", () => {
    setWatchEnv("env-owner", "env-repo");
    const result = resolveWatchOwnerRepo(
      {},
      {
        githubConfig: { organization: "config-owner", repository: "config-repo" },
        gitDetection: gitOriginResolvesTo("origin-owner", "origin-repo"),
      }
    );
    expect(result).toEqual({ owner: "env-owner", repo: "env-repo" });
  });

  it("resolves from configured github.organization/github.repository when params and env are absent", () => {
    setWatchEnv(undefined, undefined);
    const result = resolveWatchOwnerRepo(
      {},
      {
        githubConfig: { organization: "config-owner", repository: "config-repo" },
        gitDetection: gitOriginResolvesTo("origin-owner", "origin-repo"),
      }
    );
    expect(result).toEqual({ owner: "config-owner", repo: "config-repo" });
  });

  it("falls back to the git origin remote when params, env, and config are all absent", () => {
    setWatchEnv(undefined, undefined);
    const result = resolveWatchOwnerRepo(
      {},
      {
        githubConfig: {},
        gitDetection: gitOriginResolvesTo("origin-owner", "origin-repo"),
      }
    );
    expect(result).toEqual({ owner: "origin-owner", repo: "origin-repo" });
  });

  it("resolves owner and repo independently across different sources", () => {
    setWatchEnv("env-owner", undefined);
    const result = resolveWatchOwnerRepo(
      {},
      {
        githubConfig: { repository: "config-repo" },
        gitDetection: gitOriginResolvesTo("origin-owner", "origin-repo"),
      }
    );
    expect(result).toEqual({ owner: "env-owner", repo: "config-repo" });
  });

  it("throws a loud error naming every resolution path when nothing resolves", () => {
    setWatchEnv(undefined, undefined);
    const thrown = captureThrown(() => resolveWatchOwnerRepo({}, nothingResolvable));
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("owner");
    expect(message).toContain("repo");
    expect(message).toContain(OWNER_ENV);
    expect(message).toContain(REPO_ENV);
    expect(message).toContain("github.organization");
    expect(message).toContain("github.repository");
    expect(message).toContain("origin");
  });

  it("never silently defaults to a Minsky-specific repo when nothing resolves", () => {
    setWatchEnv(undefined, undefined);
    expect(() => resolveWatchOwnerRepo({}, nothingResolvable)).toThrow();
  });

  it("names only the missing field when one side resolves and the other doesn't", () => {
    setWatchEnv(undefined, undefined);
    const thrown = captureThrown(() =>
      resolveWatchOwnerRepo(
        { owner: "param-owner" },
        { githubConfig: {}, gitDetection: noGitWorkTree }
      )
    );
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("repo");
  });
});

describe("resolveWatchConfig owner/repo integration (mt#2455)", () => {
  it("propagates resolved owner/repo alongside botLogin/threshold", () => {
    setWatchEnv(undefined, undefined);
    const config = resolveWatchConfig(
      { botLogin: "some-bot[bot]", threshold: 3 },
      {
        githubConfig: { organization: "config-owner", repository: "config-repo" },
        gitDetection: noGitWorkTree,
      }
    );
    expect(config.owner).toBe("config-owner");
    expect(config.repo).toBe("config-repo");
    expect(config.botLogin).toBe("some-bot[bot]");
    expect(config.threshold).toBe(3);
  });

  it("propagates the unresolved-owner/repo error out of resolveWatchConfig", () => {
    setWatchEnv(undefined, undefined);
    expect(() => resolveWatchConfig({}, nothingResolvable)).toThrow(/could not resolve/);
  });
});
