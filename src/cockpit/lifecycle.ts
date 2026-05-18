/**
 * Cockpit lifecycle module — per-workspace state file management.
 *
 * Owns the state file that port-recovery (mt#1887) and dev-chromium (mt#1904)
 * consume. State files live at
 * `~/.local/state/minsky/cockpit/<workspace-key>.json` where `<workspace-key>`
 * is the session ID for session workspaces (extracted from path under
 * `getSessionsDir()`) or the literal string `"main"` for the main workspace.
 *
 * This module replaces mt#1887's single-global `~/.local/state/minsky/cockpit.pid`.
 * Multi-cockpit concurrency across operator session workspaces is the reason
 * for the per-workspace keying — under the global model, legitimate peer
 * cockpits would have been misclassified as recoverable zombies.
 *
 * @see mt#1887 — port-recovery (absorbed via mt#1904 refactor)
 * @see mt#1904 — this module + dev-chromium tracker
 */

import fs from "fs";
import path from "path";
import os from "os";
import { getSessionsDir } from "../utils/paths";

// ---------------------------------------------------------------------------
// State directory
//
// MINSKY_STATE_DIR is the documented env-var override (shared with
// disconnect-tracker, daemon-state, and historical port-recovery). Default
// path matches the XDG-style convention used elsewhere in Minsky.
// ---------------------------------------------------------------------------

export function getStateDir(): string {
  const envDir = process.env["MINSKY_STATE_DIR"];
  if (envDir) return envDir;
  return path.join(os.homedir(), ".local", "state", "minsky");
}

export function getCockpitStateDir(): string {
  return path.join(getStateDir(), "cockpit");
}

// ---------------------------------------------------------------------------
// Workspace key resolution
//
// Mirrors `isSessionWorkspace(...)` at src/domain/workspace.ts:51 +
// session-ID extraction at src/domain/workspace.ts:85-87. Duplicated locally
// to avoid pulling tsyringe / SessionProviderInterface into the cockpit
// module (cockpit is intentionally standalone per src/cockpit/CLAUDE.md
// "DI: None (standalone Express, no tsyringe)").
// ---------------------------------------------------------------------------

export const MAIN_WORKSPACE_KEY = "main";

/**
 * Returns the workspace key for `cwd`:
 *   - When inside a session workspace (path under `getSessionsDir()`), the
 *     session ID (first path segment after the sessions dir).
 *   - Otherwise, the literal string `"main"`.
 */
export function resolveWorkspaceKey(cwd: string): string {
  const sessionsDir = getSessionsDir();
  if (!cwd.startsWith(sessionsDir + path.sep) && cwd !== sessionsDir) {
    return MAIN_WORKSPACE_KEY;
  }
  const rel = cwd.substring(sessionsDir.length + 1);
  const sessionId = rel.split(path.sep)[0];
  return sessionId && sessionId.length > 0 ? sessionId : MAIN_WORKSPACE_KEY;
}

// ---------------------------------------------------------------------------
// State-file shape
// ---------------------------------------------------------------------------

export interface CockpitState {
  /** PID of the cockpit server process. */
  pid: number;
  /** Port the cockpit server is listening on. */
  port: number;
  /** Full URL the cockpit is serving from (e.g. http://localhost:3737). */
  url: string;
  /** Workspace key — session ID or "main". Also encoded in the filename. */
  workspaceId: string;
  /** Absolute path of the workspace the cockpit was started in. */
  workspacePath: string;
  /** ISO timestamp when the cockpit started. */
  startedAt: string;
  /** PID of the dev chromium that Minsky launched for this cockpit, if any. */
  devChromiumPid?: number;
}

export function getCockpitStateFilePath(workspaceKey: string): string {
  return path.join(getCockpitStateDir(), `${workspaceKey}.json`);
}

