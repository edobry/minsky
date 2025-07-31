import { GitServiceInterface, GitCommit } from "../git";
import { SessionRecord, SyncStatusInfo, SyncSeverity, SyncStatus } from "./types";

/**
 * Sync status service for session outdated detection
 * TASK 360: Service for computing session sync status and detecting outdated sessions
 */

// Severity thresholds in days
export const STALE_THRESHOLD_DAYS = 3;
export const VERY_STALE_THRESHOLD_DAYS = 7;
export const ANCIENT_THRESHOLD_DAYS = 14;

/**
 * Compute severity level based on days behind and outdated status
 */
export function computeSeverity(daysBehind: number, isOutdated: boolean): SyncSeverity {
  if (!isOutdated) return "current";

  if (daysBehind >= ANCIENT_THRESHOLD_DAYS) return "ancient";
  if (daysBehind >= VERY_STALE_THRESHOLD_DAYS) return "very-stale";
  if (daysBehind >= STALE_THRESHOLD_DAYS) return "stale";

  return "current";
}

/**
 * Compute basic timestamp-based sync status for a session
 */
export async function computeSyncStatus(
  sessionId: string,
  sessionRecord: SessionRecord,
  gitService: GitServiceInterface
): Promise<SyncStatusInfo> {
  // Get repository path for the session
  const repoPath = await getSessionRepoPath(sessionRecord);

  // Get latest main commit
  const latestMainCommit = await gitService.getLatestMainCommit(repoPath);
  const latestMainDate = latestMainCommit.date;

  // Compare with session's last update
  const sessionLastUpdate =
    sessionRecord.syncStatus?.lastUpdateTimestamp || new Date(sessionRecord.createdAt);

  const isOutdated = latestMainDate > sessionLastUpdate;
  const daysBehind = Math.floor((Date.now() - sessionLastUpdate.getTime()) / (1000 * 60 * 60 * 24));

  // Get commit count if outdated
  let commitsBehind = 0;
  if (isOutdated) {
    try {
      const sessionBranch = sessionRecord.branch || `session/${sessionRecord.session}`;
      const mainBranch = await gitService.getMainBranch(repoPath);
      const mergeBase = await gitService.getMergeBase(repoPath, sessionBranch, mainBranch);
      commitsBehind = await gitService.getCommitCount(repoPath, `${mergeBase}..${mainBranch}`);
    } catch (error) {
      // Fallback to timestamp-based estimation if git operations fail
      const commitsSince = await gitService.getCommitsSince(repoPath, sessionLastUpdate);
      commitsBehind = commitsSince.length;
    }
  }

  return {
    isOutdated,
    commitsBehind,
    lastMainCommit: latestMainCommit.hash,
    lastMainCommitDate: latestMainDate,
    sessionLastUpdate,
    daysBehind,
    severity: computeSeverity(daysBehind, isOutdated),
  };
}

/**
 * Compute detailed commit-based sync status for a session
 */
export async function computeDetailedSyncStatus(
  sessionId: string,
  sessionRecord: SessionRecord,
  gitService: GitServiceInterface
): Promise<SyncStatusInfo> {
  const repoPath = await getSessionRepoPath(sessionRecord);
  const sessionBranch = sessionRecord.branch || `session/${sessionRecord.session}`;
  const mainBranch = await gitService.getMainBranch(repoPath);

  // Get merge base and check if main has moved ahead
  const mergeBase = await gitService.getMergeBase(repoPath, sessionBranch, mainBranch);
  const latestMainCommit = await gitService.getLatestMainCommit(repoPath);

  const isOutdated = mergeBase !== latestMainCommit.hash;
  const commitsBehind = isOutdated
    ? await gitService.getCommitCount(repoPath, `${mergeBase}..${mainBranch}`)
    : 0;

  const daysBehind = Math.floor(
    (Date.now() - latestMainCommit.timestamp * 1000) / (1000 * 60 * 60 * 24)
  );

  return {
    isOutdated,
    commitsBehind,
    lastMainCommit: latestMainCommit.hash,
    lastMainCommitDate: latestMainCommit.date,
    sessionLastUpdate: new Date(sessionRecord.createdAt),
    daysBehind,
    severity: computeSeverity(commitsBehind, isOutdated),
  };
}

/**
 * Get repository path for a session record
 */
async function getSessionRepoPath(sessionRecord: SessionRecord): Promise<string> {
  // This is a simplified implementation - in a real system this would
  // use the SessionProviderInterface.getRepoPath method
  if (sessionRecord.backendType === "local") {
    return sessionRecord.repoUrl;
  }

  // For remote/GitHub repositories, construct the local path
  // This matches the session workspace structure used by GitService
  const { getMinskyStateDir } = await import("../../utils/paths");
  const { join } = await import("node:path");

  return join(getMinskyStateDir(), "sessions", sessionRecord.session);
}

/**
 * Format sync status information for display
 */
export function formatSyncStatus(syncStatus: SyncStatusInfo): string {
  if (!syncStatus.isOutdated) {
    return "✅ up to date";
  }

  const daysSuffix = syncStatus.daysBehind === 1 ? "day" : "days";
  const commitsSuffix = syncStatus.commitsBehind === 1 ? "commit" : "commits";

  switch (syncStatus.severity) {
    case "ancient":
      return `🔴 ${syncStatus.commitsBehind} ${commitsSuffix} behind (${syncStatus.daysBehind} ${daysSuffix} old, ancient)`;
    case "very-stale":
      return `🟠 ${syncStatus.commitsBehind} ${commitsSuffix} behind (${syncStatus.daysBehind} ${daysSuffix} old, very stale)`;
    case "stale":
      return `🟡 ${syncStatus.commitsBehind} ${commitsSuffix} behind (${syncStatus.daysBehind} ${daysSuffix} old, stale)`;
    default:
      return `⚠️ ${syncStatus.commitsBehind} ${commitsSuffix} behind (${syncStatus.daysBehind} ${daysSuffix} old)`;
  }
}

/**
 * Get recent main changes for display
 */
export async function getRecentMainChanges(
  sessionRecord: SessionRecord,
  gitService: GitServiceInterface,
  limit: number = 3
): Promise<GitCommit[]> {
  const repoPath = await getSessionRepoPath(sessionRecord);
  const sessionLastUpdate =
    sessionRecord.syncStatus?.lastUpdateTimestamp || new Date(sessionRecord.createdAt);

  const recentCommits = await gitService.getCommitsSince(repoPath, sessionLastUpdate);
  return recentCommits.slice(0, limit);
}

/**
 * Summary of sync status across all sessions
 */
export interface SyncSummary {
  upToDate: number;
  stale: number;
  veryStale: number;
  ancient: number;
  total: number;
}

/**
 * Generate sync summary from session records
 */
export function generateSyncSummary(sessions: SessionRecord[]): SyncSummary {
  const summary: SyncSummary = {
    upToDate: 0,
    stale: 0,
    veryStale: 0,
    ancient: 0,
    total: sessions.length,
  };

  for (const session of sessions) {
    const severity = session.syncStatus?.isOutdated
      ? computeSeverity(
          Math.floor(
            (Date.now() - (session.syncStatus.lastUpdateTimestamp?.getTime() || 0)) /
              (1000 * 60 * 60 * 24)
          ),
          session.syncStatus.isOutdated
        )
      : "current";

    switch (severity) {
      case "current":
        summary.upToDate++;
        break;
      case "stale":
        summary.stale++;
        break;
      case "very-stale":
        summary.veryStale++;
        break;
      case "ancient":
        summary.ancient++;
        break;
    }
  }

  return summary;
}
