/**
 * Integration coverage for mt#4112: a real `minsky mcp proxy` process killing
 * and replacing a real child that has wedged its own event loop.
 *
 * This is deliberately not a unit test. The claim under test is that a bound
 * survives the case where the child cannot run ANY of its own code — no timer,
 * no signal handler, no exit hook. A fake child, or an in-process harness that
 * stubs the kill, is blind to exactly that: it would pass whether or not the
 * escalation to SIGKILL actually happens. So both processes here are real, and
 * the assertion is that the pid is GONE, not that a signal was sent.
 *
 * The fixture self-terminates on a wall-clock deadline it checks inside its own
 * spin loop (`fixtures/memory-hog-child.ts`), so a test killed mid-run cannot
 * leave the runaway behind — the mt#4098 failure this task's family began with.
 */

/* eslint-disable custom/no-real-fs-in-tests -- see the note directly below */
/*
 * The real filesystem is unavoidable here and is not the hazard the rule
 * guards. This test spawns two real OS processes; the marker path it hands the
 * fixture is how the fixture's second run knows to come up healthy, and it must
 * be a real path because the fixture is a different process and cannot see an
 * injected mock. Each run gets its own `mkdtemp` directory and removes it in
 * `afterEach`, so there is no shared state for a parallel run to collide with —
 * which is the interference the rule exists to prevent. `Date.now()` here
 * measures the response bound; it constructs no paths.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const FIXTURE = "tests/mcp/stdio-proxy/fixtures/memory-hog-child.ts";

/** Well under the fixture's ~384MB allocation, well over a bun baseline. */
const CEILING_MB = "200";
/** Fast enough to keep the test short; the real default is 30s. */
const POLL_MS = "250";

/**
 * Response bound asserted by AT3, derived rather than guessed:
 * `POLL_MS` (250) + the proxy's `CHILD_SIGTERM_GRACE_MS` (3000) is the
 * mechanism's own worst case, and a wedged child always spends the full grace
 * period because it cannot handle SIGTERM. The slack on top absorbs one
 * `footprint(1)` call (~88ms measured) plus this test's own 100ms sampling
 * granularity and CI scheduling jitter.
 */
const KILL_BOUND_MS = 8_000;

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
    // `proxy.ts` and the mt#3886 proxy wiring both cast around.
    (process as unknown as { kill: (pid: number, signal: number) => void }).kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pids the fixture has announced, oldest first — one line per run.
 *
 * A designed observable rather than a process-table scrape. Two earlier versions
 * of this helper shelled out, and both were wrong in the same way: `pgrep -P`
 * returned a transient `ps` the proxy itself spawns while resolving its harness
 * ancestry (mt#3900), and the `ps -axo` parse that replaced it coupled the test
 * to one platform's column formatting — where a `ps` that is absent, BusyBox, or
 * formatted differently yields an EMPTY list, which is indistinguishable from
 * "the proxy never spawned a child". A probe whose failure looks exactly like a
 * negative result is the shape this whole task is about (mem#704).
 *
 * The fixture announces itself instead, so the failure mode is a `waitFor`
 * timeout naming what it was waiting for.
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

function startProxy(extraEnv: Record<string, string>): {
  proxy: ChildProcess;
  pidFile: string;
  stdout: () => string;
} {
  const runDir = mkdtempSync(join(tmpdir(), "mt4112-"));
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
        MT4112_PIDFILE: pidFile,
        MINSKY_MCP_MEMORY_CEILING_MB: CEILING_MB,
        MINSKY_MCP_MEMORY_CEILING_POLL_MS: POLL_MS,
        // The proxy's own ceiling and the capture watcher are not under test
        // here and would only add noise (and `footprint` calls) to the run.
        MINSKY_MCP_MEMORY_CAPTURE_MB: "100000",
        ...extraEnv,
      },
    }
  );
  spawned.push(proxy);
  if (proxy.pid === undefined) throw new Error("the proxy process failed to spawn");

  let out = "";
  proxy.stdout?.on("data", (chunk: Buffer | string) => {
    out += String(chunk);
  });
  return { proxy, pidFile, stdout: () => out };
}

describe("mt#4112 — the proxy bounds a wedged child's memory", () => {
  test("kills the wedged child within the stated bound and serves from its replacement", async () => {
    const { proxy, pidFile, stdout } = startProxy({});

    const firstChild = await waitFor(() => announcedPids(pidFile)[0], 30_000, "the first child");

    // Time from the moment the child is actually OVER the ceiling — not from
    // spawn — so the assertion measures the mechanism's response and not the
    // fixture's allocation speed.
    const { readProcessMemory } = await import("@minsky/shared/process-memory");
    const overCeilingAt = await waitFor(
      () => {
        const reading = readProcessMemory(firstChild);
        const ceilingBytes = Number(CEILING_MB) * 1024 * 1024;
        return reading.ok && reading.bytes >= ceilingBytes ? Date.now() : undefined;
      },
      20_000,
      "the child to exceed the ceiling"
    );

    await waitFor(() => (isAlive(firstChild) ? undefined : true), KILL_BOUND_MS, "the kill");
    const killedAt = Date.now();

    // AT2: gone, not signalled.
    expect(isAlive(firstChild)).toBe(false);
    // AT3.
    expect(killedAt - overCeilingAt).toBeLessThanOrEqual(KILL_BOUND_MS);
    // AT2, the half that "it is gone" does not establish on its own: SIGKILL
    // is what ended it, not SIGTERM. A child that could run its own handler
    // would exit in milliseconds; this one cannot, so it has to sit through
    // the full `CHILD_SIGTERM_GRACE_MS` (3000) first. The slack below the
    // grace period absorbs this test's own 100ms sampling granularity and one
    // `footprint(1)` call, both of which can make the crossing look later
    // than the proxy saw it.
    expect(killedAt - overCeilingAt).toBeGreaterThanOrEqual(2_500);

    // AT4: a replacement exists and actually serves.
    const secondChild = await waitFor(
      () => announcedPids(pidFile).find((pid) => pid !== firstChild),
      20_000,
      "the replacement child"
    );
    expect(secondChild).not.toBe(firstChild);

    proxy.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "mt4112-probe", method: "ping" })}\n`
    );
    await waitFor(
      () => (stdout().includes("mt4112-probe") ? true : undefined),
      20_000,
      "a response from the replacement child"
    );

    // AT6: the healthy replacement is left alone across many poll intervals.
    await sleep(2_000);
    expect(isAlive(secondChild)).toBe(true);
  }, 90_000);

  test("negative control: with the ceiling disabled the same child survives", async () => {
    const { pidFile } = startProxy({ MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT: "1" });

    const firstChild = await waitFor(() => announcedPids(pidFile)[0], 30_000, "the first child");

    const { readProcessMemory } = await import("@minsky/shared/process-memory");
    await waitFor(
      () => {
        const reading = readProcessMemory(firstChild);
        const ceilingBytes = Number(CEILING_MB) * 1024 * 1024;
        return reading.ok && reading.bytes >= ceilingBytes ? true : undefined;
      },
      20_000,
      "the child to exceed the ceiling"
    );

    // This is the pre-change behavior: over the ceiling, event loop wedged,
    // and nothing stops it. Without this run, the assertion above would be
    // compatible with the child having died for some unrelated reason.
    await sleep(KILL_BOUND_MS);
    expect(isAlive(firstChild)).toBe(true);
  }, 90_000);
});
