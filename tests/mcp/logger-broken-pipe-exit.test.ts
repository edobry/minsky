/* eslint-disable custom/no-real-fs-in-tests -- see the note directly below */
/*
 * Real filesystem and real processes are the subject here, not an incidental
 * dependency: the claim under test is about an actual `mcp start --http`
 * process and an actual closed pipe. Each run writes only to its own `mkdtemp`
 * directory and removes it in `afterEach`, so there is no shared state for a
 * parallel run to collide with. `Date.now()` measures the exit bound; it
 * constructs no paths.
 */

/**
 * mt#3885 SC2/AT1 — the reproduction, as a test.
 *
 * A `minsky mcp start --http` process whose stdout read end is closed used to
 * enter an unbounded EPIPE→report→EPIPE cycle at ~780 MB/s (6.29 GB in 8
 * seconds, measured on the pre-fix tree). `installBrokenPipeGuard` makes it exit
 * instead.
 *
 * **Why this exists when `logger-broken-pipe.test.ts` already covers the guard.**
 * Those are unit tests over the guard in isolation — they would keep passing if
 * `createLogger` stopped calling `installBrokenPipeGuard`, or if the guard were
 * installed after winston's handlers rather than before. This test exercises the
 * REAL startup path of the REAL binary, which is the only thing that can catch
 * the guard being present but unreached.
 *
 * It is inherently one-sided: it can assert the fixed behavior, and it cannot
 * reproduce the runaway on a fixed tree. The pre-fix measurement is recorded in
 * the PR body and in the task spec as the negative control — deliberately NOT
 * run here, because a test that grows a process at 780 MB/s toward a known
 * kernel-panic threshold (mem#913) is not a test anyone should run in CI.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Generous: it covers `bun` booting the CLI and reaching its first stdout write,
 * on a cold or loaded machine. The fixed behavior is an immediate exit once that
 * write happens, so a run near this bound means something is wrong, not slow.
 */
const EXIT_BOUND_MS = 45_000;

const spawned: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone — the point of the test.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 tests existence without delivering anything. `kill` is absent
    // from this project's narrowed ambient `process` type.
    (process as unknown as { kill: (pid: number, signal: number) => void }).kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the server with stdout on a pipe we can close, stderr on a file.
 *
 * `stdio: ["pipe", "pipe", fd]` then destroying the stdout stream from this side
 * is what a dead parent does to its child — the same condition the pre-commit
 * watchdog creates when it SIGKILLs a `bun test` runner that spawned servers
 * with three pipes.
 */
/**
 * An OS-assigned free port, resolved by binding and releasing.
 *
 * Not `--port 0`: the CLI's own validation rejects it (mt#2764 records the same
 * constraint). Passing 0 makes the server exit immediately with a validation
 * error — which looks EXACTLY like the exit this test is asserting, so the
 * first version of this file passed for the wrong reason until the control
 * below caught it.
 */
function findFreePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

function startServer(closeStdout: boolean): ChildProcess {
  const runDir = mkdtempSync(join(tmpdir(), "mt3885-"));
  tempDirs.push(runDir);

  const child = spawn(
    "bun",
    [
      "src/cli.ts",
      "mcp",
      "start",
      "--http",
      "--port",
      String(findFreePort()),
      "--host",
      "127.0.0.1",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DATABASE_URL: "", MINSKY_STATE_DIR: runDir },
    }
  );
  spawned.push(child);

  if (closeStdout) {
    // Destroying the read end here is what raises EPIPE in the child on its
    // next stdout write.
    child.stdout?.destroy();
  } else {
    // Drain, so the healthy control is not merely blocked on a full pipe —
    // which would look like "did not exit" for entirely the wrong reason.
    child.stdout?.on("data", () => {});
  }
  child.stderr?.on("data", () => {});

  return child;
}

describe("mt#3885 — a closed stdout pipe ends the process instead of wedging it", () => {
  test(
    "the server exits when its stdout read end is closed",
    async () => {
      const child = startServer(true);
      const pid = child.pid;
      expect(pid).toBeDefined();

      const startedAt = Date.now();
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), EXIT_BOUND_MS);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      // The assertion that fails if the guard is removed, or installed somewhere
      // `createLogger` does not reach: pre-fix this process runs until something
      // else kills it, growing the whole time.
      expect(exited).toBe(true);
      expect(isAlive(pid as number)).toBe(false);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(EXIT_BOUND_MS);
    },
    EXIT_BOUND_MS + 15_000
  );

  test("a server whose stdout is being read is left alone", async () => {
    // The control that makes the assertion above mean something. Without it,
    // a guard that exited on EVERY startup would pass the first test.
    const child = startServer(false);
    const pid = child.pid;
    expect(pid).toBeDefined();

    let exitedEarly = false;
    child.once("exit", () => {
      exitedEarly = true;
    });

    await sleep(12_000);

    expect(exitedEarly).toBe(false);
    expect(isAlive(pid as number)).toBe(true);
  }, 45_000);
});
