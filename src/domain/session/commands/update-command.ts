import type { SessionUpdateParams } from "../../../schemas/session";
import { createSessionProvider } from "../../session";
import { createGitService } from "../../git";
import { getCurrentSession } from "../../workspace";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { 
  Session, 
  SessionProviderInterface,
  SessionDependencies 
} from "../types";
import { 
  MinskyError, 
  ResourceNotFoundError, 
  ValidationError,
  getErrorMessage,
} from "../../../../errors";
import { log } from "../../../../utils/logger";

/**
 * Updates a session based on parameters
 * Using proper dependency injection for better testability
 */
export async function updateSessionFromParams(
  params: SessionUpdateParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: any;
    getCurrentSession?: typeof getCurrentSession;
  }
): Promise<Session> {
  const { name, task, repo, branch } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
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
    const session = await deps.sessionDB.getSession(resolvedContext.sessionName);
    
    if (!session) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionName}' not found`);
    }

    // Get session working directory
    const workdir = await deps.sessionDB.getSessionWorkdir(resolvedContext.sessionName);

    // Perform git operations to sync with remote
    try {
      // Fetch latest changes
      await deps.gitService.pullLatest(workdir);
      
      // If branch is specified, checkout to that branch
      if (branch) {
        await deps.gitService.execInRepository(workdir, `git checkout ${branch}`);
      }

      // Update session record if branch changed
      if (branch && session.branch !== branch) {
        await deps.sessionDB.updateSession(resolvedContext.sessionName, {
          branch,
        });
        session.branch = branch;
      }

      log.info(`Session '${resolvedContext.sessionName}' updated successfully`);
      
      return session;
    } catch (error) {
      throw new MinskyError(`Failed to update session: ${getErrorMessage(error)}`);
    }
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
