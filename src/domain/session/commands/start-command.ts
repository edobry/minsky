import type { SessionStartParams } from "../../schemas/session";
import { createSessionProvider } from "../../session";
import { createGitService } from "../../git";
import { TaskService } from "../../tasks";
import { normalizeRepoName, resolveRepoPath } from "../../repo-utils";
import { createTaskFromDescription } from "../../templates/session-templates";
import { installDependencies } from "../../utils/package-manager";
import { log } from "../../utils/logger";
import { 
  Session, 
  SessionRecord,
  SessionCreateDependencies 
} from "../types";
import { 
  MinskyError, 
  ValidationError,
} from "../../errors/index";
import * as WorkspaceUtils from "../../workspace";

/**
 * Starts a new session based on parameters
 * Using proper dependency injection for better testability
 */
export async function sessionStart(
  params: SessionStartParams,
  depsInput?: SessionCreateDependencies
): Promise<Session> {
  // Validate parameters using Zod schema (already done by type)
  const { name, repo, task, description, branch, noStatusUpdate, quiet, json, skipInstall, packageManager } =
    params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService: depsInput?.taskService || new TaskService(),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    resolveRepoPath: depsInput?.resolveRepoPath || resolveRepoPath,
  };

  // Validate required parameters
  if (!name) {
    throw new ValidationError("Session name is required");
  }

  if (!repo) {
    throw new ValidationError("Repository name is required");
  }

  try {
    // Check if session already exists
    const existingSession = await deps.sessionDB.getSession(name);
    if (existingSession) {
      throw new ValidationError(`Session '${name}' already exists`);
    }

    // Resolve repository path
    const repoPath = await deps.resolveRepoPath(repo);
    const repoName = normalizeRepoName(repo);

    // Handle task creation if description provided
    let taskId = task;
    if (description && !taskId) {
      if (!quiet) {
        log.info("Creating task from description...");
      }
      
      taskId = await createTaskFromDescription(description, {
        taskService: deps.taskService,
        noStatusUpdate,
      });
      
      if (!quiet) {
        log.info(`Created task: ${taskId}`);
      }
    }

    // Create session record
    const sessionRecord: SessionRecord = {
      session: name,
      repoName,
      repoUrl: repoPath,
      createdAt: new Date().toISOString(),
      taskId,
      branch,
    };

    // Clone repository and create session workspace
    const workdir = deps.workspaceUtils.getSessionWorkdir(name);
    
    const cloneResult = await deps.gitService.clone({
      repoUrl: repoPath,
      workdir,
      session: name,
      branch,
    });

    // Install dependencies if not skipped
    if (!skipInstall) {
      if (!quiet) {
        log.info("Installing dependencies...");
      }
      
      await installDependencies(workdir, {
        packageManager,
        skipIfExists: true,
      });
    }

    // Add session to database
    await deps.sessionDB.addSession(sessionRecord);

    if (!quiet) {
      log.info(`Session '${name}' created successfully`);
    }

    return {
      session: name,
      repoUrl: repoPath,
      repoName,
      branch,
      createdAt: sessionRecord.createdAt,
      taskId,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new MinskyError(`Failed to start session: ${error.message}`);
    }
    throw error;
  }
} 
