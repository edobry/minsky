import { log } from "../../utils/logger";
import type { SessionProviderInterface, SessionRecord } from "./types";
import type { SessionListOptions } from "./types";
import { attemptSessionAutoRepair } from "./session-auto-repair";
import { createGitService } from "../git";
import { getMinskyStateDir } from "../../utils/paths";
import { join } from "path";
import { isUuidSessionId } from "../tasks/task-id";

/**
 * Auto-repair wrapper for SessionProviderInterface
 *
 * This wrapper intercepts all session lookup operations and attempts auto-repair
 * when sessions are not found in the database but might exist as workspace directories.
 *
 * It provides universal auto-repair functionality that works with any session operation
 * from both CLI and MCP interfaces.
 */
export class SessionAutoRepairProvider implements SessionProviderInterface {
  private baseProvider: SessionProviderInterface;
  private autoRepairAttempted = new Set<string>(); // Cache to prevent infinite loops

  constructor(baseProvider: SessionProviderInterface) {
    log.debug("SessionAutoRepairProvider constructor called");
    this.baseProvider = baseProvider;
  }

  async listSessions(options?: SessionListOptions): Promise<SessionRecord[]> {
    return this.baseProvider.listSessions(options);
  }

  async getSession(session: string): Promise<SessionRecord | null> {
    // First try the base provider
    let sessionRecord = await this.baseProvider.getSession(session);

    if (!sessionRecord && !this.autoRepairAttempted.has(session)) {
      log.debug("Session not found in database, attempting auto-repair", { session });

      // Mark as attempted to prevent loops
      this.autoRepairAttempted.add(session);

      try {
        // Attempt auto-repair by session ID - try to reverse-engineer a task ID
        let taskIdFromSessionId: string | undefined;

        // UUID session IDs don't encode task IDs — look up from DB by listing all sessions
        if (isUuidSessionId(session)) {
          log.debug("Session ID is UUID format, attempting DB lookup for task ID", { session });
          // Try to find the session record by listing all sessions and matching by session ID
          // This handles the case where the session exists in DB but lookup failed
          const allSessions = await this.baseProvider.listSessions();
          const matchedSession = allSessions.find((s) => s.sessionId === session);
          if (matchedSession?.taskId) {
            taskIdFromSessionId = matchedSession.taskId;
            log.debug("Found task ID from session listing", {
              session,
              taskId: taskIdFromSessionId,
            });
          }
        } else if (session.match(/^task-?md#(.+)$/)) {
          // Look for common patterns: task<id>, task#<id>, task-md#<id>
          taskIdFromSessionId = session.replace(/^task-?md#/, "md#");
        } else if (session.match(/^task#(.+)$/)) {
          taskIdFromSessionId = session.replace(/^task#/, "md#");
        } else if (session.match(/^task(\d+)$/)) {
          taskIdFromSessionId = session.replace(/^task/, "md#");
        }

        if (taskIdFromSessionId) {
          log.debug("Attempting auto-repair with inferred task ID", {
            session,
            inferredTaskId: taskIdFromSessionId,
          });

          const autoRepairDeps = {
            sessionDB: this.baseProvider, // Use base provider to avoid recursion
            gitService: createGitService(),
            getSessionsBaseDir: () => join(getMinskyStateDir(), "sessions"),
          };

          sessionRecord = await attemptSessionAutoRepair(taskIdFromSessionId, autoRepairDeps);

          if (sessionRecord) {
            log.debug("Auto-repair successful for session lookup", {
              session,
              repairedSession: sessionRecord.sessionId,
            });
          }
        }
      } catch (error) {
        log.debug("Auto-repair failed for session lookup", {
          session,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return sessionRecord;
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    log.debug("SessionAutoRepairProvider.getSessionByTaskId called", { taskId });

    // First try the base provider
    let sessionRecord = await this.baseProvider.getSessionByTaskId(taskId);
    log.debug("Base provider lookup result", {
      taskId,
      found: sessionRecord !== null,
      sessionId: sessionRecord?.sessionId,
    });

    if (!sessionRecord && !this.autoRepairAttempted.has(`task:${taskId}`)) {
      log.info("Session not found in database, attempting auto-repair", { taskId });

      // Mark as attempted to prevent loops
      this.autoRepairAttempted.add(`task:${taskId}`);

      try {
        const autoRepairDeps = {
          sessionDB: this.baseProvider, // Use base provider to avoid recursion
          gitService: createGitService(),
          getSessionsBaseDir: () => join(getMinskyStateDir(), "sessions"),
        };

        sessionRecord = await attemptSessionAutoRepair(taskId, autoRepairDeps);

        if (sessionRecord) {
          log.info("Auto-repair successful - session reconstructed from workspace", {
            taskId,
            repairedSession: sessionRecord.sessionId,
          });
        } else {
          log.debug("Auto-repair failed - no session could be reconstructed", { taskId });
        }
      } catch (error) {
        log.warn("Auto-repair failed with error", {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (this.autoRepairAttempted.has(`task:${taskId}`)) {
      log.debug("Auto-repair already attempted for this task", { taskId });
    }

    return sessionRecord;
  }

  // All other methods delegate directly to base provider
  async addSession(record: SessionRecord): Promise<void> {
    return this.baseProvider.addSession(record);
  }

  async updateSession(
    session: string,
    updates: Partial<Omit<SessionRecord, "session">>
  ): Promise<void> {
    return this.baseProvider.updateSession(session, updates);
  }

  async deleteSession(session: string): Promise<boolean> {
    return this.baseProvider.deleteSession(session);
  }

  async getRepoPath(record: SessionRecord | Record<string, unknown>): Promise<string> {
    return this.baseProvider.getRepoPath(record);
  }

  async getSessionWorkdir(sessionId: string): Promise<string> {
    return this.baseProvider.getSessionWorkdir(sessionId);
  }
}

/**
 * Factory function to create a SessionProvider with auto-repair capabilities
 * This replaces the existing createSessionProvider function to add universal auto-repair
 */
export function createSessionProviderWithAutoRepair(
  baseProvider: SessionProviderInterface
): SessionProviderInterface {
  return new SessionAutoRepairProvider(baseProvider);
}