// ---------------------------------------------------------------------------
// Atomic JSON write (cross-platform)
//
// POSIX `rename(2)` overwrites the destination atomically. Windows
// `renameSync` does NOT — it can throw EPERM/EEXIST if the destination is
// in use or already exists. The fallback path removes the destination and
// retries the rename. Temp files are cleaned up on any failure path so we
// don't leak `.tmp.<pid>` siblings.
//
// Shared between cockpit lifecycle state and dev-chromium state — both files
// have the same write semantics and the same Windows-portability concern.
// ---------------------------------------------------------------------------

export function atomicWriteJSON(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
    try {
      fs.renameSync(tmp, filePath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Windows path: rename may not overwrite an existing destination.
      // Remove destination and retry. Other error codes propagate.
      if (e.code === "EPERM" || e.code === "EEXIST" || e.code === "EACCES") {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          // best-effort
        }
        fs.renameSync(tmp, filePath);
      } else {
        throw err;
      }
    }
  } catch (err) {
    // Clean up tmp on any failure (write error, rename error after retry).
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Read / write / remove
// ---------------------------------------------------------------------------

/**
 * Write the cockpit state file atomically. Cross-platform safe via the
 * shared `atomicWriteJSON` helper above.
 */
export function writeCockpitState(state: CockpitState): void {
  atomicWriteJSON(getCockpitStateFilePath(state.workspaceId), state);
}

/**
 * Remove the cockpit state file for the given workspace key. Silent on
 * missing-file / permission errors.
 */
export function removeCockpitState(workspaceKey: string): void {
  try {
    fs.unlinkSync(getCockpitStateFilePath(workspaceKey));
  } catch {
    // Missing or permission error — silent.
  }
}

/**
 * Read the cockpit state file for the given workspace key.
 *
 * Returns null on missing file, malformed JSON, or wrong-shape JSON — the
 * caller treats those uniformly as "no state" so stale-file recovery is
 * cleanly idempotent (write overwrites whatever's there).
 */
export function readCockpitState(workspaceKey: string): CockpitState | null {
  const filePath = getCockpitStateFilePath(workspaceKey);
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
    typeof o["port"] !== "number" ||
    typeof o["url"] !== "string" ||
    typeof o["workspaceId"] !== "string" ||
    typeof o["workspacePath"] !== "string" ||
    typeof o["startedAt"] !== "string"
  ) {
    return null;
  }
  const result: CockpitState = {
    pid: o["pid"] as number,
    port: o["port"] as number,
    url: o["url"] as string,
    workspaceId: o["workspaceId"] as string,
    workspacePath: o["workspacePath"] as string,
    startedAt: o["startedAt"] as string,
  };
  if (typeof o["devChromiumPid"] === "number") {
    result.devChromiumPid = o["devChromiumPid"] as number;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Convenience helpers for the current workspace (process.cwd()-based)
// ---------------------------------------------------------------------------

export interface WriteCurrentArgs {
  pid: number;
  port: number;
  url: string;
  startedAt?: string;
  devChromiumPid?: number;
}

/**
 * Write the cockpit state for the CURRENT workspace (resolved from `cwd`,
 * defaulting to `process.cwd()`). Returns the written state.
 */
export function writeCurrentCockpitState(
  args: WriteCurrentArgs,
  cwd: string = process.cwd()
): CockpitState {
  const workspaceKey = resolveWorkspaceKey(cwd);
  const state: CockpitState = {
    pid: args.pid,
    port: args.port,
    url: args.url,
    workspaceId: workspaceKey,
    workspacePath: cwd,
    startedAt: args.startedAt ?? new Date().toISOString(),
    ...(args.devChromiumPid !== undefined ? { devChromiumPid: args.devChromiumPid } : {}),
  };
  writeCockpitState(state);
  return state;
}

/** Remove the cockpit state file for the current workspace. */
export function removeCurrentCockpitState(cwd: string = process.cwd()): void {
  removeCockpitState(resolveWorkspaceKey(cwd));
}

/** Read the cockpit state file for the current workspace. */
export function readCurrentCockpitState(cwd: string = process.cwd()): CockpitState | null {
  return readCockpitState(resolveWorkspaceKey(cwd));
}
