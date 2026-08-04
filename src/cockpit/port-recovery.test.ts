/**
 * Tests for port-recovery — mt#1887 (refactored to consume lifecycle.ts in mt#1904).
 *
 * Covers:
 *   - isProcessAlive against self + invalid PIDs
 *   - findPortHolder with a real listener (skipped on Windows)
 *   - classifyPortHolder: free / recognized-zombie / unrecognized
 *   - killZombie against a spawned sleep child (skipped on Windows)
 *   - openInBrowser opener selection per platform + failure-tolerant behavior
 *
 * State-file lifecycle tests live in `src/cockpit/lifecycle.test.ts` since
 * mt#1904 — that module owns the state file the classifier reads.
 *
 * Real filesystem I/O and a real TCP listener are intentional in this file —
 * port-recovery wraps OS primitives (lsof, process signals), so mocked fs
 * would test the mock rather than the contract. Same posture as
 * `src/mcp/disconnect-tracker.test.ts` (file-wide disable, identical reason).
 */
/* eslint-disable custom/no-real-fs-in-tests -- testing real fs/process I/O IS the contract */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import { spawn } from "child_process";
import type { PortHolder, SpawnLike } from "./port-recovery";
import {
  classifyPortHolder,
  findPortHolder,
  isProcessAlive,
  killZombie,
  openInBrowser,
} from "./port-recovery";
import {
  getCockpitStateFilePath,
  resolveWorkspaceKey,
  writeCurrentCockpitState,
} from "./lifecycle";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

/** Env var that overrides the state-dir for tests (shared with lifecycle, disconnect-tracker, daemon-state). */
const STATE_DIR_ENV = "MINSKY_STATE_DIR";

let tmpStateDir: string;
let priorStateDir: string | undefined;

beforeEach(() => {
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-pr-test-"));
  priorStateDir = process.env[STATE_DIR_ENV];
  process.env[STATE_DIR_ENV] = tmpStateDir;
});

