import type { SessionPrParams } from "../../schemas/session";
import { createSessionProvider } from "../../session";
import { createGitService } from "../../git";
import { preparePrFromParams } from "../../git";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { 
  SessionPrResult,
  SessionProviderInterface,
} from "../types";
import { 
  MinskyError, 
  ResourceNotFoundError, 
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import { log } from "../../utils/logger";
import { extractPrDescription } from "../session-update-operations";

/**
 * Prepares a PR for a session based on parameters
 */
export async function sessionPr(params: SessionPrParams): Promise<SessionPrResult> {
  const { session, task, repo, baseBranch, title, body, branchName, debug } = params;

  // Set up dependencies with defaults
  const sessionDB = createSessionProvider();
  const gitService = createGitService();

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      session,
      task,
      repo,
      sessionProvider: sessionDB,
      allowAutoDetection: true,
    });

    // Get the session details using the resolved session name
    const sessionRecord = await sessionDB.getSession(resolvedContext.sessionName);
    
    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionName}' not found`);
    }

    // Get session working directory
    const workdir = await sessionDB.getSessionWorkdir(resolvedContext.sessionName);

    // Check if PR branch already exists
    const prBranchExists = await checkPrBranchExists(resolvedContext.sessionName, gitService, workdir);
    
    if (prBranchExists) {
      // Extract existing PR description
      const existingPr = await extractPrDescription(resolvedContext.sessionName, gitService, workdir);
      
      if (existingPr) {
        log.info(`PR branch for session '${resolvedContext.sessionName}' already exists`);
        return {
          prBranch: `pr/${resolvedContext.sessionName}`,
          baseBranch: baseBranch || "main",
          title: existingPr.title,
          body: existingPr.body,
        };
      }
    }

    // Prepare PR using git domain function
    const result = await preparePrFromParams({
      session: resolvedContext.sessionName,
      repo: workdir,
      baseBranch,
      title,
      body,
      branchName,
      debug,
    });

    return result;
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
 * Check if PR branch exists for a session
 */
async function checkPrBranchExists(
  sessionName: string,
  gitService: any,
  currentDir: string
): Promise<boolean> {
  try {
    const prBranchName = `pr/${sessionName}`;
    const branches = await gitService.execInRepository(currentDir, "git branch -a");
    return branches.includes(prBranchName);
  } catch (error) {
    log.debug("Could not check for PR branch", { error });
    return false;
  }
}

 
