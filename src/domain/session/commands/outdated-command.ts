import { z } from "zod";
import { createSessionProvider } from "../../session";
import { Session, SessionProviderInterface, SessionRecord, SyncSeverity } from "../types";
import { GitService } from "../../git";
import { computeSyncStatus, formatSyncStatus, generateSyncSummary } from "../sync-status-service";
import { log } from "../../../utils/logger";

/**
 * Parameters for the session outdated command
 * TASK 360: Command to list all outdated sessions
 */
export interface SessionOutdatedParameters {
  severity?: SyncSeverity;
  sort?: "commits" | "days";
  json?: boolean;
  verbose?: boolean;
}

/**
 * Result interface for session outdated command
 */
export interface SessionOutdatedResult {
  outdatedSessions: SessionOutdatedInfo[];
  summary: {
    total: number;
    upToDate: number;
    stale: number;
    veryStale: number;
    ancient: number;
  };
}

/**
 * Outdated session information for display
 */
export interface SessionOutdatedInfo {
  session: string;
  taskId?: string;
  repoName?: string;
  branch?: string;
  syncStatus: {
    isOutdated: boolean;
    commitsBehind: number;
    daysBehind: number;
    severity: SyncSeverity;
    lastMainCommit: string;
    lastMainCommitDate: Date;
    sessionLastUpdate: Date;
  };
}

/**
 * Gets list of outdated sessions based on parameters
 * TASK 360: Implementation of session outdated command
 */
export async function sessionOutdated(
  params: SessionOutdatedParameters,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitService;
  }
): Promise<SessionOutdatedResult> {
  const { severity, sort = "commits", json = false, verbose = false } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || new GitService(),
  };

  try {
    // Get all sessions
    const allSessions = await deps.sessionDB.listSessions();

    // Compute sync status for all sessions and filter outdated ones
    const outdatedSessions: SessionOutdatedInfo[] = [];

    for (const sessionRecord of allSessions) {
      try {
        const syncStatusInfo = await computeSyncStatus(
          sessionRecord.session,
          sessionRecord,
          deps.gitService
        );

        if (syncStatusInfo.isOutdated) {
          // Apply severity filter if specified
          if (severity && syncStatusInfo.severity !== severity) {
            continue;
          }

          outdatedSessions.push({
            session: sessionRecord.session,
            taskId: sessionRecord.taskId,
            repoName: sessionRecord.repoName,
            branch: sessionRecord.branch,
            syncStatus: syncStatusInfo,
          });
        }
      } catch (error) {
        // Skip sessions where sync status computation fails
        if (verbose) {
          console.warn(
            `Failed to compute sync status for session ${sessionRecord.session}:`,
            error
          );
        }
      }
    }

    // Sort sessions based on specified criteria
    outdatedSessions.sort((a, b) => {
      if (sort === "commits") {
        return b.syncStatus.commitsBehind - a.syncStatus.commitsBehind;
      } else if (sort === "days") {
        return b.syncStatus.daysBehind - a.syncStatus.daysBehind;
      }
      return 0;
    });

    // Generate summary
    const summary = generateSyncSummary(allSessions);

    return {
      outdatedSessions,
      summary,
    };
  } catch (error) {
    throw new Error(
      `Failed to list outdated sessions: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Format outdated sessions result for CLI display
 * TASK 360: CLI formatter for session outdated command
 */
export function formatOutdatedSessionsResult(result: SessionOutdatedResult): void {
  const { outdatedSessions, summary } = result;

  if (outdatedSessions.length === 0) {
    log.cli("✅ All sessions are up to date!");
    log.cli("");
    log.cli(`Total sessions: ${summary.total}`);
    return;
  }

  // Header
  log.cli(`Outdated Sessions (${outdatedSessions.length} found):`);
  log.cli("");

  // List outdated sessions
  outdatedSessions.forEach((sessionInfo) => {
    const { session, taskId, syncStatus } = sessionInfo;
    const severityIcon = getSeverityIcon(syncStatus.severity);
    const taskDisplay = taskId ? ` (Task #${taskId})` : "";
    const commitsSuffix = syncStatus.commitsBehind === 1 ? "commit" : "commits";
    const daysSuffix = syncStatus.daysBehind === 1 ? "day" : "days";

    log.cli(`${severityIcon} ${session}${taskDisplay} [${syncStatus.severity.toUpperCase()}]`);
    log.cli(
      `   └─ ${syncStatus.commitsBehind} ${commitsSuffix} behind, ${syncStatus.daysBehind} ${daysSuffix} old`
    );
  });

  log.cli("");

  // Summary
  log.cli("Summary:");
  log.cli(`✅ Up to date: ${summary.upToDate} sessions`);
  if (summary.stale > 0) {
    log.cli(`🟡 Stale (3-7 days): ${summary.stale} sessions`);
  }
  if (summary.veryStale > 0) {
    log.cli(`🟠 Very stale (7-14 days): ${summary.veryStale} sessions`);
  }
  if (summary.ancient > 0) {
    log.cli(`🔴 Ancient (14+ days): ${summary.ancient} sessions`);
  }

  log.cli("");
  log.cli("💡 Use 'minsky session get <session-name>' for details");
  log.cli("💡 Use 'minsky session sync <session-name>' to update a session");
}

/**
 * Get severity icon for outdated session display
 */
function getSeverityIcon(severity: SyncSeverity): string {
  switch (severity) {
    case "ancient":
      return "🔴";
    case "very-stale":
      return "🟠";
    case "stale":
      return "🟡";
    default:
      return "⚠️";
  }
}
