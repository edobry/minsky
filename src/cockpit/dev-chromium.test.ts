/**
 * Tests for the dev chromium tracker — mt#1904.
 *
 * Covers:
 *   - Chrome executable detection: env override, platform lookup table, unknown platform
 *   - State file write / read / remove round-trip + malformed/wrong-shape handling
 *   - isDevChromiumRunning probe: against unbound port (false), against a real
 *     HTTP server returning 200 on /json/version (true), against a server
 *     returning 404 (false)
 *   - ensureDevChromiumRunning idempotence: probe-says-running short-circuits the spawn;
 *     no Chrome binary → null with warning; spawn timeout → null with warning;
 *     spawn success + probe transition → state file written and returned
 *
 * Real filesystem I/O is intentional — the module is a thin wrapper over fs +
 * fetch + spawn primitives. Spawn is mocked via the spawnFn seam to avoid
 * launching real Chrome in CI.
 */
/* eslint-disable custom/no-real-fs-in-tests -- testing real fs I/O IS the contract */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import {
  detectChromeExecutable,
  DEFAULT_DEBUGGING_PORT,
  ensureDevChromiumRunning,
  getDevChromiumStateFilePath,
  getDevChromiumUserDataDir,
  isDevChromiumRunning,
  readDevChromiumState,
  removeDevChromiumState,
  writeDevChromiumState,
  type DevChromiumState,
} from "./dev-chromium";

const STATE_DIR_ENV = "MINSKY_STATE_DIR";
const EXECUTABLE_ENV = "MINSKY_DEV_CHROMIUM_EXECUTABLE";
const USER_DATA_DIR_ENV = "MINSKY_DEV_CHROMIUM_USER_DATA_DIR";
const CONTENT_TYPE_JSON = "application/json";

let tmpStateDir: string;
let priorStateDir: string | undefined;
let priorExecutable: string | undefined;
let priorUserDataDir: string | undefined;

beforeEach(() => {
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-chromium-test-"));
  priorStateDir = process.env[STATE_DIR_ENV];
  priorExecutable = process.env[EXECUTABLE_ENV];
  priorUserDataDir = process.env[USER_DATA_DIR_ENV];
  process.env[STATE_DIR_ENV] = tmpStateDir;
  delete process.env[EXECUTABLE_ENV];
  delete process.env[USER_DATA_DIR_ENV];
});

