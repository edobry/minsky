import type { SessionDeleteParams } from "../../schemas/session";
import { createSessionProvider } from "../../session";
import {
  SessionProviderInterface,
  SessionDependencies
} from "../types";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { ResourceNotFoundError } from "../../errors";

/**
 * Deletes a session based on parameters
 * Using proper dependency injection for better testability
 */
export async function sessionDelete(
  params: SessionDeleteParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<boolean> {
  const { name, task, repo } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
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

    // Delete the session using the resolved session name
    return deps.sessionDB.deleteSession(resolvedContext.sessionName);
  } catch (error) {
    // If session is not found, return false instead of throwing
    if (error instanceof ResourceNotFoundError) {
      return false;
    }
    throw error;
  }
}
