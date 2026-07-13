/**
 * Cockpit dev chromium tracker — ensures a shared Chrome instance is running
 * with remote debugging enabled so `chrome-devtools-mcp` can attach via
 * `--browser-url=http://127.0.0.1:9222` from any concurrent agent session.
 *
 * Idempotent: probes for an existing running instance via HTTP GET to
 * `/json/version`; spawns a new instance only when none is responding. Uses a
 * dedicated `--user-data-dir` so it doesn't interfere with the operator's
 * main Chrome profile.
 *
 * Lifecycle posture: launched lazily by `minsky cockpit start`; survives
 * `minsky cockpit` exit (detached + unref); subsequent invocations reuse the
 * already-running instance. Operator quits manually when done; next
 * `minsky cockpit start` re-spawns. No launchd / systemd / TaskScheduler —
 * intentional cross-platform Minsky-managed lifecycle (mt#1904 §Scope).
 *
 * @see mt#1904 — this module
 * @see src/cockpit/lifecycle.ts — sibling state-file convention
 */

import fs from "fs";
import path from "path";
import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { atomicWriteJSON, getStateDir } from "./lifecycle";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

export const DEFAULT_DEBUGGING_PORT = 9222;
const PROBE_TIMEOUT_MS = 2000;
const SPAWN_WAIT_MS = 8000;
const SPAWN_POLL_MS = 150;

// ---------------------------------------------------------------------------
// User-data-dir for the dev chromium (dedicated; does NOT touch main profile)
// ---------------------------------------------------------------------------

export function getDevChromiumUserDataDir(): string {
  const envDir = process.env["MINSKY_DEV_CHROMIUM_USER_DATA_DIR"];
  if (envDir) return envDir;
  return path.join(os.homedir(), ".local", "share", "minsky", "dev-chromium");
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

export interface DevChromiumState {
  pid: number;
  debuggingPort: number;
  userDataDir: string;
  startedAt: string;
}

export function getDevChromiumStateFilePath(): string {
  return path.join(getStateDir(), "dev-chromium.json");
}

export function writeDevChromiumState(state: DevChromiumState): void {
  atomicWriteJSON(getDevChromiumStateFilePath(), state);
}

export function removeDevChromiumState(): void {
  try {
    fs.unlinkSync(getDevChromiumStateFilePath());
  } catch {
    // Missing or permission error — silent.
  }
}

export function readDevChromiumState(): DevChromiumState | null {
  const filePath = getDevChromiumStateFilePath();
  if (!fs.existsSync(filePath)) return null;
  let raw: string;
  try {
    const contents = fs.readFileSync(filePath, { encoding: "utf-8" });
    raw = String(contents);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o["pid"] !== "number" ||
    typeof o["debuggingPort"] !== "number" ||
    typeof o["userDataDir"] !== "string" ||
    typeof o["startedAt"] !== "string"
  ) {
    return null;
  }
  return {
    pid: o["pid"] as number,
    debuggingPort: o["debuggingPort"] as number,
    userDataDir: o["userDataDir"] as string,
    startedAt: o["startedAt"] as string,
  };
}

// ---------------------------------------------------------------------------
// Chrome executable detection
//
// Cross-platform lookup table covering Chrome stable / Canary / Chromium on
// macOS, Linux, Windows. Operator can override via
// MINSKY_DEV_CHROMIUM_EXECUTABLE for non-standard installs.
// ---------------------------------------------------------------------------

const CHROME_DARWIN_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const CHROME_LINUX_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

const CHROME_WIN32_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

// PATH-fallback basenames searched after the fixed candidates fail. Covers
// NixOS, non-standard Homebrew, per-user installs, and any setup where the
// binary is on PATH but not at a hardcoded absolute path.
const CHROME_DARWIN_BASENAMES = ["google-chrome", "google-chrome-stable", "chromium", "chrome"];
const CHROME_LINUX_BASENAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "chrome",
];
const CHROME_WIN32_BASENAMES = ["chrome", "chrome.exe", "chromium", "chromium.exe"];