afterEach(() => {
  if (priorStateDir === undefined) {
    delete process.env[STATE_DIR_ENV];
  } else {
    process.env[STATE_DIR_ENV] = priorStateDir;
  }
  if (priorExecutable === undefined) {
    delete process.env[EXECUTABLE_ENV];
  } else {
    process.env[EXECUTABLE_ENV] = priorExecutable;
  }
  if (priorUserDataDir === undefined) {
    delete process.env[USER_DATA_DIR_ENV];
  } else {
    process.env[USER_DATA_DIR_ENV] = priorUserDataDir;
  }
  try {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Chrome executable detection
// ---------------------------------------------------------------------------

describe("detectChromeExecutable", () => {
  test("honours MINSKY_DEV_CHROMIUM_EXECUTABLE when the path exists", () => {
    const fakeExe = path.join(tmpStateDir, "fake-chrome");
    fs.writeFileSync(fakeExe, "#!/bin/sh\necho fake\n");
    process.env[EXECUTABLE_ENV] = fakeExe;
    expect(detectChromeExecutable()).toBe(fakeExe);
  });

  test("ignores the env override when the path does not exist", () => {
    process.env[EXECUTABLE_ENV] = path.join(tmpStateDir, "nonexistent");
    // Falls through to platform detection; result depends on what's installed.
    // We assert only that it doesn't return the bogus override.
    expect(detectChromeExecutable()).not.toBe(path.join(tmpStateDir, "nonexistent"));
  });

  test("returns first existing platform candidate", () => {
    const fakeExe = "/fake/google-chrome";
    const result = detectChromeExecutable({
      platform: "linux",
      existsFn: (p) => p === fakeExe,
    });
    // The Linux candidates list contains "/usr/bin/google-chrome" first,
    // but our fake exists check only accepts "/fake/google-chrome" — so
    // the function returns null (none of the listed candidates exist).
    expect(result).toBeNull();
  });

  test("picks the first available candidate when multiple exist", () => {
    const result = detectChromeExecutable({
      platform: "linux",
      existsFn: (p) => p === "/usr/bin/chromium" || p === "/usr/bin/google-chrome",
    });
    expect(result).toBe("/usr/bin/google-chrome"); // first in list
  });

  test("returns null on unknown platform", () => {
    expect(
      detectChromeExecutable({
        platform: "freebsd" as NodeJS.Platform,
        existsFn: () => true,
      })
    ).toBeNull();
  });

  test("returns null on macOS when no Chrome / Canary / Chromium installed", () => {
    expect(
      detectChromeExecutable({
        platform: "darwin",
        existsFn: () => false,
        pathEnv: "",
      })
    ).toBeNull();
  });

  test("falls back to PATH when no hardcoded candidate exists (linux)", () => {
    const pathDir = "/opt/local/bin";
    const found = path.join(pathDir, "chromium");
    const result = detectChromeExecutable({
      platform: "linux",
      pathEnv: pathDir,
      existsFn: (p) => p === found,
    });
    expect(result).toBe(found);
  });

  test("PATH fallback honours basename order: google-chrome wins over chromium", () => {
    const pathDir = "/usr/local/bin";
    const result = detectChromeExecutable({
      platform: "linux",
      pathEnv: pathDir,
      existsFn: (p) =>
        p === path.join(pathDir, "google-chrome") || p === path.join(pathDir, "chromium"),
    });
    expect(result).toBe(path.join(pathDir, "google-chrome"));
  });

  test("PATH fallback iterates multiple dirs in PATH order", () => {
    const first = "/first/bin";
    const second = "/second/bin";
    const result = detectChromeExecutable({
      platform: "linux",
      pathEnv: `${first}:${second}`,
      existsFn: (p) => p === path.join(second, "chromium-browser"),
    });
    expect(result).toBe(path.join(second, "chromium-browser"));
  });

  test("PATH fallback uses ';' delimiter on windows", () => {
    const dir = "C:\\\\custom\\\\bin";
    const result = detectChromeExecutable({
      platform: "win32",
      pathEnv: `C:\\\\other\\\\bin;${dir}`,
      existsFn: (p) => p === path.join(dir, "chrome.exe"),
    });
    expect(result).toBe(path.join(dir, "chrome.exe"));
  });

  test("PATH fallback returns null when PATH is empty and no fixed candidates exist", () => {
    expect(
      detectChromeExecutable({
        platform: "linux",
        pathEnv: "",
        existsFn: () => false,
      })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// User-data-dir resolution
// ---------------------------------------------------------------------------

describe("getDevChromiumUserDataDir", () => {
  test("honours MINSKY_DEV_CHROMIUM_USER_DATA_DIR override", () => {
    const override = path.join(tmpStateDir, "custom-profile");
    process.env[USER_DATA_DIR_ENV] = override;
    expect(getDevChromiumUserDataDir()).toBe(override);
  });

  test("default is under ~/.local/share/minsky/dev-chromium", () => {
    const result = getDevChromiumUserDataDir();
    expect(result.endsWith(path.join(".local", "share", "minsky", "dev-chromium"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// State-file lifecycle
// ---------------------------------------------------------------------------

function sampleState(over: Partial<DevChromiumState> = {}): DevChromiumState {
  return {
    pid: 4242,
    debuggingPort: DEFAULT_DEBUGGING_PORT,
    userDataDir: "/tmp/fake-profile",
    startedAt: "2026-05-18T18:00:00.000Z",
    ...over,
  };
}

describe("dev chromium state file lifecycle", () => {
  test("write + read round-trip", () => {
    writeDevChromiumState(sampleState());
    const read = readDevChromiumState();
    expect(read).toEqual(sampleState());
  });

  test("write is atomic (no .tmp.* left over)", () => {
    writeDevChromiumState(sampleState());
    const stateFile = getDevChromiumStateFilePath();
    const siblings = fs
      .readdirSync(path.dirname(stateFile))
      .filter((f) => f.startsWith("dev-chromium.json.tmp."));
    expect(siblings).toEqual([]);
  });

  test("read on missing file returns null", () => {
    expect(readDevChromiumState()).toBeNull();
  });

  test("read on malformed JSON returns null", () => {
    const p = getDevChromiumStateFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "garbage{{");
    expect(readDevChromiumState()).toBeNull();
  });

  test("read on wrong-shape JSON returns null", () => {
    const p = getDevChromiumStateFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ pid: "string" }));
    expect(readDevChromiumState()).toBeNull();
  });

  test("remove clears the file", () => {
    writeDevChromiumState(sampleState());
    expect(fs.existsSync(getDevChromiumStateFilePath())).toBe(true);
    removeDevChromiumState();
    expect(fs.existsSync(getDevChromiumStateFilePath())).toBe(false);
  });

  test("remove is silent on missing file", () => {
    expect(() => removeDevChromiumState()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

async function bindHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server has no address");
  return { server, port: addr.port };
}

async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("isDevChromiumRunning", () => {
  test("returns false against an unbound port", async () => {
    // Bind + immediately close to discover a port unlikely to be in use.
    const { server, port } = await bindHttpServer(() => {});
    await closeHttpServer(server);
    expect(await isDevChromiumRunning(port)).toBe(false);
  });

  test("returns true against a 200 /json/version response with Browser field", async () => {
    const { server, port } = await bindHttpServer((req, res) => {
      if (req.url === "/json/version") {
        res.statusCode = 200;
        res.setHeader("Content-Type", CONTENT_TYPE_JSON);
        res.end(JSON.stringify({ Browser: "Chrome/146.0.0.0" }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    try {
      expect(await isDevChromiumRunning(port)).toBe(true);
    } finally {
      await closeHttpServer(server);
    }
  });

  test("returns false against a 404 /json/version response", async () => {
    const { server, port } = await bindHttpServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    try {
      expect(await isDevChromiumRunning(port)).toBe(false);
    } finally {
      await closeHttpServer(server);
    }
  });

  test("returns false against a non-200 2xx response (e.g. 201)", async () => {
    const { server, port } = await bindHttpServer((_req, res) => {
      res.statusCode = 201;
      res.setHeader("Content-Type", CONTENT_TYPE_JSON);
      res.end(JSON.stringify({ Browser: "Chrome/146" }));
    });
    try {
      expect(await isDevChromiumRunning(port)).toBe(false);
    } finally {
      await closeHttpServer(server);
    }
  });

  test("returns false when 200 body is not JSON (rules out unrelated services)", async () => {
    const { server, port } = await bindHttpServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("not json");
    });
    try {
      expect(await isDevChromiumRunning(port)).toBe(false);
    } finally {
      await closeHttpServer(server);
    }
  });

  test("returns false when 200 JSON body lacks a Browser field", async () => {
    const { server, port } = await bindHttpServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", CONTENT_TYPE_JSON);
      res.end(JSON.stringify({ SomeOtherField: "value" }));
    });
    try {
      expect(await isDevChromiumRunning(port)).toBe(false);
    } finally {
      await closeHttpServer(server);
    }
  });

  test("returns false when 200 JSON body Browser field is empty", async () => {
    const { server, port } = await bindHttpServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", CONTENT_TYPE_JSON);
      res.end(JSON.stringify({ Browser: "" }));
    });
    try {
      expect(await isDevChromiumRunning(port)).toBe(false);
    } finally {
      await closeHttpServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// ensureDevChromiumRunning
// ---------------------------------------------------------------------------

describe("ensureDevChromiumRunning", () => {
  test("returns existing state when probe says running and state file exists", async () => {
    const existing = sampleState({ debuggingPort: 9222 });
    writeDevChromiumState(existing);
    const result = await ensureDevChromiumRunning({
      port: 9222,
      probeFn: async () => true,
    });
    expect(result).toEqual(existing);
  });

  test("returns null when probe says running but state file is missing", async () => {
    // Probe says running but no state file — chromium was launched outside
    // Minsky; we don't fabricate a PID.
    const result = await ensureDevChromiumRunning({
      port: 9222,
      probeFn: async () => true,
    });
    expect(result).toBeNull();
  });

  test("returns null with warning when no Chrome binary is detected", async () => {
    const warnings: string[] = [];
    const result = await ensureDevChromiumRunning({
      port: 9222,
      probeFn: async () => false,
      detectFn: () => null, // simulate no Chrome installed
      warn: (m) => warnings.push(m),
    });
    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("no Chrome / Chromium binary"))).toBe(true);
  });

  test("spawns and writes state when probe transitions from false → true", async () => {
    // Probe returns false on first call (pre-spawn), true on subsequent
    // calls (post-spawn). Use a counter to model the transition.
    let probeCalls = 0;
    const probeFn = async () => {
      probeCalls++;
      return probeCalls > 1; // first call false, then true
    };

    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      return { pid: 99999, unref: () => {} };
    };

    const result = await ensureDevChromiumRunning({
      port: 9222,
      executablePath: "/fake/chrome",
      userDataDir: path.join(tmpStateDir, "profile"),
      probeFn,
      spawnFn,
      spawnWaitMs: 1000,
      spawnPollMs: 50,
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.cmd).toBe("/fake/chrome");
    expect(spawnCalls[0]?.args).toContain("--remote-debugging-port=9222");
    expect(spawnCalls[0]?.args).toContain(`--user-data-dir=${path.join(tmpStateDir, "profile")}`);
    expect(result).not.toBeNull();
    expect(result?.pid).toBe(99999);
    expect(result?.debuggingPort).toBe(9222);
    // State file was written.
    expect(readDevChromiumState()?.pid).toBe(99999);
  });

  test("returns null with warning when spawn times out", async () => {
    const warnings: string[] = [];
    let spawnCalls = 0;
    const result = await ensureDevChromiumRunning({
      port: 9222,
      executablePath: "/fake/chrome",
      userDataDir: path.join(tmpStateDir, "profile"),
      probeFn: async () => false, // never comes up
      spawnFn: () => {
        spawnCalls++;
        return { pid: 88888, unref: () => {} };
      },
      warn: (m) => warnings.push(m),
      spawnWaitMs: 300,
      spawnPollMs: 50,
    });
    expect(spawnCalls).toBe(1);
    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("did not respond"))).toBe(true);
  });

  test("returns null with warning when spawn throws synchronously", async () => {
    const warnings: string[] = [];
    const result = await ensureDevChromiumRunning({
      port: 9222,
      executablePath: "/fake/chrome",
      userDataDir: path.join(tmpStateDir, "profile"),
      probeFn: async () => false,
      spawnFn: () => {
        throw new Error("ENOENT");
      },
      warn: (m) => warnings.push(m),
      spawnWaitMs: 100,
      spawnPollMs: 50,
    });
    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("ENOENT"))).toBe(true);
  });

  test("returns null with warning when spawn returns no PID", async () => {
    const warnings: string[] = [];
    const result = await ensureDevChromiumRunning({
      port: 9222,
      executablePath: "/fake/chrome",
      userDataDir: path.join(tmpStateDir, "profile"),
      probeFn: async () => false,
      spawnFn: () => ({ pid: undefined, unref: () => {} }),
      warn: (m) => warnings.push(m),
      spawnWaitMs: 100,
      spawnPollMs: 50,
    });
    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("without a PID"))).toBe(true);
  });
});
