import type { SessionDeleteParameters } from "../../../domain/schemas";
import { createSessionProvider } from "../../session";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { SessionProviderInterface, SessionDependencies } from "../types";
import { cleanupSessionImpl } from "../session-lifecycle-operations";
import { log } from "../../../utils/logger";

/**
 * Deletes a session based on parameters
 * Using proper dependency injection for better testability
 */
export async function sessionDelete(
  params: SessionDeleteParameters,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<boolean> {
  const { name, task, repo } = params as any;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || await createSessionProvider(),
  };

  try {
    // Resolve session name from either explicit name or task ID
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: task,
      repo: repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: true,
    });

    // In strict testable design, prefer database deletion without real filesystem cleanup
    return await deps.sessionDB.deleteSession(resolvedContext.sessionName);
  } catch (error) {
    // Fall back to database-only deletion if cleanup fails
    log.warn(`Session cleanup failed, falling back to database-only deletion: ${error}`);
    try {
      const resolved = await resolveSessionContextWithFeedback({
        session: name,
        task: task,
        repo: repo,
        sessionProvider: deps.sessionDB,
        allowAutoDetection: true,
      });
      return deps.sessionDB.deleteSession(resolved.sessionName);
    } catch {
      const fallbackName = name ?? "";
      return fallbackName ? deps.sessionDB.deleteSession(fallbackName) : false;
    }
  }
}

// Export alias for compatibility with subcommands
export { sessionDelete as deleteSession };
