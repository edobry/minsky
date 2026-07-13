/**
 * Loaded-source freshness signal (mt#2335).
 *
 * Lets `debug.systemInfo` report whether the running daemon's code is current
 * with the repo's HEAD. This is the deterministic replacement for the prose
 * diagnostic ladder in `feedback_post_merge_pull_hook...` (memory `0e39c87e`):
 * after a merge, a just-changed MCP tool can keep returning pre-merge behavior
 * because the `minsky` binary runs the `dist/minsky.js` BUNDLE via
 * `scripts/cli-entry.ts` (mt#1740), which only rebuilds lazily on the next
 * staleness-respawn (mt#1714). That is rebuild LATENCY, not permanent staleness
 * — but there was no machine-readable way to tell the two apart. This signal
 * makes "is the loaded bundle current?" a single field instead of a multi-step
 * shell probe.
 *
 * The launcher (`scripts/cli-entry.ts`) records the loaded-source facts into
 * process env BEFORE it `import()`s the bundle (it cannot call into a module
 * that lives inside the bundle before importing it). This module reads those
 * env vars and computes the current HEAD at call time:
 *
 *   - `MINSKY_LOADED_COMMIT` — the commit the running code reflects (bundle:
 *     `dist/.build-stamp`; source-fallback: load-time HEAD).
 *   - `MINSKY_RUN_MODE`      — `"bundle"` | `"source-fallback"`.
 *   - `MINSKY_PACKAGE_ROOT`  — install root (where `.git`/`dist` live), used as
 *     the cwd for the call-time `git rev-parse HEAD`.
 *
 * All three are registered in `HOOK_ONLY_ENV_VARS` so the env-var-to-config
 * parser skips them at boot (mt#1785 class).
 */

import { spawnSync } from "child_process";

export const LOADED_COMMIT_ENV = "MINSKY_LOADED_COMMIT";
export const RUN_MODE_ENV = "MINSKY_RUN_MODE";
export const PACKAGE_ROOT_ENV = "MINSKY_PACKAGE_ROOT";

/**
 * TTL for the default git-HEAD cache. `debug.systemInfo` is a diagnostic tool,
 * not a tight-loop hot path, but a short cache bounds the cost of repeated calls
 * so the synchronous `git rev-parse` never becomes a CPU/latency sink (PR #1599
 * R1). HEAD advances on merges; a few seconds of staleness is acceptable for a
 * freshness *diagnostic*.
 */
export const GIT_HEAD_CACHE_TTL_MS = 2_000;

export type RunMode = "bundle" | "source-fallback" | "unknown";

export interface SourceFreshness {
  /** Commit the running daemon's code was built/loaded from, or null if unknown. */
  loadedCommit: string | null;
  /** Repo HEAD at call time, or null if it could not be determined. */
  currentHead: string | null;
  /**
   * `loadedCommit === currentHead`. `true` = the loaded code is current.
   * `false` = a rebuild is pending (benign latency — see `0e39c87e`), NOT
   * necessarily a permanent staleness bug. `null` = indeterminate (either
   * commit unknown).
   */
  bundleFresh: boolean | null;
  /** How the launcher served this process. */
  runMode: RunMode;
  /** Human-readable reason when `bundleFresh` is null; null when determinate. */
  note: string | null;
}

/** Injectable seams so the pure logic can be unit-tested without git or a real env. */
export interface SourceFreshnessDeps {
  readEnv(name: string): string | undefined;
  /** Returns the trimmed HEAD sha, or null on any failure. */
  gitRevParseHead(cwd: string): string | null;
}

/** Module-local cache for the production git runner only (keyed by cwd). */
const gitHeadCache = new Map<string, { head: string | null; at: number }>();

function uncachedGitRevParseHead(cwd: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    const out = result.stdout?.trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

const defaultDeps: SourceFreshnessDeps = {
  readEnv: (name) => process.env[name],
  gitRevParseHead: (cwd) => {
    const now = Date.now();
    const cached = gitHeadCache.get(cwd);
    if (cached && now - cached.at < GIT_HEAD_CACHE_TTL_MS) {
      return cached.head;
    }
    const head = uncachedGitRevParseHead(cwd);
    gitHeadCache.set(cwd, { head, at: now });
    return head;
  },
};

function normalizeRunMode(raw: string | undefined): RunMode {
  return raw === "bundle" || raw === "source-fallback" ? raw : "unknown";
}

/**
 * Compute the loaded-source freshness snapshot. Pure aside from the injected
 * `gitRevParseHead` call; never throws (all failures degrade to null fields).
 *
 * Short-circuits the git call when `loadedCommit` is unknown (CLI / published
 * install / non-cli-entry launch): with no loaded commit to compare against,
 * `bundleFresh` is null regardless, so there is nothing to learn from HEAD and
 * no reason to spawn git (PR #1599 R1 — avoids the shellout on the CLI path).
 */
export function getSourceFreshness(deps: SourceFreshnessDeps = defaultDeps): SourceFreshness {
  const loadedCommitRaw = deps.readEnv(LOADED_COMMIT_ENV);
  const loadedCommit =
    loadedCommitRaw && loadedCommitRaw.trim().length > 0 ? loadedCommitRaw.trim() : null;

  const runMode = normalizeRunMode(deps.readEnv(RUN_MODE_ENV));

  // Only resolve current HEAD when there is a loaded commit to compare against.
  let currentHead: string | null = null;
  if (loadedCommit !== null) {
    const packageRoot = deps.readEnv(PACKAGE_ROOT_ENV);
    currentHead = packageRoot && packageRoot.length > 0 ? deps.gitRevParseHead(packageRoot) : null;
  }

  const bundleFresh =
    loadedCommit !== null && currentHead !== null ? loadedCommit === currentHead : null;

  let note: string | null = null;
  if (loadedCommit === null) {
    note =
      "loadedCommit unavailable — process was not launched via cli-entry (CLI / published " +
      "install) or the build stamp was missing; freshness not tracked";
  } else if (currentHead === null) {
    note = "currentHead unavailable — MINSKY_PACKAGE_ROOT unset or git rev-parse failed";
  }

  return { loadedCommit, currentHead, bundleFresh, runMode, note };
}