export interface DetectChromeOptions {
  /** Override fs.existsSync (test seam). */
  existsFn?: (p: string) => boolean;
  /** Override platform detection (test seam). */
  platform?: NodeJS.Platform;
  /** Override `process.env.PATH` (test seam). */
  pathEnv?: string;
}

function findOnPath(
  basenames: readonly string[],
  pathEnv: string,
  delimiter: string,
  exists: (p: string) => boolean
): string | null {
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const basename of basenames) {
      const candidate = path.join(dir, basename);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function detectChromeExecutable(opts: DetectChromeOptions = {}): string | null {
  const exists = opts.existsFn ?? ((p: string) => fs.existsSync(p));
  const platform = opts.platform ?? process.platform;
  const pathEnv = opts.pathEnv ?? process.env["PATH"] ?? "";

  const override = process.env["MINSKY_DEV_CHROMIUM_EXECUTABLE"];
  if (override && exists(override)) return override;

  let candidates: readonly string[];
  let basenames: readonly string[];
  switch (platform) {
    case "darwin":
      candidates = CHROME_DARWIN_PATHS;
      basenames = CHROME_DARWIN_BASENAMES;
      break;
    case "linux":
      candidates = CHROME_LINUX_PATHS;
      basenames = CHROME_LINUX_BASENAMES;
      break;
    case "win32":
      candidates = CHROME_WIN32_PATHS;
      basenames = CHROME_WIN32_BASENAMES;
      break;
    default:
      return null;
  }

  // 1. Try the fixed candidates first (most common installs).
  for (const p of candidates) {
    if (exists(p)) return p;
  }

  // 2. PATH fallback: covers NixOS, non-standard Homebrew, per-user installs.
  const delimiter = platform === "win32" ? ";" : ":";
  return findOnPath(basenames, pathEnv, delimiter, exists);
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Probe the debugging port for a live chromium. Returns true iff:
 *   - `GET http://127.0.0.1:<port>/json/version` responds within `PROBE_TIMEOUT_MS`
 *   - status is exactly 200 (not just any 2xx — Chrome's `/json/version`
 *     always returns 200 on success; tightening rules out misrouting through
 *     an unrelated 2xx-emitting proxy)
 *   - response body parses as JSON AND contains a `Browser` string field
 *     (DevTools protocol's `/json/version` contract — rules out a stranger
 *     service that happens to live on the port)
 *
 * Connection refused, timeout, non-200 responses, non-JSON bodies, and
 * missing `Browser` field all return false.
 */
export async function isDevChromiumRunning(
  port: number = DEFAULT_DEBUGGING_PORT
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: controller.signal,
      });
      if (res.status !== 200) return false;
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return false;
      }
      if (!body || typeof body !== "object") return false;
      const browser = (body as Record<string, unknown>)["Browser"];
      return typeof browser === "string" && browser.length > 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ensure running (idempotent spawn)
// ---------------------------------------------------------------------------

export interface EnsureDevChromiumOptions {
  /** Override the debugging port (default DEFAULT_DEBUGGING_PORT). */
  port?: number;
  /** Override the user-data-dir. */
  userDataDir?: string;
  /** Override the Chrome executable detection. */
  executablePath?: string;
  /** Test seam: override Chrome detection entirely (returns the exe path or null). */
  detectFn?: () => string | null;
  /** Test seam: override the running-probe. */
  probeFn?: (port: number) => Promise<boolean>;
  /** Test seam: override the spawn implementation. */
  spawnFn?: (
    cmd: string,
    args: string[],
    opts: { detached: boolean; stdio: "ignore" }
  ) => { pid?: number; unref(): void };
  /** Test seam: override the warn handler. */
  warn?: (message: string) => void;
  /** Test seam: override the spawn-wait deadline (ms). Default SPAWN_WAIT_MS. */
  spawnWaitMs?: number;
  /** Test seam: override the spawn-wait poll interval (ms). Default SPAWN_POLL_MS. */
  spawnPollMs?: number;
}

