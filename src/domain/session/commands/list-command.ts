import type { SessionListParameters } from "../../../domain/schemas";
import { createSessionProvider } from "../../session";
import { Session, SessionProviderInterface, SessionDependencies, SessionRecord } from "../types";
import { GitService } from "../../git";
import { computeSyncStatus, formatSyncStatus } from "../sync-status-service";

/**
 * Enhanced session with sync status information for display
 * TASK 360: Extended session data for list command with sync status
 */
export interface SessionWithSyncStatus extends Session {
  syncStatusDisplay?: string;
}

/**
 * Lists all sessions based on parameters
 * Using proper dependency injection for better testability
 * TASK 360: Enhanced with optional sync status computation
 */
export async function sessionList(
  params: SessionListParameters & { showSyncStatus?: boolean },
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitService;
  }
): Promise<SessionWithSyncStatus[]> {
  const { showSyncStatus = false } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || new GitService(),
  };

  const sessions = await deps.sessionDB.listSessions();

  // If sync status display is not requested, return sessions as-is
  if (!showSyncStatus) {
    return sessions;
  }

  // Compute sync status for each session
  const sessionsWithStatus: SessionWithSyncStatus[] = [];

  for (const session of sessions) {
    try {
      const syncStatusInfo = await computeSyncStatus(session.session, session, deps.gitService);

      const syncStatusDisplay = formatSyncStatus(syncStatusInfo);

      sessionsWithStatus.push({
        ...session,
        syncStatusDisplay,
      });
    } catch (error) {
      // If sync status computation fails, include session without status
      sessionsWithStatus.push({
        ...session,
        syncStatusDisplay: "❓ status unknown",
      });
    }
  }

  return sessionsWithStatus;
}
