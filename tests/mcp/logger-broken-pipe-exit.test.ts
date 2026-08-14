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
import { readProcessMemory } from "@minsky/shared/process-memory";

/**
 * Generous: it covers `bun` booting the CLI and reaching its first stdout write,
 * on a cold or loaded machine. The fixed behavior is an immediate exit once that
 * write happens, so a run near this bound means something is wrong, not slow.
 */
const EXIT_BOUND_MS = 45_000;

/**
 * How long to wait for the server to report it is serving.
 *
 * Separate from the exit bound because it measures a different thing: this
 * covers `bun` booting the CLI and binding, on a cold or loaded machine.
 */
const READY_BOUND_MS = 60_000;

/**
 * Kill the child if it crosses this while we are waiting for it to exit.
 *
 * Well above the measured 210-413 MB idle band (mt#4104) and far below anything
 * dangerous. At ~780 MB/s a regression reaches it in about two seconds, so the
 * abort fires long before the exit bound could.
 */
const RUNAWAY_ABORT_BYTES = 1_500 * 1024 * 1024;

/** Readiness attempts before giving up, for the port race. Matches mt#2764's. */
const READY_ATTEMPTS = 3;

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

/** The line the server prints once it is actually serving. */
const HTTP_READY_MARKER = "Ready to receive MCP requests via HTTP";

/**
 * Start the server and resolve once it is CONFIRMED SERVING.
 *
 * Waiting for the ready marker is not politeness, it is what makes the exit
 * assertion mean something (PR #2991 R1). `findFreePort` releases its probe
 * socket before the child binds, so another process can take the port in
 * between; the child then exits on a bind error, which is indistinguishable
 * from the exit this test asserts. Requiring readiness FIRST removes that
 * reading entirely: a process that never bound fails here, with a message
 * saying so, instead of passing the assertion below.
 *
 * This is the third variant of one mistake in this file's history — `--port 0`
 * and `head -c 200` were the other two — so the shape is worth naming: an exit
 * or an absence is a weak observation, because many causes produce it.
 */
async function startServingServer(): Promise<ChildProcess> {
  // Retry on a failure to reach readiness, mirroring `spawnHttpMcp`'s handling
  // of the same window (mt#2764, `start-command.test.ts`). The wait above turns
  // a lost port race into a loud failure rather than a false pass, which is the
  // important half — but this test runs in the fail-closed pre-push suite, where
  // a spurious red blocks every push and costs far more to diagnose than it does
  // to retry. Only the readiness phase is retried; nothing here retries the
  // assertion itself.
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1) {
    try {
      return await spawnAndAwaitReady();
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw lastError ?? new Error("startServingServer: exhausted attempts");
}

async function spawnAndAwaitReady(): Promise<ChildProcess> {
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

  let output = "";
  const collect = (chunk: Buffer | string) => {
    output += String(chunk);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server never reported ready in ${READY_BOUND_MS}ms`)),
      READY_BOUND_MS
    );
    const check = () => {
      if (output.includes(HTTP_READY_MARKER)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", check);
    child.stderr?.on("data", check);
    // An exit BEFORE readiness is the bind-race (or any other startup failure)
    // this wait exists to separate from the exit under test.
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (code ${code}) before it began serving; not the EPIPE path`));
    });
    check();
  });

  return child;
}

describe("mt#3885 — a closed stdout pipe ends the process instead of wedging it", () => {
  test(
    "the server exits when its stdout read end is closed",
    async () => {
      // Confirmed serving BEFORE the pipe is closed, so a failure to bind
      // cannot be mistaken for the exit under test.
      const child = await startServingServer();
      const pid = child.pid;
      expect(pid).toBeDefined();

      // Now close the read end. The next stdout write raises EPIPE — which is
      // what a dead parent does to its child, and what the pre-commit watchdog
      // does when it SIGKILLs a runner that spawned servers with three pipes.
      child.stdout?.destroy();

      const startedAt = Date.now();
      let grewToBytes = 0;

      const exited = await new Promise<boolean>((resolve) => {
        // Watch the footprint while waiting, and kill the moment it runs away.
        // This test asserts the ABSENCE of a runaway, and the failing case of
        // an absence-assertion is the runaway itself: at the measured ~780 MB/s
        // the exit bound alone would let a regression reach tens of GB, which
        // on this machine is the kernel-panic band this whole task exists to
        // close (mem#913). Bounding it here keeps a red test from being
        // destructive, and makes the failure message name what actually
        // happened instead of only "did not exit".
        const watch = setInterval(() => {
          const reading = readProcessMemory(pid as number);
          if (reading.ok && reading.bytes > RUNAWAY_ABORT_BYTES) {
            grewToBytes = reading.bytes;
            clearInterval(watch);
            clearTimeout(timer);
            try {
              child.kill("SIGKILL");
            } catch {
              // Already gone.
            }
            resolve(false);
          }
        }, 500);
        const timer = setTimeout(() => {
          clearInterval(watch);
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
          resolve(false);
        }, EXIT_BOUND_MS);
        child.once("exit", () => {
          clearInterval(watch);
          clearTimeout(timer);
          resolve(true);
        });
      });

      // The assertion that fails if the guard is removed, or installed somewhere
      // `createLogger` does not reach: pre-fix this process runs until something
      // else kills it, growing the whole time.
      expect(grewToBytes).toBe(0);
      expect(exited).toBe(true);
      expect(isAlive(pid as number)).toBe(false);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(EXIT_BOUND_MS);
    },
    EXIT_BOUND_MS + 15_000
  );

  test("a server whose stdout is being read is left alone", async () => {
    // The control that makes the assertion above mean something. Without it,
    // a guard that exited on EVERY startup would pass the first test. The
    // stdout listeners installed by the helper keep draining, so this is not
    // merely a server blocked on a full pipe.
    const child = await startServingServer();
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
