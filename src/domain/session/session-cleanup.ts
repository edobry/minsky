/**
 * Session Cleanup Domain Logic
 *
 * Identifies and removes stale/orphaned sessions via `deriveSessionLiveness`.
 * Completes the session lifecycle: create → track → clean.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import type { SessionProviderInterface, SessionRecord, SessionLiveness } from "./types";
import { deriveSessionLiveness, SessionStatus } from "./types";
import { getSessionsDir } from "../../utils/paths";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors";
import type { GitServiceInterface } from "../git/types";

export interface CleanupCandidate {
  session: SessionRecord;
  reason: "stale" | "orphaned" | "older-than";
  liveness: SessionLiveness;
}

export interface CleanupSkipped {
  session: SessionRecord;
  reason: string;
}

export interface IdentifyCleanupCandidatesOptions {
  includeStale?: boolean;
  includeOrphaned?: boolean;
  olderThanMs?: number;
}

/**
 * Parse a duration string like "7d", "24h", "30m", "60s", "1500ms", "2w"
 * into milliseconds. Returns null if the string cannot be parsed.
 */
export function parseDuration(str: string): number | null {
  const match = str.match(/^(\d+)(ms|s|m|h|d|w)$/);
  if (!match || !match[1] || !match[2]) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2] as "ms" | "s" | "m" | "h" | "d" | "w";
  const multipliers: Record<typeof unit, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return value * multipliers[unit];
}

/**
 * Determine whether a session directory exists on the local filesystem.
 */
function sessionDirExists(sessionId: string): boolean {
  const dir = `${getSessionsDir()}/${sessionId}`;
  return existsSync(dir);
}

/**
 * Check whether the session's local workspace has uncommitted changes.
 * Returns false (safe to delete) if the directory doesn't exist.
 * Returns true (has changes, skip) if git status output is non-empty.
 */
export async function sessionHasUncommittedChanges(
  sessionId: string,
  gitService?: GitServiceInterface
): Promise<boolean> {
  if (!gitService) return false;

  const dir = `${getSessionsDir()}/${sessionId}`;
  if (!existsSync(dir)) return false;

  try {
    const output = await gitService.execInRepository(dir, "status --porcelain");
    return output.trim().length > 0;
  } catch (error) {
    // If we can't determine status (e.g., not a git repo), assume safe
    log.debug(`Could not check git status for session '${sessionId}': ${getErrorMessage(error)}`);
    return false;
  }
}

/**
 * Identify sessions that are candidates for cleanup based on the given options.
 *
 * Safety invariants enforced here (before any deletion):
 * - MERGED sessions are never included (terminal state, preserve data)
 * - CLOSED sessions are never included (already closed)
 * - If no filter flags are given, defaults to includeStale + includeOrphaned
 *
 * Note: uncommitted-changes check is NOT done here — it's a per-candidate
 * check in the command layer (requires gitService and is expensive).
 */
export async function identifyCleanupCandidates(
  sessionProvider: SessionProviderInterface,
  options: IdentifyCleanupCandidatesOptions
): Promise<CleanupCandidate[]> {
  // Default: if no flags set, include both stale + orphaned
  const { includeStale, includeOrphaned, olderThanMs } = options;
  const defaultMode = !includeStale && !includeOrphaned && olderThanMs === undefined;
  const effectiveStale = defaultMode ? true : (includeStale ?? false);
  const effectiveOrphaned = defaultMode ? true : (includeOrphaned ?? false);

  const sessions = await sessionProvider.listSessions();
  const candidates: CleanupCandidate[] = [];

  for (const session of sessions) {
    // Safety: never clean up MERGED or CLOSED sessions
    if (session.status === SessionStatus.MERGED) continue;
    if (session.status === SessionStatus.CLOSED) continue;

    const liveness = deriveSessionLiveness(session);

    // Stale check
    if (effectiveStale && liveness === "stale") {
      candidates.push({ session, reason: "stale", liveness });
      continue;
    }

    // Orphaned check: no local dir AND status indicates it's not actively tracked
    if (effectiveOrphaned && !sessionDirExists(session.sessionId)) {
      candidates.push({ session, reason: "orphaned", liveness });
      continue;
    }

    // olderThan check
    if (olderThanMs !== undefined) {
      const activityTime = session.lastActivityAt || session.createdAt;
      if (activityTime) {
        const elapsed = Date.now() - new Date(activityTime).getTime();
        if (elapsed > olderThanMs) {
          candidates.push({ session, reason: "older-than", liveness });
        }
      }
    }
  }

  return candidates;
}

/**
 * A workspace directory under getSessionsDir() that has no matching DB record.
 * This is the mt#1941 failure mode: the DB record was deleted (by a concurrent
 * applyPostMergeStateSync or deleteSession call) but the workspace dir remained
 * on disk. session_cleanup --orphaned must detect these as well as the traditional
 * "DB record exists, dir missing" orphans.
 */
export interface FilesystemOrphanDir {
  /** UUID / dirname under getSessionsDir(). */
  sessionId: string;
  /** Absolute path to the directory. */
  dirPath: string;
}

/**
 * Scan getSessionsDir() for workspace directories that have no matching session
 * record in the DB.
 *
 * Background (mt#1941): the standard "orphaned" check in identifyCleanupCandidates
 * detects sessions WHERE the DB record exists but the local dir is missing.
 * This function detects the INVERSE: dirs on disk with NO DB record. This occurs
 * when applyPostMergeStateSync is called twice concurrently (webhook + session_pr_merge):
 * the first call deletes the DB record AND the dir; the second call finds no DB record
 * and (pre-fix) did not clean up the dir. The result is a dir on disk with nothing in
 * the DB to reference it — standard session_cleanup misses it entirely.
 *
 * Only top-level directory entries under getSessionsDir() are inspected. Entries
 * that are not directories are skipped. Entries that correspond to an existing DB
 * session record are skipped.
 *
 * Returns an empty array if getSessionsDir() does not exist or cannot be read.
 */
export async function identifyFilesystemOrphanDirs(
  sessionProvider: SessionProviderInterface
): Promise<FilesystemOrphanDir[]> {
  const sessionsDir = getSessionsDir();
  if (!existsSync(sessionsDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch (err) {
    log.debug(
      `identifyFilesystemOrphanDirs: could not read sessions dir ${sessionsDir}: ${getErrorMessage(err)}`
    );
    return [];
  }

  // Build a set of all known session IDs from the DB for O(1) lookup.
  const allSessions = await sessionProvider.listSessions();
  const knownIds = new Set(allSessions.map((s) => s.sessionId));

  const orphans: FilesystemOrphanDir[] = [];
  for (const entry of entries) {
    const dirPath = `${sessionsDir}/${entry}`;
    // Only consider directories (skip files like .gitkeep, etc.)
    let isDir: boolean;
    try {
      isDir = statSync(dirPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    // If the DB has a record for this sessionId, it is not a filesystem orphan.
    if (knownIds.has(entry)) continue;

    orphans.push({ sessionId: entry, dirPath });
  }

  return orphans;
}
