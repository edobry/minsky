import type { SessionStartParameters } from "../../../domain/schemas";
import { startSessionImpl } from "../start-session-operations";
import * as WorkspaceUtils from "../../workspace";
import { createSessionProvider } from "../../session";
import { createGitService } from "../../git";
import { createConfiguredTaskService } from "../../tasks/taskService";
import { normalizeRepoName, resolveRepoPath } from "../../repo-utils";
import { resolveRepositoryAndBackend } from "../../session/repository-backend-detection";
import { createTaskFromDescription } from "../../templates/session-templates";
import { detectPackageManager, installDependencies } from "../../../utils/package-manager";
import { log } from "../../utils/logger";
import { Session, SessionRecord, SessionCreateDependencies } from "../types";
import { MinskyError, ValidationError } from "../../errors/index";

/**
 * Starts a new session based on parameters
 * Using proper dependency injection for better testability
 */
export async function sessionStart(
  params: SessionStartParameters,
  depsInput?: any
): Promise<Session> {
  // Delegate to domain implementation; adapter remains thin
  const taskService = depsInput?.taskService || (await createConfiguredTaskService());
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService,
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    resolveRepoPath: depsInput?.resolveRepoPath || resolveRepoPath,
  };

<<<<<<< Updated upstream
  return startSessionImpl(params, deps as any);
=======
  // Validate required parameters
  if (!name) {
    throw new ValidationError("Session name is required");
  }

  if (!repo) {
    const { repoUrl } = await resolveRepositoryAndBackend({ cwd: process.cwd() });
    repo = repoUrl;
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

    // Create session record (do not persist branch; it's equal to session name)
    // Persist backendType derived from repository to ensure correct PR workflow
    const { backendType } = await resolveRepositoryAndBackend({ repoParam: repoPath });

    const sessionRecord: SessionRecord = {
      session: name,
      repoName,
      repoUrl: repoPath,
      createdAt: new Date().toISOString(),
      taskId,
      backendType,
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
      createdAt: sessionRecord.createdAt,
      taskId,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new MinskyError(`Failed to start session: ${error.message}`);
    }
    throw error;
  }
>>>>>>> Stashed changes
}
