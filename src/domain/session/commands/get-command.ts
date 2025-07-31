import type { SessionGetParameters } from "../../../domain/schemas";
import { createSessionProvider } from "../../session";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { Session, SessionProviderInterface, SessionDependencies, SessionRecord } from "../types";
import { ResourceNotFoundError, ValidationError } from "../../errors/index";
import { GitService } from "../../git";
import { computeSyncStatus, getRecentMainChanges } from "../sync-status-service";

/**
 * Gets session details based on parameters
 * Using proper dependency injection for better testability
 * Now includes auto-detection capabilities via unified session context resolver
 * TASK 360: Enhanced with sync status computation for outdated session detection
 */
export async function sessionGet(
  params: SessionGetParameters,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitService;
  }
): Promise<Session | null> {
  const { name, task, repo } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || new GitService(),
  };

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: task,
      repo: repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: true,
    });

    // Get the session details using the resolved session name
    const sessionRecord = await deps.sessionDB.getSession(resolvedContext.sessionName);
    if (!sessionRecord) return null;

    // TASK 360: Compute sync status information
    const sessionWithSyncStatus = await enhanceSessionWithSyncStatus(
      sessionRecord,
      deps.gitService
    );

    return sessionWithSyncStatus;
  } catch (error) {
    // If error is about missing session requirements, provide better user guidance
    if (error instanceof ValidationError) {
      throw new ResourceNotFoundError(
        "No session detected. Please provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }
}

/**
 * Enhance session record with computed sync status information
 * TASK 360: Add sync status computation to session get results
 */
async function enhanceSessionWithSyncStatus(
  sessionRecord: SessionRecord,
  gitService: GitService
): Promise<Session> {
  try {
    // Compute sync status
    const syncStatusInfo = await computeSyncStatus(
      sessionRecord.session,
      sessionRecord,
      gitService
    );

    // Get recent main changes if session is outdated
    let recentChanges;
    if (syncStatusInfo.isOutdated) {
      recentChanges = await getRecentMainChanges(sessionRecord, gitService, 3);
    }

    // Create enhanced session object with sync status
    const enhancedSession: Session = {
      ...sessionRecord,
      syncStatus: {
        ...syncStatusInfo,
        recentChanges,
      },
    };

    return enhancedSession;
  } catch (error) {
    // If sync status computation fails, return session without sync status
    // This ensures the command still works even if git operations fail
    console.warn(`Failed to compute sync status for session ${sessionRecord.session}:`, error);
    return sessionRecord;
  }
}
