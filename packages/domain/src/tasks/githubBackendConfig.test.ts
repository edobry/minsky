/**
 * Tests for extractGitHubRepoFromRemote's local-path origin handling (mt#2470).
 *
 * The local-path branch uses the value returned by `git remote get-url origin`
 * as a subprocess cwd. That value is usually a URL, so before the cwd use it
 * must be validated as an absolute, existing path inside a git work tree —
 * a URL or non-work-tree path must never reach execSync as cwd.
 *
 * All deps are injected (no real fs / subprocess).
 */

import { describe, test, expect } from "bun:test";
import { extractGitHubRepoFromRemote, type GitHubRepoDetectionDeps } from "./githubBackendConfig";

const WORKSPACE = "/work/space";
const LOCAL_ORIGIN = "/sessions/some-clone";

/** Build deps where the workspace's origin resolves to `originValue`. */
function makeDeps(
  originValue: string,
  overrides?: Partial<GitHubRepoDetectionDeps> & {
    upstreamValue?: string;
    upstreamThrows?: boolean;
  }
): { deps: GitHubRepoDetectionDeps; cwdsSeen: string[] } {
  const cwdsSeen: string[] = [];
  const deps: GitHubRepoDetectionDeps = {
    execSync: (cmd, opts) => {
      const cwd = opts?.cwd ?? "";
      cwdsSeen.push(cwd);
      if (cwd === WORKSPACE) return Buffer.from(`${originValue}\n`);
      if (cwd === LOCAL_ORIGIN) {
        if (overrides?.upstreamThrows) {
          throw new Error("fatal: no such remote 'origin'");
        }
        return Buffer.from(`${overrides?.upstreamValue ?? ""}\n`);
      }
      throw new Error(`unexpected execSync cwd: ${cwd}`);
    },
    isDirectory: () => true,
    isInsideGitWorkTree: () => true,
    ...overrides,
  };
  return { deps, cwdsSeen };
}

describe("extractGitHubRepoFromRemote local-path origin handling (mt#2470)", () => {
  test("local-path origin with a GitHub upstream resolves owner/repo", () => {
    const { deps } = makeDeps(LOCAL_ORIGIN, {
      upstreamValue: "https://github.com/edobry/minsky.git",
    });
    expect(extractGitHubRepoFromRemote(WORKSPACE, deps)).toEqual({
      owner: "edobry",
      repo: "minsky",
    });
  });

  test("local-path origin with no upstream returns null (no guessing)", () => {
    const { deps } = makeDeps(LOCAL_ORIGIN, { upstreamThrows: true });
    expect(extractGitHubRepoFromRemote(WORKSPACE, deps)).toBeNull();
  });

  test("a URL origin is never used as a subprocess cwd", () => {
    // A non-GitHub URL: fails the github regexes, and MUST NOT enter the
    // local-path branch (isAbsolute fails) even with permissive fs deps.
    const { deps, cwdsSeen } = makeDeps("https://gitlab.com/owner/repo.git");
    expect(extractGitHubRepoFromRemote(WORKSPACE, deps)).toBeNull();
    expect(cwdsSeen).toEqual([WORKSPACE]);
  });

  test("a relative-path origin is never used as a subprocess cwd", () => {
    const { deps, cwdsSeen } = makeDeps("../bare-repo");
    expect(extractGitHubRepoFromRemote(WORKSPACE, deps)).toBeNull();
    expect(cwdsSeen).toEqual([WORKSPACE]);
  });

  test("an absolute path outside a git work tree is not probed (no doomed spawn)", () => {
    const { deps, cwdsSeen } = makeDeps(LOCAL_ORIGIN, {
      isInsideGitWorkTree: (dir) => dir === WORKSPACE, // origin path is NOT a work tree
    });
    expect(extractGitHubRepoFromRemote(WORKSPACE, deps)).toBeNull();
    expect(cwdsSeen).toEqual([WORKSPACE]);
  });

  test("a dangling absolute path is not probed", () => {
    const { deps, cwdsSeen } = makeDeps(LOCAL_ORIGIN, {
      isDirectory: () => false,
    });
    expect(extractGitHubRepoFromRemote(WORKSPACE, deps)).toBeNull();
    expect(cwdsSeen).toEqual([WORKSPACE]);
  });

  test("a FILE inside a work tree is not used as cwd (PR #1690 reviewer finding)", () => {
    // A file path passes an existence check and the upward work-tree walk,
    // but is not a usable cwd — the isDirectory guard must reject it.
    const { deps, cwdsSeen } = makeDeps("/repo/some-file.txt", {
      isDirectory: (p) => p !== "/repo/some-file.txt",
      isInsideGitWorkTree: () => true,
    });
    expect(extractGitHubRepoFromRemote(WORKSPACE, deps)).toBeNull();
    expect(cwdsSeen).toEqual([WORKSPACE]);
  });

  test("workspace outside a git work tree short-circuits with zero spawns (mt#1428)", () => {
    const { deps, cwdsSeen } = makeDeps(LOCAL_ORIGIN, {
      isInsideGitWorkTree: () => false,
    });
    expect(extractGitHubRepoFromRemote(WORKSPACE, deps)).toBeNull();
    expect(cwdsSeen).toEqual([]);
  });

  test("direct GitHub SSH origin resolves without touching the local-path branch", () => {
    const { deps, cwdsSeen } = makeDeps("git@github.com:edobry/minsky.git");
    expect(extractGitHubRepoFromRemote(WORKSPACE, deps)).toEqual({
      owner: "edobry",
      repo: "minsky",
    });
    expect(cwdsSeen).toEqual([WORKSPACE]);
  });
});
