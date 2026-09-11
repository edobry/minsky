/**
 * Integration coverage for mt#5096: a real `minsky mcp proxy` whose upstream
 * closes stdin shuts down instead of respawning its child forever.
 *
 * The claim under test is about the proxy's reaction to ITS OWN stdin hitting
 * EOF — the signal an MCP client sends first when it shuts down cleanly, and
 * the only signal a client that dies without signaling ever sends. Before the
 * fix the proxy never observed that event: the pipe propagated `end` to the
 * child, the child exited clean, `onChildClose` read that as a staleness exit
 * and respawned into the same dead stdin — 38 inner-server boots in ~25 s
 * against the real server (mt#5096 `## Diagnosis`). So both processes here
 * are real, on the mt#4112 shape: the assertion is that the proxy EXITED and
 * spawned exactly one child, not that a handler was called.
 *
 * The fixture (`fixtures/stdin-eof-child.ts`) announces its pid and exits 0 on
 * its own stdin EOF, which is what the real inner server does on `stdin_close`.
 * The trigger is deterministic — `proxy.stdin.end()` — rather than an EPIPE an
 * idle process may never raise (mt#4886), so this does not inherit that flake.
 */

/* eslint-disable custom/no-real-fs-in-tests -- see the note directly below */
/*
 * The real filesystem is unavoidable here and is not the hazard the rule
 * guards. This test spawns two real OS processes; the pid file it hands the
 * fixture is how a different process reports back, and it must be a real path
 * because that process cannot see an injected mock. Each run gets its own
 * `mkdtemp` directory and removes it in `afterEach`, so there is no shared
 * state for a parallel run to collide with. `Date.now()` measures the exit
 * bound; it constructs no paths.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const FIXTURE = "tests/mcp/stdio-proxy/fixtures/stdin-eof-child.ts";

/**
 * Exit bound, derived rather than guessed: the child exits on its own EOF
 * within milliseconds, so `killChild` short-circuits — but if it did not, the
 * proxy's `CHILD_SIGTERM_GRACE_MS` (3000) is the mechanism's own worst case
 * before SIGKILL. The slack on top absorbs the fixture's exit, the proxy's own
 * teardown, this test's 100ms sampling granularity and CI scheduling jitter —
 * the same derivation `child-memory-restart.test.ts` uses for its bound.
 */
const EXIT_BOUND_MS = 8_000;

/** How long to allow `bun` to boot the proxy and the proxy to boot the fixture. */
const FIRST_CHILD_BOUND_MS = 30_000;

const spawned: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
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
    // Signal 0 checks existence without delivering anything. `kill` is absent
    // from this project's narrowed ambient `process` type, the same gap
    // `proxy.ts` and the mt#4112 test both cast around.
    (process as unknown as { kill: (pid: number, signal: number) => void }).kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pids the fixture has announced, oldest first — one line per spawn. A
 * designed observable rather than a process-table scrape, for the reasons
 * `child-memory-restart.test.ts` records on its own copy of this helper: a
 * scrape whose failure looks like an empty list is indistinguishable from
 * "the proxy never spawned a child" (mem#704).
 */
function announcedPids(pidFile: string): number[] {
  if (!existsSync(pidFile)) return [];
  return String(readFileSync(pidFile, "utf-8"))
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function startProxy(): {
  proxy: ChildProcess;
  pidFile: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  const runDir = mkdtempSync(join(tmpdir(), "mt5096-"));
  tempDirs.push(runDir);
  const pidFile = join(runDir, "child-pids");

  const proxy = spawn(
    "bun",
    [
      "src/cli.ts",
      "mcp",
      "proxy",
      "--child-command",
      "bun",
      "--child-args",
      JSON.stringify([FIXTURE]),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MT5096_PIDFILE: pidFile,
        // Neither memory watcher is under test. Push their first tick past the
        // end of this run: `footprint(1)` costs seconds of kernel CPU per call
        // (mem#1071), and a tick landing inside the exit bound would read as
        // slowness in the mechanism being measured.
        MINSKY_MCP_MEMORY_CEILING_POLL_MS: "600000",
        MINSKY_MCP_MEMORY_CAPTURE_MB: "100000",
      },
    }
  );
  spawned.push(proxy);
  if (proxy.pid === undefined) throw new Error("the proxy process failed to spawn");

  // Drain stdout so a forwarded byte can never back the pipe up; nothing is
  // asserted on it.
  proxy.stdout?.on("data", () => {});
  proxy.stderr?.on("data", () => {});

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proxy.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { proxy, pidFile, exited };
}

describe("mt#5096 — the proxy shuts down when its upstream closes stdin", () => {
  test("exits 0 within the bound, spawned exactly one child, and that child is gone", async () => {
    const { proxy, pidFile, exited } = startProxy();

    const firstChild = await waitFor(
      () => announcedPids(pidFile)[0],
      FIRST_CHILD_BOUND_MS,
      "the first child to announce itself"
    );
    expect(isAlive(firstChild)).toBe(true);

    // The MCP spec's stdio shutdown, step 1: the client closes the server's
    // stdin. Also what a client that dies without signaling does, by dying.
    const closedAt = Date.now();
    proxy.stdin?.end();

    const result = await Promise.race([exited, sleep(EXIT_BOUND_MS).then(() => undefined)]);

    // The proxy exited, on its own, with the pipeline-ended code — not a
    // signal, not the crash-loop breaker's 1, and not still running.
    expect(result).toEqual({ code: 0, signal: null });
    expect(Date.now() - closedAt).toBeLessThan(EXIT_BOUND_MS);

    // Exactly one child ever existed: no respawn into the dead stdin. Before
    // the fix this list grows by one every RESPAWN_DELAY_MS + boot.
    expect(announcedPids(pidFile)).toEqual([firstChild]);

    // And it did not outlive the proxy — the shutdown path awaits the child.
    expect(isAlive(firstChild)).toBe(false);
  });
});
