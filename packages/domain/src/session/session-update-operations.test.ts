/**
 * Tests for refreshDependenciesIfLockfileChanged (mt#2821).
 *
 * Simulates a lockfile-changing rebase by diffing two commit SHAs whose
 * changed-file set includes bun.lock / package.json, and verifies the
 * install functions are invoked with the session workdir — closing the
 * "3 parallel sessions failed with Cannot find module ... until manual bun
 * install" gap (conversation c01f89af) without requiring a live git repo or
 * a real package-manager install.
 */
import { describe, expect, test, mock } from "bun:test";
import {
  refreshDependenciesIfLockfileChanged,
  type DependencyInstallDeps,
} from "./session-update-operations";
import type { GitServiceInterface } from "../git";

const WORKDIR = "/tmp/session-workdir";
const PRE_SHA = "aaaaaaa1111111111111111111111111111111";
const POST_SHA = "bbbbbbb2222222222222222222222222222222";
const NESTED_REVIEWER_PATH = "services/reviewer";

function makeGitService(opts: {
  postSha?: string;
  diffFiles?: string[];
  rejectRevParse?: boolean;
  rejectDiff?: boolean;
}): GitServiceInterface {
  const execInRepository = mock(async (_workdir: string, command: string): Promise<string> => {
    if (command === "git rev-parse HEAD") {
      if (opts.rejectRevParse) {
        throw new Error("git rev-parse failed");
      }
      return `${opts.postSha ?? POST_SHA}\n`;
    }
    if (command.startsWith("git diff --name-only")) {
      if (opts.rejectDiff) {
        throw new Error("git diff failed");
      }
      return `${(opts.diffFiles ?? []).join("\n")}\n`;
    }
    throw new Error(`Unexpected command in test fake: ${command}`);
  });

  return { execInRepository } as unknown as GitServiceInterface;
}

function makeInstallDeps(opts: {
  installSuccess?: boolean;
  installError?: string;
  nestedResults?: Array<{ path: string; success: boolean; error?: string }>;
}): { deps: DependencyInstallDeps; installDependencies: ReturnType<typeof mock> } {
  const installDependencies = mock(async (_repoPath: string, _options?: unknown) => {
    if (opts.installSuccess === false) {
      return { success: false, error: opts.installError ?? "install failed" };
    }
    return { success: true, output: "" };
  });

  const installNestedDependencies = mock(async (_repoPath: string, _options?: unknown) => {
    const results = opts.nestedResults ?? [];
    return {
      attempted: results.length,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    };
  });

  return {
    deps: { installDependencies, installNestedDependencies } as unknown as DependencyInstallDeps,
    installDependencies,
  };
}

