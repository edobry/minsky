/**
 * MCP Server Staleness Detector
 *
 * Detects when the MCP server's loaded code is stale relative to the workspace.
 * Records git HEAD at startup, periodically checks if it moved and src/ changed.
 * Returns a warning message to append to tool responses when stale.
 */

import { execSync } from "child_process";
import { log } from "../utils/logger";

/** How often to re-check git HEAD (milliseconds) */
const CHECK_INTERVAL_MS = 60_000; // 60 seconds

type ExecFn = (
  cmd: string,
  opts: { cwd: string; timeout: number; stdio: unknown }
) => Buffer | string;

export class StalenessDetector {
  private startupHead: string | null = null;
  private workspacePath: string;
  private isStale = false;
  private staleMessage: string | null = null;
  private lastCheckTime = 0;
  private exec: ExecFn;

  constructor(workspacePath: string, exec?: ExecFn) {
    this.workspacePath = workspacePath;
    this.exec = exec ?? ((cmd, opts) => execSync(cmd, opts as Parameters<typeof execSync>[1]));
    this.startupHead = this.getGitHead();
    if (this.startupHead) {
      log.debug(`StalenessDetector: startup HEAD is ${this.startupHead.slice(0, 8)}`);
    }
  }

  /**
   * Get current git HEAD, or null if not a git repo / git not available
   */
  private getGitHead(): string | null {
    try {
      return this.exec("git rev-parse HEAD", {
        cwd: this.workspacePath,
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      })
        .toString()
        .trim();
    } catch {
      return null;
    }
  }

  /**
   * Check if src/ files changed between startup HEAD and current HEAD
   */
  private checkSrcChanged(currentHead: string): boolean {
    if (!this.startupHead) return false;
    try {
      const diff = this.exec(`git diff --name-only ${this.startupHead} ${currentHead} -- src/`, {
        cwd: this.workspacePath,
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      })
        .toString()
        .trim();
      return diff.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Whether the server has been detected as stale (cached result).
   * Distinct from `getStaleWarning()` which does a fresh check on first call.
   */
  isCurrentlyStale(): boolean {
    return this.isStale;
  }

  /**
   * Check for staleness (debounced). Call on each tool invocation.
   * Returns a warning string if stale, or null if current.
   */
  getStaleWarning(): string | null {
    // Already detected as stale — return cached message
    if (this.isStale) {
      return this.staleMessage;
    }

    // No startup HEAD — can't detect staleness
    if (!this.startupHead) {
      return null;
    }

    // Debounce: only check every CHECK_INTERVAL_MS
    const now = Date.now();
    if (now - this.lastCheckTime < CHECK_INTERVAL_MS) {
      return null;
    }
    this.lastCheckTime = now;

    // Check current HEAD
    const currentHead = this.getGitHead();
    if (!currentHead || currentHead === this.startupHead) {
      return null;
    }

    // HEAD moved — check if src/ changed
    if (this.checkSrcChanged(currentHead)) {
      this.isStale = true;
      this.staleMessage =
        `\n\n⚠️ The Minsky MCP server was loaded from commit ${this.startupHead.slice(0, 8)} ` +
        `but the workspace is now at ${currentHead.slice(0, 8)}. Source files have changed. ` +
        `Run: /mcp then reconnect minsky`;
      log.info(
        `StalenessDetector: server is stale (${this.startupHead.slice(0, 8)} → ${currentHead.slice(0, 8)})`
      );
      return this.staleMessage;
    }

    return null;
  }
}