/**
 * Ensure a dev chromium is running with remote debugging enabled on `port`.
 *
 * Returns the recorded state on success (newly spawned OR already running).
 * Returns null on detection failure (no Chrome binary, spawn error) — the
 * caller logs and continues; cockpit still serves, just without the
 * agent-driven inspection surface.
 */
export async function ensureDevChromiumRunning(
  opts: EnsureDevChromiumOptions = {}
): Promise<DevChromiumState | null> {
  const port = opts.port ?? DEFAULT_DEBUGGING_PORT;
  const userDataDir = opts.userDataDir ?? getDevChromiumUserDataDir();
  const probe = opts.probeFn ?? isDevChromiumRunning;
  const warn = opts.warn ?? ((m: string) => log.cliWarn(m));
  const spawnWaitMs = opts.spawnWaitMs ?? SPAWN_WAIT_MS;
  const spawnPollMs = opts.spawnPollMs ?? SPAWN_POLL_MS;
  const doSpawn =
    opts.spawnFn ??
    ((cmd: string, args: string[], spawnOpts: { detached: boolean; stdio: "ignore" }) =>
      spawn(cmd, args, spawnOpts) as ChildProcess);

  // 1. Probe first. If already running, return existing state (or write a
  //    placeholder if the state file vanished while the process kept running).
  if (await probe(port)) {
    const existing = readDevChromiumState();
    if (existing && existing.debuggingPort === port) return existing;
    // Probe says running but we have no record — the operator started chromium
    // outside Minsky. We DON'T fabricate a PID. Return null so the caller
    // knows the cockpit can attach but we don't own this chromium's lifecycle.
    return null;
  }

  // 2. Detect executable.
  const detect = opts.detectFn ?? (() => detectChromeExecutable());
  const exe = opts.executablePath ?? detect();
  if (!exe) {
    warn(
      `Cockpit dev chromium: no Chrome / Chromium binary found on this platform ` +
        `(${process.platform}). Set MINSKY_DEV_CHROMIUM_EXECUTABLE to override. ` +
        `Skipping dev chromium launch.`
    );
    return null;
  }

  // 3. Ensure user-data-dir exists.
  try {
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
  } catch (err) {
    const e = err as Error;
    warn(`Cockpit dev chromium: failed to create user-data-dir ${userDataDir}: ${e.message}`);
    return null;
  }

  // 4. Spawn detached.
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  let child: { pid?: number; unref(): void };
  try {
    child = doSpawn(exe, args, { detached: true, stdio: "ignore" });
  } catch (err) {
    const e = err as Error;
    warn(`Cockpit dev chromium: failed to spawn ${exe}: ${e.message}`);
    return null;
  }
  try {
    child.unref();
  } catch {
    // unref is best-effort — some test stubs may omit it.
  }
  if (typeof child.pid !== "number") {
    warn(`Cockpit dev chromium: spawn(${exe}) returned without a PID.`);
    return null;
  }

  // 5. Wait for the debug port to come up.
  const deadline = Date.now() + spawnWaitMs;
  while (Date.now() < deadline) {
    if (await probe(port)) {
      const state: DevChromiumState = {
        pid: child.pid,
        debuggingPort: port,
        userDataDir,
        startedAt: new Date().toISOString(),
      };
      try {
        writeDevChromiumState(state);
      } catch (err) {
        const e = err as Error;
        warn(`Cockpit dev chromium: failed to write state file: ${e.message}`);
      }
      return state;
    }
    await new Promise((r) => setTimeout(r, spawnPollMs));
  }

  warn(
    `Cockpit dev chromium: spawned ${exe} (PID ${child.pid}) but /json/version did not ` +
      `respond within ${spawnWaitMs}ms; cockpit will still run but the agent-driven ` +
      `inspection surface may be unavailable.`
  );
  return null;
}
