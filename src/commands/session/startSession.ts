import { GitService } from "../../domain/git.js";
import { SessionDB } from "../../domain/session.js";
import type { SessionRecord } from "../../domain/session.js";
import { TaskService, TASK_STATUS } from "../../domain/tasks.js";
import { RepositoryBackendType } from "../../domain/repository.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveRepoPath as resolveRepoPathDefault,
  normalizeRepoName,
} from "../../domain/repo-utils.js";
import { normalizeTaskId } from "../../domain/tasks/utils";
import { log } from "../../utils/logger.js";

// Default imports for optional parameters
const fsDefault = fs;
const pathDefault = path;

export interface StartSessionOptions {
  session?: string;
  repo?: string;
  taskId?: string;
  backend?: "local" | "remote" | "github" | "auto";
  branch?: string;
  github?: {
    token?: string;
    owner?: string;
    repo?: string;
  };
  remote?: {
    authMethod?: "ssh" | "https" | "token";
    depth?: number;
  };
  noStatusUpdate?: boolean;
  gitService?: GitService;
  sessionDB?: SessionDB;
  fs?: typeof fs;
  path?: typeof path;
  resolveRepoPath?: typeof resolveRepoPathDefault;
  taskService?: TaskService;
}

export interface StartSessionResult {
  sessionRecord: SessionRecord;
  cloneResult: { workdir: string };
  branchResult: { branch: string };
  statusUpdateResult?: {
    taskId: string;
    previousStatus: string | null;
    newStatus: string;
  };
}

export async function startSession({
  session,
  repo,
  taskId,
  backend = "auto",
  branch,
  github,
  remote,
  noStatusUpdate,
  gitService,
  sessionDB,
  fs: fsInstance, // Renamed to avoid conflict with import
  path: pathInstance, // Renamed to avoid conflict with import
  resolveRepoPath,
  taskService,
}: StartSessionOptions): Promise<StartSessionResult> {
  // Only use default if the value is undefined (not null or a falsy mock)
  gitService = typeof gitService !== "undefined" ? gitService : new GitService();
  sessionDB = typeof sessionDB !== "undefined" ? sessionDB : new SessionDB();
  const currentFs = typeof fsInstance !== "undefined" ? fsInstance : fsDefault;
  const currentPath = typeof pathInstance !== "undefined" ? pathInstance : pathDefault;
  resolveRepoPath =
    typeof resolveRepoPath !== "undefined" ? resolveRepoPath : resolveRepoPathDefault;

  let repoUrl = repo;
  if (!repoUrl) {
    try {
      repoUrl = await resolveRepoPath({});
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(
        `--repo is required (not in a git repo and no --repo provided): ${error.message}`
      );
    }
  }

  taskService =
    taskService ||
    new TaskService({
      workspacePath: repoUrl,
      backend: "markdown", // Assuming markdown backend for now
    });

  // If taskId is provided but no session name, use the task ID to generate the session name
  if (taskId && !session) {
    const normalizedTaskInput = taskId; // Store original input for better error messages
    const internalTaskId = normalizeTaskId(normalizedTaskInput);
    if (!internalTaskId) {
      throw new Error(`Invalid Task ID format provided: "${normalizedTaskInput}"`);
    }
    const task = await taskService.getTask(internalTaskId);
    if (!task) {
      throw new Error(`Task with ID originating from "${normalizedTaskInput}" (normalized to "${internalTaskId}") not found`);
    }
    taskId = internalTaskId; // Update taskId to the normalized (with #) version
    // The session name should use the numeric part without the # prefix
    session = `task${internalTaskId}`; // This will create names like task#123
  }

  if (!session) {
    throw new Error("Either session name or taskId must be provided");
  }

  const existingSession = await sessionDB.getSession(session);
  if (existingSession) {
    throw new Error(`Session '${session}' already exists`);
  }

  if (taskId) {
    const existingSessions = await sessionDB.listSessions();
    const taskSession = existingSessions.find((s: SessionRecord) => {
      if (!s.taskId) return false;
      const normalizedSessionTaskId = normalizeTaskId(s.taskId);
      const normalizedInputTaskId = normalizeTaskId(taskId);
      return normalizedSessionTaskId === normalizedInputTaskId;
    });
    if (taskSession) {
      throw new Error(`A session for task ${taskId} already exists: '${taskSession.session}'`);
    }
  }

  let backendType: "local" | "remote" | "github" = "local";
  if (backend === "auto") {
    if (
      repoUrl.startsWith("http://") ||
      repoUrl.startsWith("https://") ||
      repoUrl.startsWith("git@")
    ) {
      if (repoUrl.includes("github.com")) {
        backendType = "github";
      } else {
        backendType = "remote";
      }
    } else {
      backendType = "local";
    }
  } else if (backend) {
    backendType = backend as "local" | "remote" | "github";
  }

  const repoName = normalizeRepoName(repoUrl);
  const sessionRecordData: SessionRecord = {
    session,
    repoUrl,
    repoName,
    createdAt: new Date().toISOString(),
    taskId,
    backendType: backendType,
    github,
    remote,
    ...(branch ? { branch } as any : {}),
  };
  await sessionDB.addSession(sessionRecordData);

  const cloneOptions = {
    repoUrl,
    session,
    backend: backendType,
    github,
    remote,
    branch,
  };

  const cloneResult = await gitService.clone(cloneOptions);
  const branchResult = await gitService.branch({
    session,
    branch: session, // Typically branch name is same as session name for new sessions
  });

  const result: StartSessionResult = {
    sessionRecord: sessionRecordData,
    cloneResult,
    branchResult,
  };

  if (taskId && !noStatusUpdate) {
    try {
      const previousStatus = await taskService.getTaskStatus(taskId);
      if (!previousStatus || previousStatus === TASK_STATUS.TODO) {
        await taskService.setTaskStatus(taskId, TASK_STATUS.IN_PROGRESS);
        result.statusUpdateResult = {
          taskId,
          previousStatus: previousStatus || null,
          newStatus: TASK_STATUS.IN_PROGRESS,
        };
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.cliError(`Warning: Failed to update status for task ${taskId}: ${err.message}`);
      log.warn("Task status update failed", {
        taskId,
        error: err.message,
        stack: err.stack
      });
    }
  }
  return result;
}
