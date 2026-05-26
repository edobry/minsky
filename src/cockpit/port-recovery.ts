/**
 * Cockpit port recovery — detect what's holding a port, recognize our own
 * stale instances via the per-workspace state file (owned by lifecycle.ts),
 * and provide opt-in kill of recognized zombies (never of arbitrary
 * processes). Also provides a best-effort cross-platform browser opener for
 * the `--open` flag.
 *
 * State-file ownership moved to src/cockpit/lifecycle.ts in mt#1904:
 * recognition is now per-workspace, so concurrent cockpits in different
 * operator session workspaces don't false-positive each other.
 *
 * @see mt#1887 — port-recovery (this module)
 * @see mt#1904 — lifecycle refactor; src/cockpit/lifecycle.ts owns the state file
 * @see src/mcp/daemon-state.ts — sibling state-file convention
 */

import { execSync, spawn, type SpawnOptions } from "child_process";
import { readCurrentCockpitState } from "./lifecycle";
import { log } from "@minsky/shared/logger";

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

export interface PortHolder {
  pid: number;
  command: string;
}

export type PortClassification =
  | { kind: "free" }
  | { kind: "recognized-zombie"; pid: number; command: string }
  | { kind: "unrecognized"; pid: number; command: string };

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
//
// "recognized-zombie" requires THIS workspace's prior cockpit state to match
// the port-holder. Peer cockpits in other workspaces are "unrecognized" — we
// will never auto-kill another workspace's cockpit even with `--force`.
// ---------------------------------------------------------------------------

export function classifyPortHolder(port: number): PortClassification {
  const holder = findPortHolder(port);
  if (!holder) return { kind: "free" };

  const state = readCurrentCockpitState();
  if (state && state.pid === holder.pid && state.port === port) {
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
  // Default to log.cliWarn (CLI-visible via programLogger → stderr) rather than
  // log.warn (suppressed in HUMAN mode unless ENABLE_AGENT_LOGS is set). The
  // --open opener is invoked from a CLI command; opener failures must reach
  // the user. Per PR #1151 R1 (mt#1887) — BLOCKING #1.
  const warn = opts.warn ?? ((m: string) => log.cliWarn(m));
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
