import type { SessionPRParameters } from "../../../domain/schemas";
import { createSessionProvider } from "../../session";
import { createGitService } from "../../git";
import { preparePrFromParams } from "../../git";
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
import { updateSessionFromParams } from "../../session";

/**
 * Prepares a PR for a session based on parameters
 */
export async function sessionPr(params: SessionPRParameters): Promise<SessionPrResult> {
  const { session, task, repo, title, body, bodyPath, debug, skipUpdate } = params;

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

    // Check if PR branch already exists
    const prBranchExists = await checkPrBranchExists(
      resolvedContext.sessionName,
      gitService,
      workdir
    );

    if (prBranchExists) {
      // Extract existing PR description
      const existingPr = await extractPrDescription(
        resolvedContext.sessionName,
        gitService,
        workdir
      );

      if (existingPr) {
        log.info(`PR branch for session '${resolvedContext.sessionName}' already exists`);
        return {
          prBranch: `pr/${resolvedContext.sessionName}`,
          baseBranch: baseBranch || "main",
          title: existingPr.title,
          body: existingPr.body,
          // Include session information in the result for CLI formatting
          session: {
            session: sessionRecord.session,
            taskId: sessionRecord.taskId,
            repoName: sessionRecord.repoName,
            branch: sessionRecord.branch,
          },
          sessionName: sessionRecord.session, // Alternative property name for formatter compatibility
        };
      }
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

    // BUG FIX: Update session with latest main before creating PR (unless skipUpdate=true)
    if (!skipUpdate) {
      if (debug) {
        log.debug("Updating session with latest main before creating PR", {
          sessionName: resolvedContext.sessionName,
          skipUpdate,
        });
      }

      try {
        await updateSessionFromParams(
          {
            name: resolvedContext.sessionName,
            task,
            repo,
            // Use sensible defaults for session update
            noStash: false,
            noPush: false,
            force: false,
            skipConflictCheck: false,
            autoResolveDeleteConflicts: false,
            dryRun: false,
            skipIfAlreadyMerged: true, // Skip if already merged to avoid unnecessary work
          },
          {
            sessionDB,
            gitService,
          }
        );

        if (debug) {
          log.debug("Session updated successfully before PR creation");
        }
      } catch (error) {
        // If session update fails, provide helpful error message
        throw new MinskyError(
          `Failed to update session before creating PR: ${getErrorMessage(error)}. ` +
            "You can skip the session update using --skip-update flag if needed.",
          error
        );
      }
    } else if (debug) {
      log.debug("Skipping session update due to skipUpdate=true");
    }

    // Prepare PR using git domain function
    const result = await preparePrFromParams({
      session: resolvedContext.sessionName,
      repo: workdir,
      baseBranch,
      title,
      body: bodyContent,
      branchName,
      debug,
    });

    // Include session information in the result for CLI formatting
    return {
      ...result,
      session: {
        session: sessionRecord.session,
        taskId: sessionRecord.taskId,
        repoName: sessionRecord.repoName,
        branch: sessionRecord.branch,
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
