/**
 * Slow-clock topology cache (mt#2602) — the impure PRODUCER half of the
 * derivation. Mirrors the `prod-state-cache.ts` (mt#2506) hybrid pattern:
 * a periodic refresh (driven by `startTopologySweeper` in server.ts) does the
 * expensive I/O (directory listing, a bounded `git log` subprocess, a
 * `retrospective.fired` DB query) once per cadence tick and writes a small
 * in-process cache; the `slow-topology` widget's `fetch()` reads ONLY that
 * cache — never spawning git or querying the DB per request.
 *
 * All actual derivation logic (registry dedupe, git-log parsing, retrospective
 * correlation) lives in the pure `topology-derivation.ts` module; this file is
 * only the I/O plumbing that feeds it real data and holds the result.
 *
 * @see mt#2602 — this task
 * @see src/cockpit/topology-derivation.ts — pure derivation functions
 * @see src/cockpit/prod-state-cache.ts — the sibling pattern this mirrors
 * @see src/cockpit/web-dist.ts — `findRepoRoot`, reused for repo-root resolution
 * @see src/cockpit/session-detail.ts — `githubRepoWebBase`, reused for commit URLs
 */
import * as fs from "fs";
import * as path from "path";
import { log } from "@minsky/shared/logger";
import { findRepoRoot } from "./web-dist";
import { githubRepoWebBase } from "./session-detail";
import {
  deriveHookRegistry,
  parseHookInstallLog,
  buildWeldEntries,
  isHookSourceFile,
  HOOK_INSTALL_GIT_LOG_ARGS,
  type WeldEntry,
  type HookFileListing,
  type RetrospectiveEventInput,
} from "./topology-derivation";

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------

export interface TopologySnapshot {
  entries: WeldEntry[];
  /** ISO-8601 timestamp of when this snapshot was computed. */
  computedAt: string;
}

let cached: TopologySnapshot | null = null;

/** Read the current cached snapshot. Returns null before the first successful refresh. */
export function getCachedTopology(): TopologySnapshot | null {
  return cached;
}

/** Test seam: reset the module-level cache between tests. */
export function resetTopologyCacheForTests(): void {
  cached = null;
}

/** Test seam: directly set the module-level cache, bypassing real I/O. */
export function setTopologyCacheForTests(snapshot: TopologySnapshot | null): void {
  cached = snapshot;
}

// ---------------------------------------------------------------------------
// Directory listing (bounded, fail-open to null)
// ---------------------------------------------------------------------------

/**
 * List hook source files in a directory, filtered with the exact same
 * `isHookSourceFile` predicate the pure derivation layer uses — so the I/O
 * boundary's `HookFileListing` is already source-only (R2 review finding,
 * mt#2602 PR #1786) rather than relying solely on downstream filtering.
 */
function listTsFiles(dir: string): string[] | null {
  try {
    if (!fs.existsSync(dir)) return null;
    return fs.readdirSync(dir).filter((f) => isHookSourceFile(f));
  } catch {
    return null;
  }
}

function buildHookFileListing(repoRoot: string): HookFileListing {
  return {
    claudeHooks: listTsFiles(path.join(repoRoot, ".claude", "hooks")),
    minskyHooks: listTsFiles(path.join(repoRoot, ".minsky", "hooks")),
  };
}

// ---------------------------------------------------------------------------
// Bounded git subprocesses — reads only, timeout + maxBuffer, fail to null.
// ---------------------------------------------------------------------------

const GIT_LOG_TIMEOUT_MS = 10_000;
const GIT_LOG_MAX_BUFFER = 4 * 1024 * 1024;
const GIT_REMOTE_TIMEOUT_MS = 3_000;

async function runHookInstallGitLog(repoRoot: string): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...HOOK_INSTALL_GIT_LOG_ARGS], {
      timeout: GIT_LOG_TIMEOUT_MS,
      maxBuffer: GIT_LOG_MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    log.debug("topology-cache: hook-install git log failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function readGitRemoteUrl(repoRoot: string): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "config", "--get", "remote.origin.url"],
      { timeout: GIT_REMOTE_TIMEOUT_MS, maxBuffer: 64 * 1024 }
    );
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// retrospective.fired events — best-effort DB read (fail-open to empty list)
// ---------------------------------------------------------------------------

const RETROSPECTIVE_FETCH_LIMIT = 500;

let _cachedTopologyDb: import("drizzle-orm/postgres-js").PostgresJsDatabase | null = null;

async function getTopologyDb(): Promise<
  import("drizzle-orm/postgres-js").PostgresJsDatabase | null
> {
  if (_cachedTopologyDb) return _cachedTopologyDb;
  try {
    const { getSharedPersistenceService } = await import("./shared-persistence");
    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();
    if (
      !("getDatabaseConnection" in provider) ||
      typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
    ) {
      return null;
    }
    const sqlProvider = provider as {
      getDatabaseConnection: () => Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase>;
    };
    _cachedTopologyDb = await sqlProvider.getDatabaseConnection();
    return _cachedTopologyDb;
  } catch {
    return null;
  }
}

async function fetchRetrospectiveEvents(): Promise<RetrospectiveEventInput[]> {
  try {
    const db = await getTopologyDb();
    if (!db) return [];
    const { listEvents } = await import("@minsky/domain/events/query");
    const events = await listEvents(db, {
      eventType: "retrospective.fired",
      limit: RETROSPECTIVE_FETCH_LIMIT,
    });
    return events.map((e) => ({ id: e.id, createdAt: e.createdAt, payload: e.payload }));
  } catch (err) {
    log.debug("topology-cache: retrospective.fired fetch failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Refresh orchestration
// ---------------------------------------------------------------------------

/**
 * Recompute the topology snapshot from real I/O and write it to the
 * in-process cache. Fail-open at every step (missing repo root, unreadable
 * hook dirs, failed git subprocess, unreachable DB) — a partial failure still
 * produces the best snapshot derivable from whatever succeeded, with honest
 * `null` fields for what didn't (per `topology-derivation.ts`'s discipline).
 *
 * Returns true if a snapshot was written, false if the whole refresh failed
 * (leaving the last-good cache, if any, in place).
 */
export async function refreshTopologyCache(
  nowIso: string = new Date().toISOString()
): Promise<boolean> {
  try {
    const repoRoot = findRepoRoot([process.cwd()]) ?? process.cwd();

    const [gitLogOutput, repoUrl, retrospectives] = await Promise.all([
      runHookInstallGitLog(repoRoot),
      readGitRemoteUrl(repoRoot),
      fetchRetrospectiveEvents(),
    ]);

    const listing = buildHookFileListing(repoRoot);
    const registry = deriveHookRegistry(listing);
    const installMap = gitLogOutput ? parseHookInstallLog(gitLogOutput) : new Map();
    const repoWebBase = githubRepoWebBase(repoUrl);
    const entries = buildWeldEntries(registry, installMap, retrospectives, repoWebBase);

    cached = { entries, computedAt: nowIso };
    return true;
  } catch (err) {
    log.warn("topology-cache: refresh failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
