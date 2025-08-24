import { existsSync } from "fs";
import { readFile, writeFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { getMinskyStateDir, getSessionDir } from "../../utils/paths";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
  createCommandFailureMessage,
} from "../../errors/index";
import { taskIdSchema as TaskIdSchema } from "../../schemas/common";
import { log } from "../../utils/logger";
import { type GitServiceInterface } from "../git";
import { createGitService } from "../git";
import { createRepositoryBackend, RepositoryBackendType } from "../repository";
import { TASK_STATUS, type TaskServiceInterface, createConfiguredTaskService } from "../tasks";
import { execAsync } from "../../utils/exec";
import {
  type WorkspaceUtilsInterface,
  getCurrentSession,
  getCurrentSessionContext,
} from "../workspace";
import * as WorkspaceUtils from "../workspace";
import { createSessionProvider, type SessionProviderInterface } from "./session-db-adapter";
import { gitFetchWithTimeout } from "../../utils/git-exec";

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
      (await createConfiguredTaskService({
        workspacePath: params.repo || process.cwd(),
      })),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  let sessionNameToUse = params.session;
  let taskId: string | undefined;

  // Try to get session from task ID if provided
  if (params.task && !sessionNameToUse) {
    const taskIdToUse = TaskIdSchema.parse(params.task);
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

  // Initialize result (prBranch/baseBranch will be filled from backend details when available)
  const result: SessionReviewResult = {
    session: sessionNameToUse,
    taskId,
    prBranch: params.prBranch || `pr/${sessionNameToUse}`,
    baseBranch: "main",
  };

  // 1. Get task specification if available
  if (taskId) {
    try {
      const taskService = deps.taskService;

      // Check if taskService has getTaskSpecData method dynamically
      if ("getTaskSpecData" in taskService && typeof taskService.getTaskSpecData === "function") {
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

  // 2. Get PR details and diff from repository backend (backend-agnostic)
  try {
    // Determine backend from session record
    const backendType: RepositoryBackendType = ((): RepositoryBackendType => {
      if (sessionRecord.backendType === "github") return RepositoryBackendType.GITHUB;
      if (sessionRecord.backendType === "remote") return RepositoryBackendType.REMOTE;
      return RepositoryBackendType.LOCAL;
    })();

    const backend = await createRepositoryBackend({
      type: backendType,
      repoUrl: sessionRecord.repoUrl,
    });

    // Fetch PR details; if GitHub, backend infers PR number from session
    const details = await backend.getPullRequestDetails({ session: sessionNameToUse });
    if (details) {
      if (details.headBranch) result.prBranch = details.headBranch;
      if (details.baseBranch) result.baseBranch = details.baseBranch;
      result.prDescription = details.body;
    }

    // Fetch diff
    const diffInfo = await backend.getPullRequestDiff({ session: sessionNameToUse });
    if (diffInfo) {
      result.diff = diffInfo.diff;
      if (diffInfo.stats) {
        result.diffStats = diffInfo.stats;
      }
    }
  } catch (error) {
    log.debug("Error getting PR details/diff from repository backend", {
      error: getErrorMessage(error),
      session: sessionNameToUse,
      repoUrl: sessionRecord.repoUrl,
      backendType: sessionRecord.backendType,
    });
  }

  // Note: direct git-based diff code removed in favor of backend methods

  return result;
}
