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

describe("checkLockLiveness hardening (PR #1986 R1)", () => {
  test(
    "ambiguous cmdline: a live git process whose cmdline lacks the repo path verbatim " +
      "is NOT enough to confirm 'not live' — undetermined, refuses to remove",
    async () => {
      await writeFile(lockPath, "");
      const staleTime = new Date(Date.now() - (LOCK_STALE_THRESHOLD_MS + 60_000));
      await utimes(lockPath, staleTime, staleTime);

      try {
        // Simulate: lsof is unavailable (genuinely fails — non-empty stderr,
        // unlike its own clean "no match" convention), AND ps finds a real
        // git process running for THIS repo but invoked without `-C
        // <repoPath>` (e.g. already cwd'd into the repo) — so its cmdline
        // has no textual reference to repoPath. Before PR #1986 R1, ps's
        // failure to match would have produced a confident (and WRONG)
        // "not live" verdict, purely because the repo path wasn't a
        // substring of the process's cmdline.
        const deps = {
          execAsync: async (command: string) => {
            if (command.startsWith("git -C") && command.includes("rev-parse")) {
              return realExec(command);
            }
            if (command.startsWith("lsof")) {
              throw Object.assign(new Error("Command failed"), {
                stdout: "",
                stderr: "lsof: permission denied inspecting process table\n",
              });
            }
            if (command.startsWith("ps -A")) {
              // A real git process for this exact repo, but its cmdline has
              // NO substring match for repoPath (relative-path invocation).
              return { stdout: "54321 git status\n", stderr: "" };
            }
            throw new Error(`unexpected command in test mock: ${command}`);
          },
        };

        const info = await detectIndexLock({ repoPath }, deps);
        if (!info) throw new Error("expected index.lock to be detected");
        expect(info.livenessDetermined).toBe(false);
        expect(info.livenessMethod).toBe("undetermined");
        // The conservative default — callers must NOT trust this as "safe
        // to delete" precisely because livenessDetermined is false.
        expect(info.liveProcess).toBe(false);

        const diagnostic = formatLockDiagnostic(info);
        expect(diagnostic).toContain("could not be");

        await expect(repairIndexLock({ repoPath, confirm: true }, deps)).rejects.toThrow(
          /Cannot determine whether .* is held by a live process/
        );
        expect(existsSync(lockPath)).toBe(true);
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  );
});

describe("repairIndexLock TOCTOU guard (PR #1986 R1)", () => {
  test("lock replaced between detection and removal is aborted, not removed", async () => {
    await writeFile(lockPath, "");
    const staleTime = new Date(Date.now() - (LOCK_STALE_THRESHOLD_MS + 60_000));
    await utimes(lockPath, staleTime, staleTime);

    let swapped = false;
    const deps = {
      execAsync: async (command: string) => {
        const result = await realExec(command);
        // Trigger on the FIRST `ps` probe seen — NOT a hardcoded call-count
        // (mt#2820 PR #1986 R2: a fixed count is an internal-implementation-
        // detail assumption that isn't portable across environments/
        // platforms where the exact lsof/ps call sequence can legitimately
        // differ — e.g. lsof behaving differently, or an extra probe firing).
        // `ps` always runs at least once inside the INITIAL detection (see
        // checkLockLiveness), so the first sighting is guaranteed to land
        // before repairIndexLock reaches its post-detection guard checks —
        // exactly the "replaced mid-repair" window this test simulates.
        if (!swapped && command.startsWith("ps -A")) {
          swapped = true;
          // Simulate a legitimate process replacing the lock in the window
          // between our detection and our unlink: remove the diagnosed
          // (stale) lock and create a NEW one at the same path — DIFFERENT
          // content (non-empty, distinct size) and a FRESH (non-stale)
          // mtime, so the replacement is unambiguously distinguishable on
          // EVERY discriminator the guard checks (inode/device identity —
          // primary; mtime and size — secondary), not solely on inode. This
          // removes any dependency on a specific filesystem's inode-reuse
          // timing (e.g. some tmpfs configurations reuse a just-freed inode
          // number faster than others) — the guard must catch the swap via
          // AT LEAST one signal on any POSIX filesystem.
          await rm(lockPath, { force: true });
          await writeFile(lockPath, "a fresh, legitimately-acquired lock\n");
        }
        return result;
      },
    };

    try {
      await expect(repairIndexLock({ repoPath, confirm: true }, deps)).rejects.toThrow(
        /replaced between detection and repair|modified between detection and repair/
      );
      // The NEW ("legitimately re-acquired") lock must survive untouched.
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      await rm(lockPath, { force: true });
    }
  });

  test("lock removed by its own owner between detection and removal is a no-op, not an error", async () => {
    await writeFile(lockPath, "");
    const staleTime = new Date(Date.now() - (LOCK_STALE_THRESHOLD_MS + 60_000));
    await utimes(lockPath, staleTime, staleTime);

    // Trigger on the first `ps` probe seen (mt#2820 PR #1986 R2) — see the
    // sibling test above for why a hardcoded call-count is not portable.
    let removed = false;
    const deps = {
      execAsync: async (command: string) => {
        const result = await realExec(command);
        if (!removed && command.startsWith("ps -A")) {
          removed = true;
          await rm(lockPath, { force: true });
        }
        return result;
      },
    };

    try {
      const result = await repairIndexLock({ repoPath, confirm: true }, deps);
      expect(result.removed).toBe(false);
      expect(result.reason).toBe("no-lock-present");
    } finally {
      await rm(lockPath, { force: true });
    }
  });
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

  test(
    "without repairLock: persistent lock contention exhausts the retry budget, then " +
      "enriches the error with diagnostic + how-to-repair (mt#2886 non-regression)",
    async () => {
      await writeFile(lockPath, "");
      const staleTime = new Date(Date.now() - (LOCK_STALE_THRESHOLD_MS + 60_000));
      await utimes(lockPath, staleTime, staleTime);

      try {
        // Mock keeps failing the `status` command for as long as the lock
        // is physically present on disk — genuine, non-transient (i.e.
        // EXTERNAL-style) contention that no amount of retrying resolves.
        const deps = {
          execAsync: async (command: string) => {
            if (
              command.startsWith("git -C") &&
              command.includes("status") &&
              existsSync(lockPath)
            ) {
              throw Object.assign(new Error("blocked"), {
                stderr: `fatal: Unable to create '${lockPath}': File exists.`,
              });
            }
            return realExec(command);
          },
        };

        // Zero-delay backoff (injectable clock) — the test proves the
        // RETRY-THEN-GIVE-UP shape, not real wall-clock timing (that's
        // covered separately by the mt#2886 repro harness).
        await expect(
          runGitCommandWithLockHandling(`git -C ${JSON.stringify(repoPath)} status`, deps, {
            repoPath,
            retryBackoffMs: [0, 0, 0],
            sleep: async () => {},
          })
        ).rejects.toThrow(/repairLock: true/);
        // The lock is still physically present — no repair was attempted.
        expect(existsSync(lockPath)).toBe(true);
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  );

  test(
    "with repairLock: true — retries are exhausted against a persistent lock, then " +
      "removes it (stale) and retries the original command",
    async () => {
      await writeFile(lockPath, "");
      const staleTime = new Date(Date.now() - (LOCK_STALE_THRESHOLD_MS + 60_000));
      await utimes(lockPath, staleTime, staleTime);

      const deps = {
        execAsync: async (command: string) => {
          if (command.startsWith("git -C") && command.includes("status") && existsSync(lockPath)) {
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
        { repoPath, repairLock: true, retryBackoffMs: [0, 0, 0], sleep: async () => {} }
      );
      expect(result).toBeDefined();
      expect(existsSync(lockPath)).toBe(false);
    }
  );

  // R1 non-regression matrix (mt#2886 PR #2031 review): pin BOTH repairLock
  // branches against a genuinely PERSISTENT (LIVE, never-resolving) lock —
  // the "without repairLock" test above already covers the false branch
  // against a stale-but-persistent-because-never-repaired lock; this test
  // covers the true branch against a LIVE (unrepairable — busy, not stale)
  // lock, confirming repairIndexLock's OWN actionable busy error propagates
  // unchanged after the retry budget exhausts — not swallowed, not replaced
  // by a generic failure, not silence.
  test(
    "with repairLock: true — persistent LIVE (non-stale) lock: retries exhaust, then " +
      "repairIndexLock's own busy error propagates unchanged (not swallowed)",
    async () => {
      // A REAL subprocess holds an open fd on the lock for the whole test —
      // this is "busy", not "stale", so repairIndexLock must refuse to
      // remove it (mirrors the "acceptance: a live-held lock" test above).
      const holder = spawn("sh", ["-c", `exec 3<> ${JSON.stringify(lockPath)}; sleep 5`], {
        cwd: repoPath,
        stdio: "ignore",
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(lockPath)).toBe(true);

      try {
        const deps = {
          execAsync: async (command: string) => {
            if (
              command.startsWith("git -C") &&
              command.includes("status") &&
              existsSync(lockPath)
            ) {
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
            repairLock: true,
            retryBackoffMs: [0, 0, 0],
            sleep: async () => {},
          })
        ).rejects.toThrow(/busy, not stale/);
        // The live-held lock must NOT have been removed by the failed
        // repair attempt — repairIndexLock refuses, it doesn't silently no-op.
        expect(existsSync(lockPath)).toBe(true);
      } finally {
        holder.kill("SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 200));
        await rm(lockPath, { force: true });
      }
    },
    10000
  );
});

describe("extractStderr fallback (mt#2886 R1 hardening)", () => {
  test("falls back to .message when .stderr is absent — a lock-blocked rejection with no .stderr is still classified correctly", async () => {
    // Simulates an exec rejection shape where .stderr is missing (some
    // Node child_process failure modes omit it) but .message carries the
    // same diagnostic text — the conventional `Command failed: ...\n<stderr>`
    // shape. Without the fallback, this would misclassify as a non-lock
    // error and bail out of the retry loop immediately.
    let call = 0;
    const deps = {
      execAsync: async (command: string) => {
        if (command.includes("rev-parse")) {
          // Diagnostic call inside the fallthrough busy-error path — let
          // it "succeed" with a fake git-dir so the enrichment message
          // forms (mirrors the sibling pure-mock test above).
          return { stdout: "/scratch/.git\n", stderr: "" };
        }
        call++;
        throw new Error(
          "Command failed: git status\nfatal: Unable to create '/scratch/.git/index.lock': File exists."
        );
        // Deliberately NOT attaching a `.stderr` property.
      },
    };

    await expect(
      runGitCommandWithLockHandling("git status", deps, {
        repoPath: "/scratch",
        retryBackoffMs: [0, 0],
        sleep: async () => {},
      })
    ).rejects.toThrow(/repairLock: true/);
    // Correctly retried through the FULL budget (not bailed early on the
    // first missing-.stderr rejection) before falling through.
    expect(call).toBe(3);
  });
});

/** Shared fixture stderr for the pure-mock retry-backoff tests below. */
const SCRATCH_LOCK_STDERR = "fatal: Unable to create '/scratch/.git/index.lock': File exists.";

describe("runGitCommandWithLockHandling — retry-backoff (mt#2886)", () => {
  test("LOCK_RETRY_BACKOFF_MS sums to ~2s (the documented non-regression budget)", async () => {
    const { LOCK_RETRY_BACKOFF_MS } = await import("./lock-operations");
    const total = LOCK_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBe(2000);
  });

  test("transient contention: lock clears within the retry budget — succeeds without ever surfacing an error or needing repairLock", async () => {
    let call = 0;
    const sleeps: number[] = [];
    const deps = {
      execAsync: async () => {
        call++;
        if (call <= 2) {
          throw Object.assign(new Error("blocked"), {
            stderr: SCRATCH_LOCK_STDERR,
          });
        }
        return { stdout: "clean\n", stderr: "" };
      },
    };

    const result = await runGitCommandWithLockHandling("git status", deps, {
      repoPath: "/scratch",
      retryBackoffMs: [10, 10, 10],
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    expect(result.stdout).toBe("clean\n");
    // 1 initial failure + 1 failing retry + 1 succeeding retry = 3 calls total.
    expect(call).toBe(3);
    // Only 2 sleeps were needed — the 3rd backoff entry was never reached.
    expect(sleeps).toEqual([10, 10]);
  });

  test("persistent contention beyond the retry budget: falls through to the actionable busy error (non-regression) after exhausting the FULL configured backoff", async () => {
    let call = 0;
    const sleeps: number[] = [];
    const deps = {
      execAsync: async (command: string) => {
        if (command.includes("rev-parse")) {
          // Diagnostic call inside the fallthrough busy-error path — let it
          // "succeed" with a fake git-dir so the enrichment message forms.
          return { stdout: "/scratch/.git\n", stderr: "" };
        }
        call++;
        throw Object.assign(new Error("blocked"), {
          stderr: SCRATCH_LOCK_STDERR,
        });
      },
    };

    await expect(
      runGitCommandWithLockHandling("git status", deps, {
        repoPath: "/scratch",
        retryBackoffMs: [10, 20, 30],
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      })
    ).rejects.toThrow(/repairLock: true/);

    // Initial attempt + 3 retries, all lock-blocked.
    expect(call).toBe(4);
    // The FULL configured backoff was exhausted before giving up — this is
    // the mechanical proof that genuine (unresolvable) contention still
    // surfaces, just bounded by the configured retry budget rather than
    // instantly (see LOCK_RETRY_BACKOFF_MS doc: ~2s with the real default).
    expect(sleeps).toEqual([10, 20, 30]);
  });

  test("a non-lock error surfacing mid-retry is NOT retried further — propagates immediately", async () => {
    let call = 0;
    const deps = {
      execAsync: async () => {
        call++;
        if (call === 1) {
          throw Object.assign(new Error("blocked"), {
            stderr: SCRATCH_LOCK_STDERR,
          });
        }
        // Second call (first retry) hits a DIFFERENT, non-lock failure —
        // must propagate immediately rather than being swallowed by the
        // remaining retry budget.
        throw Object.assign(new Error("disk full"), { stderr: "fatal: could not write index" });
      },
    };

    await expect(
      runGitCommandWithLockHandling("git status", deps, {
        repoPath: "/scratch",
        retryBackoffMs: [0, 0, 0],
        sleep: async () => {},
      })
    ).rejects.toThrow(/disk full|could not write index/);
    expect(call).toBe(2);
  });
});
