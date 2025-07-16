import type { SessionGetParams } from "../../../schemas/session";
import { createSessionProvider } from "../../session";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { 
  Session, 
  SessionProviderInterface,
  SessionDependencies 
} from "../types";
import { 
  ResourceNotFoundError, 
  ValidationError,
} from "../../../../errors";

/**
 * Gets session details based on parameters
 * Using proper dependency injection for better testability
 * Now includes auto-detection capabilities via unified session context resolver
 */
export async function getSessionFromParams(
  params: SessionGetParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<Session | null> {
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

    // Get the session details using the resolved session name
    return deps.sessionDB.getSession(resolvedContext.sessionName);
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
