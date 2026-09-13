/**
 * MCP Server Staleness Detector
 *
 * Detects when the MCP server's loaded code is stale relative to the workspace.
 * Records git HEAD at startup, periodically checks if it moved and whether any of the
 * server's SOURCE ROOTS changed (`src/` plus every `packages/<pkg>/src/` — see
 * `discoverSourceRoots`). Returns a warning message to append to tool responses when stale.
 */

import { execSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { log } from "@minsky/shared/logger";

/** How often to re-check git HEAD (milliseconds) */
const CHECK_INTERVAL_MS = 60_000; // 60 seconds

type ExecFn = (
  cmd: string,
  opts: { cwd: string; timeout: number; stdio: unknown }
) => Buffer | string;

/**
 * The tree the server's ENTRY POINT lives in: the daemon is spawned as `bun run src/cli.ts`
 * (or the bundle built from it), so a relative import from that entry resolves within `src/`.
 * Kept as a pathspec (trailing slash) so it can be handed to `git diff` unchanged.
 */
const ENTRY_TREE_PATHSPEC = "src/";

/**
 * The workspace-packages directory. Each `<pkg>/src` under it is a source root the server
 * loads through the `@minsky/*` workspace packages (`packages/domain`, `packages/shared`
 * today). Discovered, never listed by name — see `discoverSourceRoots`.
 */
const WORKSPACE_PACKAGES_DIR = "packages";

/**
 * The two filesystem reads `discoverSourceRoots` needs, injectable so a test can describe a
 * layout without touching the disk. `listDirectories` throws when `dir` is missing or
 * unreadable — that is the signal the discovery degrades on.
 */
export interface SourceRootsFs {
  listDirectories(dir: string): string[];
  isDirectory(path: string): boolean;
}

const realSourceRootsFs: SourceRootsFs = {
  listDirectories: (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  isDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
};

/** Resolves the source roots for a workspace; the seam `StalenessDetector` takes. */
export type SourceRootsFn = (workspacePath: string) => string[];

/**
 * Every source root whose change invalidates the running server, as workspace-relative git
 * pathspecs: `src/` first, then every `packages/<pkg>/src/` that exists, sorted.
 *
 * Until mt#5120 the detector diffed `-- src/` alone. That was the whole closure when all served
 * code lived under `src/`; the `packages/domain/` extraction (mt#2108) moved most of it under
 * `packages/<pkg>/src` without moving the pathspec, so a merge confined to `packages/**` left the
 * tray-supervised daemon serving the old build indefinitely (observed 2026-09-13: PR #3741
 * changed only `packages/domain/src/compile/*` and the daemon ran the pre-merge code until a
 * manual `mcp_restart`). The cockpit daemon's tray watcher hit the same defect twice (mt#4230,
 * mt#5060) and settled on this shape — `cockpit_backend_roots()` in
 * `cockpit-tray/src-tauri/src/watcher_backend.rs` is the sibling list for that daemon.
 *
 * Why DISCOVER rather than name `packages/domain/src` + `packages/shared/src`: a hard-coded set
 * reproduces this defect one level up — the watched set drifts from the real import closure,
 * silently, and the tell is a daemon serving stale code with nothing to notice. Why a tree root
 * rather than the exact import closure: the superset cannot miss a closure file and cannot drift
 * as subdirectories appear; the cost is a spurious restart on an edit to a module the server
 * never loads, which the tray already accepted for the same reason.
 *
 * A missing or unreadable `packages/` (a packaged or partial checkout) yields `["src/"]` — the
 * entry tree alone — rather than failing the check.
 */
export function discoverSourceRoots(
  workspacePath: string,
  fs: SourceRootsFs = realSourceRootsFs
): string[] {
  const roots = [ENTRY_TREE_PATHSPEC];
  const packagesDir = join(workspacePath, WORKSPACE_PACKAGES_DIR);
  let packageNames: string[];
  try {
    packageNames = fs.listDirectories(packagesDir);
  } catch {
    // intentional-swallow: no `packages/` directory means no workspace packages to watch; the
    // entry tree is still a correct (narrower) root set, and a throw here would disable
    // staleness detection entirely on a checkout that merely lacks the packages tree.
    return roots;
  }
  const discovered = packageNames
    .filter((name) => fs.isDirectory(join(packagesDir, name, "src")))
    .map((name) => `${WORKSPACE_PACKAGES_DIR}/${name}/src/`)
    .sort();
  return [...roots, ...discovered];
}

export class StalenessDetector {
  private startupHead: string | null = null;
  private workspacePath: string;
  private isStale = false;
  private staleMessage: string | null = null;
  private lastCheckTime = 0;
  private exec: ExecFn;
  private discoverRoots: SourceRootsFn;

  constructor(
    workspacePath: string,
    exec?: ExecFn,
    discoverRoots: SourceRootsFn = discoverSourceRoots
  ) {
    this.workspacePath = workspacePath;
    this.exec = exec ?? ((cmd, opts) => execSync(cmd, opts as Parameters<typeof execSync>[1]));
    this.discoverRoots = discoverRoots;
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
   * Check if any file under the server's source roots changed between startup HEAD and
   * current HEAD. The roots are re-discovered on every check (at most once per
   * `CHECK_INTERVAL_MS`) so a package added by a later commit is covered by the check that
   * follows it, and every root goes to git as its own pathspec in ONE diff.
   */
  private checkSourceRootsChanged(currentHead: string): boolean {
    if (!this.startupHead) return false;
    const pathspecs = this.discoverRoots(this.workspacePath).join(" ");
    try {
      const diff = this.exec(
        `git diff --name-only ${this.startupHead} ${currentHead} -- ${pathspecs}`,
        {
          cwd: this.workspacePath,
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        }
      )
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

    // HEAD moved — check if any source root changed. The `loaded from commit X … now at Y`
    // shape is parsed by `triggerStaleSignal` in server.ts; keep both anchors intact.
    if (this.checkSourceRootsChanged(currentHead)) {
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
