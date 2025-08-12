import type { SessionStartParameters } from "../../../domain/schemas";
import { createSessionProvider } from "../../session";
import { createGitService } from "../../git";
import { TaskService } from "../../tasks";
import { createConfiguredTaskService } from "../../tasks/taskService";
import { normalizeRepoName, resolveRepoPath } from "../../repo-utils";
import { createTaskFromDescription } from "../../templates/session-templates";
import { detectPackageManager, installDependencies } from "../../../utils/package-manager";
import { log } from "../../utils/logger";
import { Session, SessionRecord, SessionCreateDependencies } from "../types";
import { MinskyError, ValidationError } from "../../errors/index";
import * as WorkspaceUtils from "../../workspace";

/**
 * Starts a new session based on parameters
 * Using proper dependency injection for better testability
 */
export async function sessionStart(
  params: SessionStartParameters,
  depsInput?: SessionCreateDependencies
): Promise<Session> {
  // Validate parameters using Zod schema (already done by type)
  const {
    name,
    repo: repoParam,
    task,
    description,
    branch,
    noStatusUpdate,
    quiet,
    format,
    skipInstall,
    packageManager,
  } = params;

  let repo = repoParam;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService: depsInput?.taskService || (await createConfiguredTaskService()),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    resolveRepoPath: depsInput?.resolveRepoPath || resolveRepoPath,
  };

  // Validate required parameters
  if (!name) {
    throw new ValidationError("Session name is required");
  }

  if (!repo) {
    // Try to use configured default repo backend (github) when repo not given
    const { getConfiguration } = await import("../../configuration/index");
    const cfg = getConfiguration();
    const defaultRepoBackend = cfg.repository?.default_repo_backend;

    if (defaultRepoBackend === "github") {
      // Auto-detect GitHub remote URL when default backend is github
      try {
        const { execSync } = await import("child_process");
        const remoteUrl = execSync("git remote get-url origin", {
          cwd: process.cwd(),
          encoding: "utf8",
        })
          .toString()
          .trim();

        if (remoteUrl.includes("github.com")) {
          // Use the GitHub remote URL as the repository
          repo = remoteUrl;
        } else {
          throw new ValidationError(
            "Default repository backend is GitHub, but current directory does not have a GitHub remote. Pass --repo <github-url> or change to a GitHub repository."
          );
        }
      } catch (error) {
        throw new ValidationError(
          "Default repository backend is GitHub, but could not detect GitHub remote. Ensure you're in a git repository with GitHub remote or pass --repo <github-url>."
        );
      }
    } else {
      throw new ValidationError("Repository name is required");
    }
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
    const sessionRecord: SessionRecord = {
      session: name,
      repoName,
      repoUrl: repoPath,
      createdAt: new Date().toISOString(),
      taskId,
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
}
