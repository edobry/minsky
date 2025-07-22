import {
  ValidationError,
} from "../../errors/index";
import { taskIdSchema } from "../../schemas/common";
import {
  type SessionDeleteParams,
  type SessionListParams,
  type SessionDirParams,
  type SessionGetParams,
} from "../../schemas/session";
import { resolveSessionContextWithFeedback } from "./session-context-resolver";
import { getCurrentSessionContext } from "../workspace";
import {
  createSessionProvider,
  type SessionProviderInterface,
} from "./session-db-adapter";

/**
 * Gets session details based on parameters
 * Using proper dependency injection for better testability
 * Now includes auto-detection capabilities via unified session context resolver
 */
export async function getSessionImpl(
  params: { name: string; task: string; repo: string },
  deps: {
    sessionDB: SessionProviderInterface;
  }
): Promise<any | null> {
  const { name, task, repo } = params;

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
      throw new Error(
        "No session detected. Please provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }
}

/**
 * Lists all sessions based on parameters
 * Using proper dependency injection for better testability
 */
export async function listSessionsImpl(
  _params: SessionListParams,
  deps: {
    sessionDB: SessionProviderInterface;
  }
): Promise<any[]> {
  return deps.sessionDB.listSessions();
}

/**
 * Deletes a session based on parameters
 * Using proper dependency injection for better testability
 */
export async function deleteSessionImpl(
  params: SessionDeleteParams,
  deps: {
    sessionDB: SessionProviderInterface;
  }
): Promise<boolean> {
  const { name, task, repo } = params;

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
    // If error is about missing session requirements, provide better user guidance
    if (error instanceof ValidationError) {
      throw new Error(
        "No session detected. Please provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }
}

/**
 * Gets session directory based on parameters
 * Using proper dependency injection for better testability
 */
export async function getSessionDirImpl(
  params: SessionDirParams,
  deps: {
    sessionDB: SessionProviderInterface;
  }
): Promise<string> {
  let sessionName: string;

  if (params.task && !params.name) {
    // Find session by task ID
    const normalizedTaskId = taskIdSchema.parse(params.task);
    const session = await deps.sessionDB.getSessionByTaskId(normalizedTaskId);

    if (!session) {
      throw new Error(`No session found for task ID "${normalizedTaskId}"`);
    }

    sessionName = session.session;
  } else if (params.name) {
    sessionName = params.name;
  } else {
    throw new Error(`🚫 Session Directory: Missing Required Parameter

You must provide either a session name or task ID to get the session directory.

📖 Usage Examples:

  # Get directory by session name
  minsky session dir <session-name>

  # Get directory by task ID
  minsky session dir --task <task-id>
  minsky session dir -t <task-id>

💡 Tips:
  • List available sessions: minsky session list
  • Get session by task ID: minsky session get --task <task-id>
  • Check current session: minsky session inspect`);
  }

  const session = await deps.sessionDB.getSession(sessionName);

  if (!session) {
    throw new Error(`Session "${sessionName}" not found`);
  }

  // Get repo path from session using the getRepoPath method which has fallback logic
  const repoPath = await deps.sessionDB.getRepoPath(session);

  return repoPath;
}

/**
 * Inspects current session based on workspace location
 */
export async function inspectSessionImpl(
  _params: SessionGetParams,
  deps: {
    sessionDB: SessionProviderInterface;
  }
): Promise<any | null> {
  // Auto-detect the current session from the workspace
  const context = await getCurrentSessionContext(process.cwd());

  if (!context?.sessionId) {
    throw new Error("No session detected for the current workspace");
  }

  const session = await deps.sessionDB.getSession(context.sessionId);

  return session;
} 