afterEach(() => {
  if (priorStateDir === undefined) {
    delete process.env[STATE_DIR_ENV];
  } else {
    process.env[STATE_DIR_ENV] = priorStateDir;
  }
  try {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** Bind a real TCP listener so a port is genuinely held. */
async function bindListener(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("listener has no address");
  return { server, port: addr.port };
}

async function closeListener(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** Find an unused TCP port without holding it. */
async function findFreePort(): Promise<number> {
  const { server, port } = await bindListener();
  await closeListener(server);
  return port;
}

// ---------------------------------------------------------------------------
// isProcessAlive
// ---------------------------------------------------------------------------

describe("isProcessAlive", () => {
  test("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("returns false for an unused high PID", () => {
    // 2^22 is well beyond typical pid_max on macOS/Linux; reasonable bet
    // that it is not currently assigned.
    expect(isProcessAlive(4_194_303)).toBe(false);
  });

  test("returns false for invalid PIDs", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(NaN)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findPortHolder + classifyPortHolder
// ---------------------------------------------------------------------------

const skipOnWindows = process.platform === "win32" ? test.skip : test;

describe("findPortHolder", () => {
  // mt#2712: findFreePort() binds to port 0 (OS-assigned) and reads back the
  // assigned port before releasing it -- but there is an inherent TOCTOU gap
  // between releasing the port and findPortHolder()'s `lsof` check (itself a
  // subprocess spawn) during which another process (plausibly a stray
  // listener left by an earlier cockpit-server test in the same suite run)
  // can grab that exact port. Rather than weakening the assertion, retry
  // with a freshly OS-assigned port on the rare occasion a genuine
  // collision occurs -- a transient contention from an unrelated process is
  // not a defect in findPortHolder itself. A short delay between retries
  // (mt#2712 R1) covers the case where the stray holder is itself
  // short-lived (e.g. a sibling test's listener mid-teardown) -- a
  // back-to-back retry with no delay could re-collide with the same
  // still-shutting-down process.
  test("returns null when no process holds the port", async () => {
    let holder: PortHolder | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      const port = await findFreePort();
      holder = findPortHolder(port);
      if (holder === null) break;
    }
    expect(holder).toBeNull();
  });

  // mt#3524: same TOCTOU family as the sibling test above, one step further out.
  //
  // `bindListener` binds 127.0.0.1 ONLY, but `findPortHolder` shells out to
  // `lsof -i :<port> -sTCP:LISTEN`, which matches that PORT NUMBER on ANY
  // address, and then takes the FIRST pid of a possibly multi-line result. So
  // when an unrelated process happens to be listening on the same port number
  // on a different interface — plausible under full-suite parallelism, where
  // many test processes bind OS-assigned ports at once — lsof reports both and
  // findPortHolder can legitimately return the other one. Observed exactly
  // that way (expected 62950, received 58788) during a full-suite run whose
  // diff touched nothing near this path; the isolated re-run passed 17/17.
  //
  // Retrying with a freshly OS-assigned port keeps the assertion at full
  // strength — we still require the holder to be THIS process — and only
  // re-rolls when someone else is genuinely sharing the port number. Weakening
  // it to "some holder exists" would drop the property the test is for: that
  // findPortHolder attributes a listening port to its actual owner.
  skipOnWindows("returns this process's PID when we hold the port", async () => {
    let lastHolder: PortHolder | null = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      const { server, port } = await bindListener();
      try {
        lastHolder = findPortHolder(port);
        // Someone else is on this port number too, and lsof listed them first.
        // Re-roll rather than assert against a port we do not exclusively hold.
        if (lastHolder && lastHolder.pid !== process.pid) continue;
        break;
      } finally {
        await closeListener(server);
      }
    }

    expect(lastHolder).not.toBeNull();
    if (!lastHolder) return;
    expect(lastHolder.pid).toBe(process.pid);
    expect(typeof lastHolder.command).toBe("string");
    expect(lastHolder.command.length).toBeGreaterThan(0);
  });
});

describe("classifyPortHolder", () => {
  skipOnWindows("returns 'free' when no process holds the port", async () => {
    const port = await findFreePort();
    expect(classifyPortHolder(port).kind).toBe("free");
  });

  skipOnWindows("returns 'recognized-zombie' when state file matches the holder", async () => {
    const { server, port } = await bindListener();
    try {
      // Write state file for THIS workspace pointing at our pid + port.
      writeCurrentCockpitState({
        pid: process.pid,
        port,
        url: `http://localhost:${port}`,
      });
      const result = classifyPortHolder(port);
      expect(result.kind).toBe("recognized-zombie");
      if (result.kind === "recognized-zombie") {
        expect(result.pid).toBe(process.pid);
      }
    } finally {
      await closeListener(server);
    }
  });

  skipOnWindows("returns 'unrecognized' when state file is absent", async () => {
    const { server, port } = await bindListener();
    try {
      // No state file written.
      const result = classifyPortHolder(port);
      expect(result.kind).toBe("unrecognized");
      if (result.kind === "unrecognized") {
        expect(result.pid).toBe(process.pid);
      }
    } finally {
      await closeListener(server);
    }
  });

  skipOnWindows(
    "returns 'unrecognized' when state file records a different PID (peer cockpit)",
    async () => {
      const { server, port } = await bindListener();
      try {
        // Write state file directly with a different PID — simulates a
        // stale entry OR a peer cockpit in this workspace (which won't
        // happen in practice but exercises the comparison branch).
        const workspaceKey = resolveWorkspaceKey(process.cwd());
        const statePath = getCockpitStateFilePath(workspaceKey);
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        const otherPid = process.pid === 1 ? 2 : 1;
        fs.writeFileSync(
          statePath,
          JSON.stringify({
            pid: otherPid,
            port,
            url: `http://localhost:${port}`,
            workspaceId: workspaceKey,
            workspacePath: process.cwd(),
            startedAt: new Date().toISOString(),
          })
        );
        const result = classifyPortHolder(port);
        expect(result.kind).toBe("unrecognized");
      } finally {
        await closeListener(server);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// killZombie
// ---------------------------------------------------------------------------

describe("killZombie", () => {
  skipOnWindows("kills a spawned sleep child with SIGTERM", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore", detached: false });
    expect(child.pid).toBeDefined();
    const pid = child.pid;
    if (typeof pid !== "number") throw new Error("spawned child has no pid");

    // Give the kernel a moment to register the new process.
    await new Promise((r) => setTimeout(r, 20));
    expect(isProcessAlive(pid)).toBe(true);

    await killZombie(pid, { timeoutMs: 2000, pollMs: 50 });
    expect(isProcessAlive(pid)).toBe(false);
  });

  skipOnWindows("is a no-op when the PID is already gone", async () => {
    // PID 4194302 — sibling of the isProcessAlive "unused" PID.
    await expect(killZombie(4_194_302, { timeoutMs: 100 })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// openInBrowser
// ---------------------------------------------------------------------------

describe("openInBrowser", () => {
  function stubSpawn() {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const child: SpawnLike & { _handlers: Record<string, (err: Error) => void> } = {
      _handlers: {},
      on(event, handler) {
        this._handlers[event] = handler;
      },
      unref() {},
    };
    const spawnFn = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return child;
    };
    return { spawnFn, calls, child };
  }

  test("on darwin, spawns 'open <url>'", () => {
    const { spawnFn, calls } = stubSpawn();
    openInBrowser("http://localhost:3737", { platform: "darwin", spawnFn });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.cmd).toBe("open");
    expect(call?.args).toEqual(["http://localhost:3737"]);
  });

  test("on linux, spawns 'xdg-open <url>'", () => {
    const { spawnFn, calls } = stubSpawn();
    openInBrowser("http://localhost:3737", { platform: "linux", spawnFn });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.cmd).toBe("xdg-open");
    expect(call?.args).toEqual(["http://localhost:3737"]);
  });

  test("on win32, spawns 'cmd /c start \"\" <url>'", () => {
    const { spawnFn, calls } = stubSpawn();
    openInBrowser("http://localhost:3737", { platform: "win32", spawnFn });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.cmd).toBe("cmd");
    expect(call?.args).toEqual(["/c", "start", "", "http://localhost:3737"]);
  });

  test("on unknown platform, logs a warning and does not spawn", () => {
    const warnings: string[] = [];
    const { spawnFn, calls } = stubSpawn();
    openInBrowser("http://localhost:3737", {
      platform: "freebsd" as NodeJS.Platform,
      spawnFn,
      warn: (m) => warnings.push(m),
    });
    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("freebsd");
  });

  test("emits warning and does not throw when spawn throws synchronously", () => {
    const warnings: string[] = [];
    const throwingSpawn = ((): SpawnLike => {
      throw new Error("ENOENT");
    }) as (cmd: string, args: string[]) => SpawnLike;

    expect(() =>
      openInBrowser("http://localhost:3737", {
        platform: "darwin",
        spawnFn: throwingSpawn,
        warn: (m) => warnings.push(m),
      })
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ENOENT");
  });

  test("emits warning when spawn's 'error' event fires", () => {
    const warnings: string[] = [];
    const { spawnFn, child } = stubSpawn();
    openInBrowser("http://localhost:3737", {
      platform: "darwin",
      spawnFn,
      warn: (m) => warnings.push(m),
    });
    // Simulate the spawned child emitting an error event after the call.
    const handler = child._handlers["error"];
    if (handler) handler(new Error("spawn failed"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("spawn failed");
  });
});
