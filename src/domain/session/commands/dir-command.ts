import type { SessionDirParams } from "../../../schemas/session";
import { createSessionProvider } from "../../session";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { 
  SessionProviderInterface,
  SessionDependencies 
} from "../types";
import { 
  ResourceNotFoundError, 
  ValidationError,
} from "../../../../errors";

/**
 * Gets session directory based on parameters
 * Using proper dependency injection for better testability
 */
export async function getSessionDirFromParams(
  params: SessionDirParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<string> {
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

    // Get the session directory using the resolved session name
    return deps.sessionDB.getSessionWorkdir(resolvedContext.sessionName);
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
