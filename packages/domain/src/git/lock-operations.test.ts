/* eslint-disable custom/no-real-fs-in-tests */
// Justification: this is a git-exec integration test (same class as
// mt1509-deadlock.test.ts) that MUST exercise the real filesystem and real
// git binary — it creates an actual repo, a real (stale and live-held)
// index.lock file, and a real subprocess holding an open file descriptor to
// verify liveness detection. None of this is mockable without hollowing out
// the behavior under test. Cleaned up in afterAll.

/**
 * mt#2820 — index.lock staleness detection + confirm-gated repair.
 *
 * Covers the three git-state-repair acceptance tests from the task spec:
 *   1. A stale zero-byte index.lock (no owning process) is detected and
 *      removed with confirm.
 *   2. A lock held by a LIVE process is reported busy and NOT removed.
 *   3. (ref repair is covered by ref-repair-operations.test.ts)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { exec, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";

import {
  detectIndexLock,
  repairIndexLock,
  isIndexLockError,
  formatLockDiagnostic,
  runGitCommandWithLockHandling,
  LOCK_STALE_THRESHOLD_MS,
} from "./lock-operations";

const execAsync = promisify(exec);

async function realExec(command: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execAsync(command);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const realDeps = { execAsync: realExec };

let tmpBase: string;
let repoPath: string;
let gitDir: string;
let lockPath: string;

beforeAll(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), "minsky-mt2820-lock-"));
  repoPath = join(tmpBase, "repo");
  await mkdir(repoPath, { recursive: true });
  await execAsync(`git init ${JSON.stringify(repoPath)}`);
  await execAsync(`git -C ${JSON.stringify(repoPath)} config user.email "test@example.com"`);
  await execAsync(`git -C ${JSON.stringify(repoPath)} config user.name "Test User"`);
  await writeFile(join(repoPath, "readme.md"), "# test\n");
  await execAsync(`git -C ${JSON.stringify(repoPath)} add .`);
  await execAsync(`git -C ${JSON.stringify(repoPath)} commit -m "initial"`);

  const { stdout } = await execAsync(
    `git -C ${JSON.stringify(repoPath)} rev-parse --absolute-git-dir`
  );
  gitDir = stdout.trim();
  lockPath = join(gitDir, "index.lock");
});

afterAll(async () => {
  if (tmpBase) {
    await rm(tmpBase, { recursive: true, force: true });
  }
});

describe("isIndexLockError", () => {
  test("matches the classic git fatal", () => {
    expect(
      isIndexLockError(
        "fatal: Unable to create '/repo/.git/index.lock': File exists.\n" +
          "Another git process seems to be running in this repository..."
      )
    ).toBe(true);
  });

  test("does not match unrelated stderr", () => {
    expect(isIndexLockError("fatal: bad object refs/remotes/origin/task/mt-2304")).toBe(false);
    expect(isIndexLockError("")).toBe(false);
  });
});

describe("detectIndexLock — no lock present", () => {
  test("returns null when index.lock does not exist", async () => {
    const info = await detectIndexLock({ repoPath }, realDeps);
    expect(info).toBeNull();
  });
});

describe("detectIndexLock / repairIndexLock — stale (no live process) lock", () => {
  test("acceptance: stale zero-byte lock is detected with age + liveness, then removed with confirm", async () => {
    // Arrange: a zero-byte lock file, backdated well past the staleness
    // threshold (mirrors the mt#2820 incident: zero-byte, ~22h old).
    await writeFile(lockPath, "");
    const staleTime = new Date(Date.now() - (LOCK_STALE_THRESHOLD_MS + 60_000));
    await utimes(lockPath, staleTime, staleTime);

    // Act: detect
    const info = await detectIndexLock({ repoPath }, realDeps);

    // Assert: detected, stale-eligible (no live process, age > threshold)
    if (!info) throw new Error("expected index.lock to be detected");
    expect(info.lockPath).toBe(lockPath);
    expect(info.sizeBytes).toBe(0);
    expect(info.liveProcess).toBe(false);
    expect(info.livenessDetermined).toBe(true);
    expect(info.ageMs).toBeGreaterThanOrEqual(LOCK_STALE_THRESHOLD_MS);

    const diagnostic = formatLockDiagnostic(info);
    expect(diagnostic).toContain("no owning process detected");
    expect(diagnostic).toContain("eligible for repair");

    // Repair without confirm must refuse
    await expect(repairIndexLock({ repoPath, confirm: false }, realDeps)).rejects.toThrow(
      /confirm: true/
    );
    expect(existsSync(lockPath)).toBe(true);

    // Repair WITH confirm removes it
    const result = await repairIndexLock({ repoPath, confirm: true }, realDeps);
    expect(result.removed).toBe(true);
    expect(result.reason).toBe("removed");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("ambiguous case: lock present, no live process, but younger than the staleness threshold — refuses to remove", async () => {
    await writeFile(lockPath, "");
    // Fresh mtime (just created) — well under the threshold.
    try {
      const info = await detectIndexLock({ repoPath }, realDeps);
      if (!info) throw new Error("expected index.lock to be detected");
      expect(info.ageMs).toBeLessThan(LOCK_STALE_THRESHOLD_MS);

      await expect(repairIndexLock({ repoPath, confirm: true }, realDeps)).rejects.toThrow(
        /ambiguous, refusing to remove/
      );
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      await rm(lockPath, { force: true });
    }
  });

  test("repairIndexLock is a no-op (not an error) when no lock is present", async () => {
    const result = await repairIndexLock({ repoPath, confirm: true }, realDeps);
    expect(result.removed).toBe(false);
    expect(result.reason).toBe("no-lock-present");
  });
});

describe("detectIndexLock / repairIndexLock — lock held by a LIVE process", () => {
  let holder: ChildProcess | undefined;

  afterAll(() => {
    if (holder && !holder.killed) {
      holder.kill("SIGKILL");
    }
  });

  test("acceptance: a live-held lock reports busy and is NOT removed", async () => {
    // Arrange: spawn a real subprocess that opens the lock file (creating it)
    // and holds an fd open for several seconds — simulating an in-flight git
    // operation that is genuinely still running.
    holder = spawn("sh", ["-c", `exec 3<> ${JSON.stringify(lockPath)}; sleep 8`], {
      cwd: repoPath,
      stdio: "ignore",
    });
    const holderPid = holder.pid;
    expect(holderPid).toBeDefined();

    // Give the shell a moment to actually open the fd.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(lockPath)).toBe(true);

    try {
      const info = await detectIndexLock({ repoPath }, realDeps);
      if (!info) throw new Error("expected index.lock to be detected");
      expect(info.livenessDetermined).toBe(true);
      expect(info.liveProcess).toBe(true);

      const diagnostic = formatLockDiagnostic(info);
      expect(diagnostic).toContain("LIVE process");

      // Repair MUST refuse — busy, not stale — regardless of confirm.
      await expect(repairIndexLock({ repoPath, confirm: true }, realDeps)).rejects.toThrow(
        /busy, not stale/
      );
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      holder.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await rm(lockPath, { force: true });
    }
  }, 15000);
});

describe("runGitCommandWithLockHandling", () => {
  test("passes through non-lock errors unchanged", async () => {
    const deps = {
      execAsync: async () => {
        throw Object.assign(new Error("fatal: not a git repository"), {
          stderr: "fatal: not a git repository",
        });
      },
    };
    await expect(runGitCommandWithLockHandling("git status", deps, { repoPath })).rejects.toThrow(
      /not a git repository/
    );
  });

  test("without repairLock: enriches a lock-blocked error with diagnostic + how-to-repair", async () => {
    await writeFile(lockPath, "");
    const staleTime = new Date(Date.now() - (LOCK_STALE_THRESHOLD_MS + 60_000));
    await utimes(lockPath, staleTime, staleTime);

    try {
      let call = 0;
      const deps = {
        execAsync: async (command: string) => {
          call++;
          if (command.startsWith("git -C") && command.includes("status") && call === 1) {
            throw Object.assign(new Error("blocked"), {
              stderr: `fatal: Unable to create '${lockPath}': File exists.`,
            });
          }
          return realExec(command);
        },
      };

      await expect(
        runGitCommandWithLockHandling(`git -C ${JSON.stringify(repoPath)} status`, deps, {
          repoPath,
        })
      ).rejects.toThrow(/repairLock: true/);
    } finally {
      await rm(lockPath, { force: true });
    }
  });

  test("with repairLock: true — removes a stale lock and retries the original command", async () => {
    await writeFile(lockPath, "");
    const staleTime = new Date(Date.now() - (LOCK_STALE_THRESHOLD_MS + 60_000));
    await utimes(lockPath, staleTime, staleTime);

    let call = 0;
    const deps = {
      execAsync: async (command: string) => {
        call++;
        if (call === 1) {
          throw Object.assign(new Error("blocked"), {
            stderr: `fatal: Unable to create '${lockPath}': File exists.`,
          });
        }
        return realExec(command);
      },
    };

    const result = await runGitCommandWithLockHandling(
      `git -C ${JSON.stringify(repoPath)} status --porcelain`,
      deps,
      { repoPath, repairLock: true }
    );
    expect(result).toBeDefined();
    expect(existsSync(lockPath)).toBe(false);
    // call 1 = the blocked attempt, call 2+ = repair's own internal
    // detectIndexLock exec (rev-parse), call N = the retried command.
    expect(call).toBeGreaterThan(1);
  });
});
