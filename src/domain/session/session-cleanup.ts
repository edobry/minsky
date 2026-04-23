/**
 * Session Cleanup Domain Logic
 *
 * Identifies and removes stale/orphaned sessions via `deriveSessionLiveness`.
 * Completes the session lifecycle: create → track → clean.
 */
import { existsSync } from "node:fs";
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
    if (effectiveOrphaned && !sessionDirExists(session.session)) {
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
