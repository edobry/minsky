/**
 * Cockpit port recovery — detect what's holding a port, recognize our own
 * stale instances via a PID file, and provide opt-in kill of recognized
 * zombies (never of arbitrary processes). Also provides a best-effort
 * cross-platform browser opener for the `--open` flag.
 *
 * @see mt#1887 — this module
 * @see src/mcp/daemon-state.ts — sibling state-file convention
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync, spawn, type SpawnOptions } from "child_process";
import { log } from "../utils/logger";

// The project's narrowed `process` type omits EventEmitter methods like
// `kill`. Cast to a Node-shaped surface for the signal-handling APIs we
// need — mirrors the pattern at `src/mcp/server.ts:1340-1345`.
// eslint-disable-next-line custom/no-excessive-as-unknown
const proc = process as unknown as {
  pid: number;
  kill(pid: number, signal: NodeJS.Signals | number): void;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CockpitPidFile {
  pid: number;
  port: number;
  startedAt: string;
}

export interface PortHolder {
  pid: number;
  command: string;
}

export type PortClassification =
  | { kind: "free" }
  | { kind: "recognized-zombie"; pid: number; command: string }
  | { kind: "unrecognized"; pid: number; command: string };

// ---------------------------------------------------------------------------
// State directory (shared with disconnect-tracker, daemon-state)
// ---------------------------------------------------------------------------

function getStateDir(): string {
  const envDir = process.env["MINSKY_STATE_DIR"];
  if (envDir) return envDir;
  return path.join(os.homedir(), ".local", "state", "minsky");
}

export function getCockpitPidFilePath(): string {
  return path.join(getStateDir(), "cockpit.pid");
}

// ---------------------------------------------------------------------------
// PID file read / write / remove
// ---------------------------------------------------------------------------

export function writeCockpitPidFile(port: number): void {
  const statePath = getCockpitPidFilePath();
  const stateDir = path.dirname(statePath);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const data: CockpitPidFile = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  };

  const tmp = `${statePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
  fs.renameSync(tmp, statePath);
}

export function removeCockpitPidFile(): void {
  try {
    fs.unlinkSync(getCockpitPidFilePath());
  } catch {
    // Missing or permission error — silent.
  }
}

export function readCockpitPidFile(filePath?: string): CockpitPidFile | null {
  const p = filePath ?? getCockpitPidFilePath();
  if (!fs.existsSync(p)) return null;
  let raw: string;
  try {
    const contents = fs.readFileSync(p, { encoding: "utf-8" });
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
    typeof o["port"] !== "number" ||
    typeof o["startedAt"] !== "string"
  ) {
    return null;
  }
  return {
    pid: o["pid"] as number,
    port: o["port"] as number,
    startedAt: o["startedAt"] as string,
  };
}

// ---------------------------------------------------------------------------
// Process introspection
// ---------------------------------------------------------------------------

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    proc.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code === "EPERM";
  }
}

/**
 * Find the process holding the given port. Returns null on Windows (no `lsof`)
 * or if `lsof` isn't available — port-recovery degrades to the standard
 * EADDRINUSE error in that case.
 */
export function findPortHolder(port: number): PortHolder | null {
  if (process.platform === "win32") return null;

  let pidLine: string;
  try {
    pidLine = execSync(`lsof -i :${port} -sTCP:LISTEN -P -n -t`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      encoding: "utf-8",
    }).toString();
  } catch {
    // lsof exits non-zero when nothing matches.
    return null;
  }

  const firstPid = parseInt(pidLine.split(/\s+/).filter(Boolean)[0] ?? "", 10);
  if (!Number.isInteger(firstPid) || firstPid <= 0) return null;

  let command = "<unknown>";
  try {
    command = execSync(`ps -p ${firstPid} -o command=`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      encoding: "utf-8",
    })
      .toString()
      .trim();
  } catch {
    // Fall through with "<unknown>" — still report the PID.
  }
  return { pid: firstPid, command };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyPortHolder(port: number): PortClassification {
  const holder = findPortHolder(port);
  if (!holder) return { kind: "free" };

  const pidFile = readCockpitPidFile();
  if (pidFile && pidFile.pid === holder.pid && pidFile.port === port) {
    return { kind: "recognized-zombie", pid: holder.pid, command: holder.command };
  }
  return { kind: "unrecognized", pid: holder.pid, command: holder.command };
}

// ---------------------------------------------------------------------------
// Kill zombie (SIGTERM → wait → SIGKILL)
// ---------------------------------------------------------------------------

export interface KillZombieOptions {
  /** Time to wait for SIGTERM to take effect before SIGKILL. Default 2000ms. */
  timeoutMs?: number;
  /** Polling interval while waiting. Default 100ms. */
  pollMs?: number;
}

export async function killZombie(pid: number, opts: KillZombieOptions = {}): Promise<void> {
  const timeout = opts.timeoutMs ?? 2000;
  const poll = opts.pollMs ?? 100;

  try {
    proc.kill(pid, "SIGTERM");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return; // already dead
    throw err;
  }

  const start = Date.now();
  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, poll));
    if (!isProcessAlive(pid)) return;
  }
  try {
    proc.kill(pid, "SIGKILL");
  } catch {
    // Race: died between checks. Ignore.
  }
}

// ---------------------------------------------------------------------------
// Browser opener (best-effort)
// ---------------------------------------------------------------------------

export interface OpenInBrowserOptions {
  /** Override platform detection (test seam). */
  platform?: NodeJS.Platform;
  /**
   * Override spawn implementation (test seam). Must mimic `child_process.spawn`
   * — accept (cmd, args, opts) and return an object with `on(event, handler)`
   * and `unref()`.
   */
  spawnFn?: (cmd: string, args: string[], options: SpawnOptions) => SpawnLike;
  /** Override warn handler (test seam). Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

export interface SpawnLike {
  on(event: string, handler: (err: Error) => void): void;
  unref(): void;
}

function defaultSpawnFn(cmd: string, args: string[], options: SpawnOptions): SpawnLike {
  return spawn(cmd, args, options);
}

export function openInBrowser(url: string, opts: OpenInBrowserOptions = {}): void {
  const platform = opts.platform ?? process.platform;
  const warn = opts.warn ?? ((m: string) => log.warn(m));
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;

  let cmd: string;
  let args: string[];
  switch (platform) {
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    case "linux":
      cmd = "xdg-open";
      args = [url];
      break;
    case "win32":
      cmd = "cmd";
      // Empty title argument so the url itself isn't treated as the title.
      args = ["/c", "start", "", url];
      break;
    default:
      warn(`Cockpit --open: no default browser opener for platform "${platform}"; skipping.`);
      return;
  }

  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (err: Error) => {
      warn(`Cockpit --open: failed to invoke ${cmd}: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    const e = err as Error;
    warn(`Cockpit --open: failed to invoke ${cmd}: ${e.message}`);
  }
}
