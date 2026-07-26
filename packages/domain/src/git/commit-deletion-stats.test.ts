/* eslint-disable custom/no-real-fs-in-tests -- real git repos are required to exercise diff/name-status semantics */
/**
 * Tests for computeCommitDeletionStats (mt#3021 SC3).
 *
 * Uses real temp git repos (same idiom as merge-simulation.test.ts /
 * merge-abort.integration.test.ts) since the invariant under test is git's
 * own `diff --name-status` semantics, which a fake git service cannot
 * meaningfully stand in for.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import {
  computeCommitDeletionStats,
  DEFAULT_MASS_DELETION_THRESHOLD,
} from "./commit-deletion-stats";

const gitEnv = (cwd: string) => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: cwd,
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: gitEnv(cwd) });
}

/** Minimal GitServiceInterface slice computeCommitDeletionStats needs. */
function realExecInRepository(repo: string) {
  return {
    execInRepository: async (workdir: string, command: string): Promise<string> => {
      // Command strings here are always `git <args...>`; exec via shell so
      // the safeShellQuote-wrapped arguments in the module under test parse
      // identically to how it runs in production (execAsync/@minsky/shared/exec).
      const { execSync } = await import("child_process");
      return execSync(command, { cwd: workdir, env: gitEnv(repo) }).toString();
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mt3021-deletion-stats-"));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("computeCommitDeletionStats", () => {
  it("returns null for a root commit (no parent to diff against)", async () => {
    await writeFile(join(dir, "a.txt"), "a");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-m", "root commit");

    const result = await computeCommitDeletionStats(realExecInRepository(dir), dir);
    expect(result).toBeNull();
  });

  it("counts deleted files (D name-status) relative to the first parent", async () => {
    await writeFile(join(dir, "keep.txt"), "keep");
    await writeFile(join(dir, "del1.txt"), "1");
    await writeFile(join(dir, "del2.txt"), "2");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "initial");

    await unlink(join(dir, "del1.txt"));
    await unlink(join(dir, "del2.txt"));
    await writeFile(join(dir, "keep.txt"), "keep, modified");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "delete two files, modify one");

    const result = await computeCommitDeletionStats(realExecInRepository(dir), dir);
    expect(result).not.toBeNull();
    expect(result?.deletionCount).toBe(2);
    expect(result?.sampleDeletedPaths.sort()).toEqual(["del1.txt", "del2.txt"]);
  });

  it("does NOT count a detected rename as a deletion (AT3-adjacent no-over-fire)", async () => {
    await writeFile(
      join(dir, "original.txt"),
      "some fairly long content so rename detection works well and is not treated as add+delete"
    );
    git(dir, "add", ".");
    git(dir, "commit", "-m", "initial");

    await execFileSync("git", ["mv", "original.txt", "renamed.txt"], {
      cwd: dir,
      env: gitEnv(dir),
    });
    git(dir, "commit", "-m", "rename file");

    const result = await computeCommitDeletionStats(realExecInRepository(dir), dir);
    expect(result).not.toBeNull();
    expect(result?.deletionCount).toBe(0);
  });

  it("a normal-sized commit does not approach the calibrated threshold (no-over-fire sanity check)", async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, `f${i}.txt`), String(i));
    }
    git(dir, "add", ".");
    git(dir, "commit", "-m", "initial 10 files");

    for (let i = 0; i < 5; i++) {
      await unlink(join(dir, `f${i}.txt`));
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "delete 5 of 10 files");

    const result = await computeCommitDeletionStats(realExecInRepository(dir), dir);
    expect(result?.deletionCount).toBe(5);
    expect(result?.deletionCount).toBeLessThan(DEFAULT_MASS_DELETION_THRESHOLD);
  });
});