describe("refreshDependenciesIfLockfileChanged", () => {
  test("no-op when preUpdateSha is undefined (could not be captured)", async () => {
    const gitService = makeGitService({});
    const { deps, installDependencies } = makeInstallDeps({});

    const result = await refreshDependenciesIfLockfileChanged(WORKDIR, gitService, undefined, deps);

    expect(result).toEqual({ checked: false, changed: false, installed: false });
    expect(installDependencies).not.toHaveBeenCalled();
  });

  test("no-op when HEAD did not move (nothing was pulled)", async () => {
    const gitService = makeGitService({ postSha: PRE_SHA });
    const { deps, installDependencies } = makeInstallDeps({});

    const result = await refreshDependenciesIfLockfileChanged(WORKDIR, gitService, PRE_SHA, deps);

    expect(result.checked).toBe(true);
    expect(result.changed).toBe(false);
    expect(installDependencies).not.toHaveBeenCalled();
  });

  test("no-op when the pulled range changed unrelated files only", async () => {
    const gitService = makeGitService({ diffFiles: ["src/foo.ts", "docs/readme.md"] });
    const { deps, installDependencies } = makeInstallDeps({});

    const result = await refreshDependenciesIfLockfileChanged(WORKDIR, gitService, PRE_SHA, deps);

    expect(result.changed).toBe(false);
    expect(installDependencies).not.toHaveBeenCalled();
  });

  test("simulated lockfile-changing rebase: bun.lock in the pulled range triggers install", async () => {
    const gitService = makeGitService({ diffFiles: ["bun.lock", "src/foo.ts"] });
    const { deps, installDependencies } = makeInstallDeps({
      nestedResults: [{ path: NESTED_REVIEWER_PATH, success: true }],
    });

    const result = await refreshDependenciesIfLockfileChanged(WORKDIR, gitService, PRE_SHA, deps);

    expect(result.checked).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.installed).toBe(true);
    expect(installDependencies).toHaveBeenCalledTimes(1);
    expect(installDependencies).toHaveBeenCalledWith(WORKDIR, { quiet: false });
  });

  test("a nested package.json change (not just root) also triggers install", async () => {
    const gitService = makeGitService({ diffFiles: [`${NESTED_REVIEWER_PATH}/package.json`] });
    const { deps, installDependencies } = makeInstallDeps({});

    const result = await refreshDependenciesIfLockfileChanged(WORKDIR, gitService, PRE_SHA, deps);

    expect(result.changed).toBe(true);
    expect(installDependencies).toHaveBeenCalledTimes(1);
  });

  test("root package.json change also triggers install", async () => {
    const gitService = makeGitService({ diffFiles: ["package.json"] });
    const { deps, installDependencies } = makeInstallDeps({});

    const result = await refreshDependenciesIfLockfileChanged(WORKDIR, gitService, PRE_SHA, deps);

    expect(result.changed).toBe(true);
    expect(installDependencies).toHaveBeenCalledTimes(1);
  });

  test("reports install failure without throwing (actionable-notice path)", async () => {
    const gitService = makeGitService({ diffFiles: ["bun.lock"] });
    const { deps } = makeInstallDeps({ installSuccess: false, installError: "network error" });

    const result = await refreshDependenciesIfLockfileChanged(WORKDIR, gitService, PRE_SHA, deps);

    expect(result.changed).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.installError).toBe("network error");
  });

  test("does not attempt nested installs when the root install fails", async () => {
    const gitService = makeGitService({ diffFiles: ["bun.lock"] });
    const installNestedDependencies = mock(async () => ({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    }));
    const failingInstallDependencies = mock(async () => ({
      success: false,
      error: "boom",
    }));
    const deps: DependencyInstallDeps = {
      installDependencies:
        failingInstallDependencies as unknown as DependencyInstallDeps["installDependencies"],
      installNestedDependencies:
        installNestedDependencies as unknown as DependencyInstallDeps["installNestedDependencies"],
    };

    await refreshDependenciesIfLockfileChanged(WORKDIR, gitService, PRE_SHA, deps);

    expect(installNestedDependencies).not.toHaveBeenCalled();
  });

  test("reports nested install failures alongside a successful root install", async () => {
    const gitService = makeGitService({ diffFiles: ["bun.lock"] });
    const { deps } = makeInstallDeps({
      nestedResults: [
        { path: NESTED_REVIEWER_PATH, success: false, error: "nested boom" },
        { path: "services/site", success: true },
      ],
    });

    const result = await refreshDependenciesIfLockfileChanged(WORKDIR, gitService, PRE_SHA, deps);

    expect(result.installed).toBe(true);
    expect(result.nestedFailedPaths).toEqual([NESTED_REVIEWER_PATH]);
  });

  test("does not throw when git rev-parse fails (best-effort)", async () => {
    const gitService = makeGitService({ rejectRevParse: true });
    const { deps, installDependencies } = makeInstallDeps({});

    const result = await refreshDependenciesIfLockfileChanged(WORKDIR, gitService, PRE_SHA, deps);

    expect(result.checked).toBe(false);
    expect(installDependencies).not.toHaveBeenCalled();
  });

  test("does not throw when git diff fails (best-effort)", async () => {
    const gitService = makeGitService({ rejectDiff: true });
    const { deps, installDependencies } = makeInstallDeps({});

    const result = await refreshDependenciesIfLockfileChanged(WORKDIR, gitService, PRE_SHA, deps);

    expect(result.checked).toBe(true);
    expect(result.changed).toBe(false);
    expect(installDependencies).not.toHaveBeenCalled();
  });
});
