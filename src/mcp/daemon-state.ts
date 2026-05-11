/**
 * MCP Daemon State — write a small JSON file on server startup so the
 * `mcp-daemon-staleness-detector` hook can compare the running daemon's
 * start-commit against the current HEAD.
 *
 * Convention: `~/.local/state/minsky/mcp-daemon-state.json`.
 * Same state dir as `disconnect-tracker.ts` (`MINSKY_STATE_DIR` env override).
 *
 * @see mt#1717 — this module
 * @see src/mcp/disconnect-tracker.ts — state-dir convention
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { log } from "../utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonState {
  /**
   * `git rev-parse HEAD` resolved at daemon startup, from the global-install
   * working tree (NOT from process.cwd() which may be the user's project).
   * The hook uses this to detect source drift.
   */
  startCommit: string;
  /** ISO-8601 timestamp of daemon startup. */
  startTimestamp: string;
  /** `process.pid` of the MCP server process. */
  pid: number;
  /** MCP server name — matches the server name used by disconnect-tracker. */
  serverName: string;
}

// ---------------------------------------------------------------------------
// State directory (shared convention with disconnect-tracker)
// ---------------------------------------------------------------------------

function getStateDir(): string {
  const envDir = process.env["MINSKY_STATE_DIR"];
  if (envDir) return envDir;
  return path.join(os.homedir(), ".local", "state", "minsky");
}

export function getDaemonStatePath(): string {
  return path.join(getStateDir(), "mcp-daemon-state.json");
}

// ---------------------------------------------------------------------------
// Global symlink path for the Minsky working tree
// ---------------------------------------------------------------------------

/**
 * The global bun-install symlink that points at the checked-out Minsky repo.
 * Used to resolve `git rev-parse HEAD` in the Minsky working tree regardless
 * of what directory the daemon was launched from.
 *
 * Memory `5fecae10`: `/Users/edobry/.bun/install/global/node_modules/minsky`
 * → `/Users/edobry/Projects/minsky`.
 *
 * We compute this at runtime so a new install path doesn't require a code
 * change. The fallback chain:
 *   1. `$MINSKY_HOME` env var (allows overrides in CI / tests)
 *   2. Standard bun global install path
 *   3. `process.cwd()` as a last resort (will work in dev but not after a
 *      path-changing reinstall)
 */
export function resolveMinskyHomeDir(): string {
  const envOverride = process.env["MINSKY_HOME"];
  if (envOverride) return envOverride;

  // Try the bun global install symlink — typical layout on macOS/Linux.
  const home = os.homedir();
  const bunGlobal = path.join(home, ".bun", "install", "global", "node_modules", "minsky");
  if (fs.existsSync(bunGlobal)) {
    try {
      // Resolve the symlink to the real path.
      return fs.realpathSync(bunGlobal);
    } catch {
      // If realpath fails, use the symlink path as-is (git will follow it).
      return bunGlobal;
    }
  }

  // Fall back to wherever the process started (works in development).
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Git HEAD resolver
// ---------------------------------------------------------------------------

/**
 * Run `git rev-parse HEAD` in `repoDir`. Returns the full commit SHA or null
 * if git fails (missing repo, detached HEAD without a commit, etc.).
 */
export function resolveHeadCommit(repoDir: string): string | null {
  try {
    const result = execSync("git rev-parse HEAD", {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      encoding: "utf8",
    });
    const sha = (typeof result === "string" ? result : result.toString()).trim();
    if (/^[0-9a-f]{7,}$/i.test(sha)) return sha;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write / read
// ---------------------------------------------------------------------------

/**
 * Write the daemon state file on server startup.
 *
 * Called from `src/mcp/server.ts` constructor after the server is wired.
 * Failures are logged as warnings — the file is informational; missing it
 * causes the hook to silently skip (fail-open posture).
 */
export function writeDaemonState(serverName: string): void {
  try {
    const minskyDir = resolveMinskyHomeDir();
    const startCommit = resolveHeadCommit(minskyDir);
    if (!startCommit) {
      log.warn("daemon-state: could not resolve HEAD commit — skipping state file write", {
        minskyDir,
      });
      return;
    }

    const state: DaemonState = {
      startCommit,
      startTimestamp: new Date().toISOString(),
      pid: process.pid,
      serverName,
    };

    const statePath = getDaemonStatePath();
    const stateDir = path.dirname(statePath);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    // Write atomically: tmp file → rename.
    const tmp = `${statePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, statePath);

    log.info("daemon-state: wrote daemon state file", {
      path: statePath,
      startCommit,
      pid: process.pid,
    });
  } catch (err) {
    log.warn("daemon-state: failed to write daemon state file (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read the daemon state file. Returns null if the file is missing,
 * unreadable, or has an unexpected shape.
 *
 * Exported for use by the hook and tests.
 */
export function readDaemonState(statePath?: string): DaemonState | null {
  const p = statePath ?? getDaemonStatePath();
  if (!fs.existsSync(p)) return null;
  let raw: string;
  try {
    const contents = fs.readFileSync(p, { encoding: "utf8" });
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
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj["startCommit"] !== "string" ||
    typeof obj["startTimestamp"] !== "string" ||
    typeof obj["pid"] !== "number" ||
    typeof obj["serverName"] !== "string"
  ) {
    return null;
  }
  return {
    startCommit: obj["startCommit"] as string,
    startTimestamp: obj["startTimestamp"] as string,
    pid: obj["pid"] as number,
    serverName: obj["serverName"] as string,
  };
}
