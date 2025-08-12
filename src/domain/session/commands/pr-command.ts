import type { SessionPRParameters } from "../../../domain/schemas";
import { createSessionProvider } from "../../session";
import { createGitService } from "../../git";
import { sessionPrImpl } from "../session-pr-operations";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { SessionPrResult, SessionProviderInterface } from "../types";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import { log } from "../../utils/logger";
import { extractPrDescription } from "../session-update-operations";
import { readFile } from "fs/promises";

/**
 * Prepares a PR for a session based on parameters
 */
export async function sessionPr(
  params: SessionPRParameters,
  options?: {
    interface?: "cli" | "mcp";
    workingDirectory?: string;
  }
): Promise<SessionPrResult> {
  const { session, task, repo, title, body, bodyPath, debug } = params;

  // Set default values for properties not in new schema
  const baseBranch = "main"; // Default base branch
  const branchName = undefined; // Will be generated automatically

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

    // Check if PR already exists based on session record
    if (sessionRecord.prState?.commitHash) {
      log.debug(
        `PR already exists for session '${resolvedContext.sessionName}' with commit ${sessionRecord.prState.commitHash}`
      );
      // Force recreation by clearing the prState and deleting git branch
      try {
        await gitService.execInRepository(
          workdir,
          `git branch -D pr/${resolvedContext.sessionName}`
        );
        log.debug(
          `Deleted existing PR branch pr/${resolvedContext.sessionName} to force recreation`
        );
      } catch (error) {
        log.debug(`Could not delete existing PR branch: ${error}`);
      }

      // Clear prState to allow recreation
      await sessionDB.updateSession(resolvedContext.sessionName, {
        ...sessionRecord,
        prBranch: undefined, // Clear prBranch field too
        prState: undefined,
      });
    }

    // TASK 360 FIX: Read body content from bodyPath if provided
    let bodyContent = body;
    if (!bodyContent && bodyPath) {
      try {
        bodyContent = await readFile(bodyPath, "utf-8");
        if (debug) {
          log.debug("Read body content from file", { bodyPath, contentLength: bodyContent.length });
        }
      } catch (error) {
        throw new ValidationError(
          `Failed to read body content from file: ${bodyPath}. ${getErrorMessage(error)}`,
          "bodyPath",
          bodyPath
        );
      }
    }

    // Prepare PR using session operations layer (proper architecture)
    const result = await sessionPrImpl(
      {
        session: resolvedContext.sessionName,
        task: params.task,
        repo: params.repo,
        title,
        body: bodyContent,
        autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
        skipConflictCheck: params.skipConflictCheck,
        debug,
      },
      {
        sessionDB,
        gitService,
      },
      options
    );

    // For GitHub backend, we don't use pr/ branches - work directly with session branch
    let commitHash = "";
    let prBranchName = result.prBranch;

    // Only get commit hash from pr/ branch for local/remote backends
    if (sessionRecord.backendType !== "github") {
      const commitHashResult = await gitService.execInRepository(
        workdir,
        `git rev-parse pr/${resolvedContext.sessionName}`
      );
      commitHash = commitHashResult.trim();
    } else {
      // For GitHub backend, use the session branch commit hash
      const commitHashResult = await gitService.execInRepository(
        workdir,
        `git rev-parse HEAD`
      );
      commitHash = commitHashResult.trim();
      prBranchName = resolvedContext.sessionName; // GitHub PRs use session branch directly
    }

    // Update session record with PR state
    await sessionDB.updateSession(resolvedContext.sessionName, {
      ...sessionRecord,
      prBranch: prBranchName, // Set prBranch field for approval validation
      prState: {
        branchName: prBranchName,
        commitHash: commitHash,
        lastChecked: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    });

    // Include session information in the result for CLI formatting
    return {
      ...result,
      session: {
        session: sessionRecord.session,
        taskId: sessionRecord.taskId,
        repoName: sessionRecord.repoName,
      },
      sessionName: sessionRecord.session, // Alternative property name for formatter compatibility
    };
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
