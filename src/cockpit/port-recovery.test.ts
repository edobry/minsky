/**
 * Tests for port-recovery — mt#1887.
 *
 * Covers:
 *   - PID file write / read / remove lifecycle (including stale + malformed)
 *   - isProcessAlive against self + invalid PIDs
 *   - findPortHolder with a real listener (skipped on Windows)
 *   - classifyPortHolder: free / recognized-zombie / unrecognized
 *   - killZombie against a spawned sleep child (skipped on Windows)
 *   - openInBrowser opener selection per platform + failure-tolerant behavior
 *
 * Real filesystem I/O and a real TCP listener are intentional in this file —
 * port-recovery wraps OS primitives (fs atomic write, lsof, process signals),
 * so mocked fs would test the mock rather than the contract. Same posture as
 * `src/mcp/disconnect-tracker.test.ts` (file-wide disable, identical reason).
 */
/* eslint-disable custom/no-real-fs-in-tests -- testing real fs/process I/O IS the contract */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import { spawn } from "child_process";
import type { SpawnLike } from "./port-recovery";
import {
  classifyPortHolder,
  findPortHolder,
  getCockpitPidFilePath,
  isProcessAlive,
  killZombie,
  openInBrowser,
  readCockpitPidFile,
  removeCockpitPidFile,
  writeCockpitPidFile,
} from "./port-recovery";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

/** Env var that overrides the state-dir for tests (shared with disconnect-tracker, daemon-state). */
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
// PID file lifecycle
// ---------------------------------------------------------------------------

describe("PID file lifecycle", () => {
  test("write + read round-trips with the expected shape", () => {
    writeCockpitPidFile(3737);
    const data = readCockpitPidFile();
    expect(data).not.toBeNull();
    if (!data) return;
    expect(data.pid).toBe(process.pid);
    expect(data.port).toBe(3737);
    expect(typeof data.startedAt).toBe("string");
    expect(() => new Date(data.startedAt).toISOString()).not.toThrow();
  });

  test("write creates the state dir if missing", () => {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
    expect(fs.existsSync(tmpStateDir)).toBe(false);
    writeCockpitPidFile(4242);
    expect(fs.existsSync(getCockpitPidFilePath())).toBe(true);
  });

  test("readCockpitPidFile on missing file returns null", () => {
    expect(readCockpitPidFile()).toBeNull();
  });

  test("readCockpitPidFile on malformed JSON returns null (does not throw)", () => {
    fs.writeFileSync(getCockpitPidFilePath(), "not json {{{");
    expect(readCockpitPidFile()).toBeNull();
  });

  test("readCockpitPidFile on wrong-shape JSON returns null", () => {
    fs.writeFileSync(getCockpitPidFilePath(), JSON.stringify({ pid: "not-a-number" }));
    expect(readCockpitPidFile()).toBeNull();
  });

  test("removeCockpitPidFile clears the file", () => {
    writeCockpitPidFile(3737);
    expect(fs.existsSync(getCockpitPidFilePath())).toBe(true);
    removeCockpitPidFile();
    expect(fs.existsSync(getCockpitPidFilePath())).toBe(false);
  });

  test("removeCockpitPidFile is silent on missing file", () => {
    expect(() => removeCockpitPidFile()).not.toThrow();
  });

  test(`getCockpitPidFilePath honours ${STATE_DIR_ENV}`, () => {
    expect(getCockpitPidFilePath()).toBe(path.join(tmpStateDir, "cockpit.pid"));
  });
});

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
  skipOnWindows("returns null when no process holds the port", async () => {
    const port = await findFreePort();
    expect(findPortHolder(port)).toBeNull();
  });

  skipOnWindows("returns this process's PID when we hold the port", async () => {
    const { server, port } = await bindListener();
    try {
      const holder = findPortHolder(port);
      expect(holder).not.toBeNull();
      if (!holder) return;
      expect(holder.pid).toBe(process.pid);
      expect(typeof holder.command).toBe("string");
      expect(holder.command.length).toBeGreaterThan(0);
    } finally {
      await closeListener(server);
    }
  });
});

describe("classifyPortHolder", () => {
  skipOnWindows("returns 'free' when no process holds the port", async () => {
    const port = await findFreePort();
    expect(classifyPortHolder(port).kind).toBe("free");
  });

  skipOnWindows("returns 'recognized-zombie' when PID file matches the holder", async () => {
    const { server, port } = await bindListener();
    try {
      writeCockpitPidFile(port); // PID file records *our* pid + port
      const result = classifyPortHolder(port);
      expect(result.kind).toBe("recognized-zombie");
      if (result.kind === "recognized-zombie") {
        expect(result.pid).toBe(process.pid);
      }
    } finally {
      await closeListener(server);
    }
  });

  skipOnWindows("returns 'unrecognized' when PID file is absent", async () => {
    const { server, port } = await bindListener();
    try {
      // No PID file written.
      const result = classifyPortHolder(port);
      expect(result.kind).toBe("unrecognized");
      if (result.kind === "unrecognized") {
        expect(result.pid).toBe(process.pid);
      }
    } finally {
      await closeListener(server);
    }
  });

  skipOnWindows("returns 'unrecognized' when PID file records a different PID", async () => {
    const { server, port } = await bindListener();
    try {
      // Stale PID file pointing at some other PID
      const otherPid = process.pid === 1 ? 2 : 1;
      fs.writeFileSync(
        getCockpitPidFilePath(),
        JSON.stringify({ pid: otherPid, port, startedAt: new Date().toISOString() })
      );
      const result = classifyPortHolder(port);
      expect(result.kind).toBe("unrecognized");
    } finally {
      await closeListener(server);
    }
  });
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
