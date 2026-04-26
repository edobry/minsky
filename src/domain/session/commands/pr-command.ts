import type { SessionPRParameters } from "../../../domain/schemas";
import type { GitServiceInterface } from "../../git/types";
import { sessionPrImpl } from "../session-pr-operations";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { SessionPrResult, SessionProviderInterface } from "../types";
import { ResourceNotFoundError, ValidationError, getErrorMessage } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { readTextFile } from "../../../utils/fs";

export interface SessionPrDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  persistenceProvider?: import("../../persistence/types").PersistenceProvider;
  /** Optional — forwarded to sessionPrImpl so the task can be advanced to IN-REVIEW. */
  taskService?: import("../../tasks/taskService").TaskServiceInterface;
}

/**
 * Prepares a PR for a session based on parameters
 */
export async function sessionPr(
  params: SessionPRParameters,
  deps: SessionPrDependencies,
  options?: {
    interface?: "cli" | "mcp";
    workingDirectory?: string;
  }
): Promise<SessionPrResult> {
  const { session, task, repo, title, body, bodyPath, debug } = params;
  const { sessionDB, gitService } = deps;

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      sessionId: session,
      task,
      repo,
      sessionProvider: sessionDB,
      allowAutoDetection: true,
    });

    // Get the session details using the resolved session ID
    const sessionRecord = await sessionDB.getSession(resolvedContext.sessionId);

    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
    }

    // Get session working directory
    const workdir = await sessionDB.getSessionWorkdir(resolvedContext.sessionId);

    // Check if PR already exists based on session record
    if (sessionRecord.prState?.exists) {
      log.debug(`PR already exists for session '${resolvedContext.sessionId}'`);
      // Force recreation by clearing the prState and deleting git branch
      try {
        const branchToDelete =
          sessionRecord.backendType === "github"
            ? sessionRecord.branch || resolvedContext.sessionId
            : `pr/${sessionRecord.branch || resolvedContext.sessionId}`;

        await gitService.execInRepository(workdir, `git branch -D ${branchToDelete}`);
        log.debug(`Deleted existing PR branch ${branchToDelete} to force recreation`);
      } catch (error) {
        log.debug(`Could not delete existing PR branch: ${error}`);
      }

      // Clear prState to allow recreation
      await sessionDB.updateSession(resolvedContext.sessionId, {
        prBranch: undefined, // Clear prBranch field too
        prState: undefined,
      });
    }

    // TASK 360 FIX: Read body content from bodyPath if provided
    let bodyContent = body;
    if (!bodyContent && bodyPath) {
      try {
        bodyContent = await readTextFile(bodyPath);
        if (debug) {
          log.debug("Read body content from file", {
            bodyPath,
            contentLength: bodyContent?.length ?? 0,
          });
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
        session: resolvedContext.sessionId,
        task: params.task,
        repo: params.repo,
        title,
        body: bodyContent,
        autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
        skipConflictCheck: params.skipConflictCheck,
        draft: params.draft,
        debug,
        noStatusUpdate: params.noStatusUpdate,
      },
      {
        sessionDB,
        gitService,
        persistenceProvider: deps.persistenceProvider,
        taskService: deps.taskService,
      },
      options
    );

    // Repository backends handle PR state persistence; include session info for CLI formatting
    return {
      ...result,
      session: {
        session: sessionRecord.session,
        taskId: sessionRecord.taskId,
        repoName: sessionRecord.repoName,
      },
      sessionId: sessionRecord.session, // Alternative property name for formatter compatibility
    };
  } catch (error) {
    // If error is about missing session requirements, provide better user guidance
    if (error instanceof ValidationError) {
      throw new ResourceNotFoundError(
        "No session detected. Please provide a session ID (--sessionId), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }
}
