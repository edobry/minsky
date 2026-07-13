/**
 * Real (non-mocked) integration coverage for `detectDefaultBranch` (mt#2646
 * R1 BLOCKING #2): the dispatch-recovery probe must DETECT the repo's actual
 * default branch via `git symbolic-ref refs/remotes/origin/HEAD` rather than
 * hardcoding "main" — a repo whose default branch differs would otherwise
 * silently mis-compute `commitsAheadOfBase`.
 *
 * Uses real temporary git repos (not a mocked `Bun.spawn`) so both the
 * "detected default" and "undetectable" paths exercise the actual git
 * subprocess + parsing pipeline. `git symbolic-ref <name> <target>` accepts
 * an arbitrary target ref without requiring the target to exist or a real
 * remote to be configured, which makes this a fast, hermetic setup.
 */
/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: this test exercises the
   REAL `git symbolic-ref` subprocess against real temp git repos (the exact behavior
   detectDefaultBranch depends on); mocking fs/Bun.spawn would defeat the point of the test */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectDefaultBranch } from "./session-workspace";

const tempDirs: string[] = [];

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mt2646-detect-default-branch-"));
  tempDirs.push(dir);
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, stderr: "pipe" });
  if (init.exitCode !== 0) {
    throw new Error(`git init failed: ${init.stderr.toString()}`);
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("detectDefaultBranch (real git subprocess, mt#2646 R1)", () => {
  test("detected default: reads the branch name from a real symbolic-ref pointing at origin/main", async () => {
    const dir = makeTempGitRepo();
    const setRef = Bun.spawnSync(
      ["git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
      { cwd: dir }
    );
    expect(setRef.exitCode).toBe(0);

    const result = await detectDefaultBranch(dir);
    expect(result).toBe("main");
  });

  test("detected default: correctly reads a non-'main' default branch name", async () => {
    const dir = makeTempGitRepo();
    const setRef = Bun.spawnSync(
      ["git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"],
      { cwd: dir }
    );
    expect(setRef.exitCode).toBe(0);

    const result = await detectDefaultBranch(dir);
    expect(result).toBe("master");
  });

  test("undetectable: a repo with no origin symbolic-ref set returns null, not a guessed 'main'", async () => {
    const dir = makeTempGitRepo();
    // No `git symbolic-ref refs/remotes/origin/HEAD ...` was ever run — git
    // itself will fail this lookup with a non-zero exit code.
    const result = await detectDefaultBranch(dir);
    expect(result).toBeNull();
  });

  test("undetectable: a non-git directory returns null rather than throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mt2646-not-a-git-repo-"));
    tempDirs.push(dir);
    const result = await detectDefaultBranch(dir);
    expect(result).toBeNull();
  });
});
