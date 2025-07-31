import { createSessionProvider } from "../../session";
import { Session, SessionProviderInterface, SessionRecord, SyncSeverity } from "../types";
import { GitService } from "../../git";
import { computeSyncStatus, generateSyncSummary, SyncSummary } from "../sync-status-service";
import { log } from "../../../utils/logger";

/**
 * Parameters for the session check-sync command
 * TASK 360: Command to check sync status for all sessions
 */
export interface SessionCheckSyncParameters {
  updateCache?: boolean;
  verbose?: boolean;
  json?: boolean;
}

/**
 * Result interface for session check-sync command
 */
export interface SessionCheckSyncResult {
  checkedSessions: {
    session: string;
    syncStatus: "up-to-date" | "outdated" | "error";
    severity?: SyncSeverity;
    commitsBehind?: number;
    daysBehind?: number;
    error?: string;
  }[];
  summary: SyncSummary;
  totalChecked: number;
  errors: number;
}

/**
 * Checks sync status for all sessions
 * TASK 360: Implementation of session check-sync command
 */
export async function sessionCheckSync(
  params: SessionCheckSyncParameters,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitService;
  }
): Promise<SessionCheckSyncResult> {
  const { updateCache = false, verbose = false, json = false } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || new GitService(),
  };

  try {
    // Get all sessions
    const allSessions = await deps.sessionDB.listSessions();

    const checkedSessions: SessionCheckSyncResult["checkedSessions"] = [];
    let errors = 0;

    for (const sessionRecord of allSessions) {
      try {
        const syncStatusInfo = await computeSyncStatus(
          sessionRecord.session,
          sessionRecord,
          deps.gitService
        );

        // Update cache if requested
        if (updateCache) {
          try {
            await deps.sessionDB.updateSyncStatus(sessionRecord.session, syncStatusInfo);
          } catch (cacheError) {
            if (verbose) {
              console.warn(
                `Failed to update cache for session ${sessionRecord.session}:`,
                cacheError
              );
            }
          }
        }

        checkedSessions.push({
          session: sessionRecord.session,
          syncStatus: syncStatusInfo.isOutdated ? "outdated" : "up-to-date",
          severity: syncStatusInfo.severity,
          commitsBehind: syncStatusInfo.commitsBehind,
          daysBehind: syncStatusInfo.daysBehind,
        });
      } catch (error) {
        errors++;
        const errorMessage = error instanceof Error ? error.message : String(error);

        checkedSessions.push({
          session: sessionRecord.session,
          syncStatus: "error",
          error: errorMessage,
        });

        if (verbose) {
          console.warn(`Failed to check sync status for session ${sessionRecord.session}:`, error);
        }
      }
    }

    // Generate summary
    const summary = generateSyncSummary(allSessions);

    return {
      checkedSessions,
      summary,
      totalChecked: allSessions.length,
      errors,
    };
  } catch (error) {
    throw new Error(
      `Failed to check sync status: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Format check-sync results for CLI display
 * TASK 360: CLI formatter for session check-sync command
 */
export function formatCheckSyncResult(
  result: SessionCheckSyncResult,
  verbose: boolean = false
): void {
  const { checkedSessions, summary, totalChecked, errors } = result;

  // Header
  log.cli(`Session Sync Status Check (${totalChecked} sessions checked):`);
  log.cli("");

  // Show errors if any
  if (errors > 0) {
    log.cli(`⚠️  ${errors} sessions had errors during sync check`);
    log.cli("");
  }

  // List checked sessions in verbose mode
  if (verbose) {
    log.cli("Individual Session Status:");
    checkedSessions.forEach((sessionInfo) => {
      const { session, syncStatus, severity, commitsBehind, daysBehind, error } = sessionInfo;

      if (syncStatus === "error") {
        log.cli(`❌ ${session} - Error: ${error || "Unknown error"}`);
      } else if (syncStatus === "up-to-date") {
        log.cli(`✅ ${session} - Up to date`);
      } else {
        const severityIcon = getSeverityIcon(severity || "current");
        const commitsSuffix = (commitsBehind || 0) === 1 ? "commit" : "commits";
        const daysSuffix = (daysBehind || 0) === 1 ? "day" : "days";
        log.cli(
          `${severityIcon} ${session} - ${commitsBehind || 0} ${commitsSuffix} behind, ${daysBehind || 0} ${daysSuffix} old [${(severity || "unknown").toUpperCase()}]`
        );
      }
    });
    log.cli("");
  }

  // Summary
  log.cli("Overall Summary:");
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
  if (errors > 0) {
    log.cli(`❌ Errors: ${errors} sessions`);
  }

  log.cli("");

  if (summary.upToDate === summary.total && errors === 0) {
    log.cli("🎉 All sessions are up to date!");
  } else {
    log.cli("💡 Use 'minsky session outdated' for detailed outdated session list");
    log.cli("💡 Use 'minsky session get <session-name>' for individual session details");
  }
}

/**
 * Get severity icon for sync status display
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

/**
 * Parameters for the session sync-summary command
 * TASK 360: Command to show sync summary
 */
export interface SessionSyncSummaryParameters {
  json?: boolean;
}

/**
 * Gets sync summary for all sessions
 * TASK 360: Implementation of session sync-summary command
 */
export async function sessionSyncSummary(
  params: SessionSyncSummaryParameters,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<SyncSummary> {
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  const allSessions = await deps.sessionDB.listSessions();
  return generateSyncSummary(allSessions);
}

/**
 * Format sync summary for CLI display
 * TASK 360: CLI formatter for session sync-summary command
 */
export function formatSyncSummary(summary: SyncSummary): void {
  log.cli("Session Sync Summary:");
  log.cli("");

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
  log.cli(`Total sessions: ${summary.total}`);
  log.cli("");

  if (summary.upToDate === summary.total) {
    log.cli("🎉 All sessions are up to date!");
  } else {
    log.cli("💡 Use 'minsky session outdated' for detailed list");
  }
}
