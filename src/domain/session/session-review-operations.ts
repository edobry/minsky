import { existsSync, rmSync } from "fs";
import { readFile, writeFile, mkdir, access, rename } from "fs/promises";
import { join } from "path";
import { getMinskyStateDir, getSessionDir } from "../../utils/paths";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
  createCommandFailureMessage,
  createErrorContext
} from "../../errors/index";
import { taskIdSchema } from "../../schemas/common";
import { log } from "../../utils/logger";
import { type GitServiceInterface } from "../git";
import { createGitService } from "../git";
import { TaskService, TASK_STATUS, type TaskServiceInterface } from "../tasks";
import { execAsync } from "../../utils/exec";
import {
  type WorkspaceUtilsInterface,
  getCurrentSession,
  getCurrentSessionContext,
} from "../workspace";
import * as WorkspaceUtils from "../workspace";
import { createSessionProvider, type SessionProviderInterface } from "./session-db-adapter";

/**
 * Interface for session review parameters
 */
export interface SessionReviewParams {
  session?: string;
  task?: string;
  repo?: string;
  output?: string;
  json?: boolean;
  prBranch?: string;
}

/**
 * Interface for session review result
 */
export interface SessionReviewResult {
  session: string;
  taskId?: string;
  taskSpec?: string;
  prDescription?: string;
  prBranch: string;
  baseBranch: string;
  diff?: string;
  diffStats?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

/**
 * Reviews a session PR by gathering and displaying relevant information
 */
export async function sessionReviewImpl(
  params: SessionReviewParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: TaskServiceInterface & {
      getTaskSpecData?: (taskId: string) => Promise<string>;
    };
    workspaceUtils?: WorkspaceUtilsInterface;
    getCurrentSession?: typeof getCurrentSession;
  }
): Promise<SessionReviewResult> {
  // Set up default dependencies if not provided
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService:
      depsInput?.taskService ||
      new TaskService({
        workspacePath: params.repo || process.cwd(),
        backend: "markdown",
      }),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  let sessionNameToUse = params.session;
  let taskId: string | undefined;

  // Try to get session from task ID if provided
  if (params.task && !sessionNameToUse) {
    const taskIdToUse = taskIdSchema.parse(params.task);
    taskId = taskIdToUse;

    // Get session by task ID
    const session = await deps.sessionDB.getSessionByTaskId(taskIdToUse);
    if (!session) {
      throw new ResourceNotFoundError(
        `No session found for task ${taskIdToUse}`,
        "task",
        taskIdToUse
      );
    }
    sessionNameToUse = session.session;
  }

  // If session is still not set, try to detect it from repo path
  if (!sessionNameToUse && params.repo) {
    try {
      const sessionContext = await deps.getCurrentSession(params.repo);
      if (sessionContext) {
        sessionNameToUse = sessionContext;
      }
    } catch (error) {
      // Just log and continue - session detection is optional
      log.debug("Failed to detect session from repo path", {
        error: getErrorMessage(error),
        repoPath: params.repo,
      });
    }
  }

  // If session is still not set, try to detect from current directory
  if (!sessionNameToUse) {
    try {
      const currentDir = process.cwd();
      const sessionContext = await deps.getCurrentSession(currentDir);
      if (sessionContext) {
        sessionNameToUse = sessionContext;
      }
    } catch (error) {
      // Just log and continue - session detection is optional
      log.debug("Failed to detect session from current directory", {
        error: getErrorMessage(error),
        currentDir: process.cwd(),
      });
    }
  }

  // Validate that we have a session to work with
  if (!sessionNameToUse) {
    throw new ValidationError("No session detected. Please provide a session name or task ID");
  }

  // Get the session record
  const sessionRecord = await deps.sessionDB.getSession(sessionNameToUse);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(
      `Session "${sessionNameToUse}" not found`,
      "session",
      sessionNameToUse
    );
  }

  // If no taskId from params, use the one from session record
  if (!taskId && sessionRecord.taskId) {
    taskId = sessionRecord.taskId;
  }

  // Get session workdir
  const sessionWorkdir = await deps.sessionDB.getSessionWorkdir(sessionNameToUse);

  // Determine PR branch name (pr/<session-name>)
  const prBranchToUse = params.prBranch || `pr/${sessionNameToUse}`;
  const baseBranch = "main"; // Default base branch, could be made configurable

  // Initialize result
  const result: SessionReviewResult = {
    session: sessionNameToUse,
    taskId,
    prBranch: prBranchToUse,
    baseBranch,
  };

  // 1. Get task specification if available
  if (taskId) {
    try {
      const taskService = deps.taskService;

      // Check if taskService has getTaskSpecData method dynamically
      if (
        "getTaskSpecData" in taskService &&
        typeof taskService.getTaskSpecData === "function"
      ) {
        const taskSpec = await taskService.getTaskSpecData(taskId);
        result.taskSpec = taskSpec;
      } else {
        log.debug("Task service does not support getTaskSpecData method");
      }
    } catch (error) {
      log.debug("Error getting task specification", {
        error: getErrorMessage(error),
        taskId,
      });
    }
  }

  // 2. Get PR description (from git log of the PR branch)
  try {
    // First check if the branch exists remotely
    const remoteBranchOutput = await deps.gitService.execInRepository(
      sessionWorkdir,
      `git ls-remote --heads origin ${prBranchToUse}`
    );
    const remoteBranchExists = remoteBranchOutput.trim().length > 0;

    if (remoteBranchExists) {
      // Fetch the PR branch to ensure we have latest
      await deps.gitService.execInRepository(sessionWorkdir, `git fetch origin ${prBranchToUse}`);

      // Get the PR description from the remote branch's last commit
      const prDescription = await deps.gitService.execInRepository(
        sessionWorkdir,
        `git log -1 --pretty=format:%B origin/${prBranchToUse}`
      );

      result.prDescription = prDescription;
    } else {
      // Check if branch exists locally
      const localBranchOutput = await deps.gitService.execInRepository(
        sessionWorkdir,
        `git show-ref --verify --quiet refs/heads/${prBranchToUse} || echo "not-exists"`
      );
      const localBranchExists = localBranchOutput.trim() !== "not-exists";

      if (localBranchExists) {
        // Get the PR description from the local branch's last commit
        const prDescription = await deps.gitService.execInRepository(
          sessionWorkdir,
          `git log -1 --pretty=format:%B ${prBranchToUse}`
        );

        result.prDescription = prDescription;
      }
    }
  } catch (error) {
    log.debug("Error getting PR description", {
      error: getErrorMessage(error),
      prBranch: prBranchToUse,
    });
  }

  // 3. Get diff stats and full diff
  try {
    // Fetch latest changes
    await deps.gitService.execInRepository(sessionWorkdir, "git fetch origin");

    // Get diff stats
    const diffStatsOutput = await deps.gitService.execInRepository(
      sessionWorkdir,
      `git diff --stat origin/${baseBranch}...origin/${prBranchToUse}`
    );

    // Parse diff stats
    const statsMatch = diffStatsOutput.match(
      /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
    );
    if (statsMatch) {
      result.diffStats = {
        filesChanged: parseInt(statsMatch[1] || "0", 10),
        insertions: parseInt(statsMatch[2] || "0", 10),
        deletions: parseInt(statsMatch[3] || "0", 10),
      };
    }

    // Get full diff
    const diffOutput = await deps.gitService.execInRepository(
      sessionWorkdir,
      `git diff origin/${baseBranch}...origin/${prBranchToUse}`
    );

    result.diff = diffOutput;
  } catch (error) {
    log.debug("Error getting diff information", {
      error: getErrorMessage(error),
      baseBranch,
      prBranch: prBranchToUse,
    });
  }

  return result;
} 
