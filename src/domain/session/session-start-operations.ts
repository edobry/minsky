import { existsSync, rmSync } from "fs";
import { getMinskyStateDir, getSessionDir } from "/Users/edobry/.local/state/minsky/sessions/task#171/src/utils/paths";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "/Users/edobry/.local/state/minsky/sessions/task#171/src/errors/index";
import { taskIdSchema } from "/Users/edobry/.local/state/minsky/sessions/task#171/src/schemas/common";
import type {
  SessionStartParams,
} from "/Users/edobry/.local/state/minsky/sessions/task#171/src/schemas/session";
import { log } from "/Users/edobry/.local/state/minsky/sessions/task#171/src/utils/logger";
import { installDependencies } from "/Users/edobry/.local/state/minsky/sessions/task#171/src/utils/package-manager";
import { type GitServiceInterface } from "/Users/edobry/.local/state/minsky/sessions/task#171/src/domain/git";
import { normalizeRepoName, resolveRepoPath } from "/Users/edobry/.local/state/minsky/sessions/task#171/src/domain/repo-utils";
import { TASK_STATUS, type TaskServiceInterface } from "/Users/edobry/.local/state/minsky/sessions/task#171/src/domain/tasks";
import {
  type WorkspaceUtilsInterface,
} from "/Users/edobry/.local/state/minsky/sessions/task#171/src/domain/workspace";
import { createTaskFromDescription } from "/Users/edobry/.local/state/minsky/sessions/task#171/src/domain/templates/session-templates";
import type { SessionProviderInterface, SessionRecord, Session } from "/Users/edobry/.local/state/minsky/sessions/task#171/src/domain/session";

/**
 * Implementation of session start functionality
 * Extracted from session.ts for better modularity
 */
export async function startSessionImpl(
  params: SessionStartParams,
  deps: {
    sessionDB: SessionProviderInterface;
    gitService: GitServiceInterface;
    taskService: TaskServiceInterface;
    workspaceUtils: WorkspaceUtilsInterface;
    resolveRepoPath: typeof resolveRepoPath;
  }
): Promise<Session> {
  // Validate parameters using Zod schema (already done by type)
  const { name, repo, task, description, branch, noStatusUpdate, quiet, json, skipInstall, packageManager } =
    params;

  try {
    log.debug("Starting session with params", {
      name,
      task,
      inputBranch: branch,
      noStatusUpdate,
      quiet,
      json,
      skipInstall,
      packageManager,
    });

    const currentDir = process.env.PWD || process.cwd();
    const isInSession = await deps.workspaceUtils.isSessionWorkspace(currentDir);
    if (isInSession) {
      throw new MinskyError(`🚫 Cannot Start Session from Within Another Session

You're currently inside a session workspace, but sessions can only be created from the main workspace.

📍 Current location: ${currentDir}

🔄 How to exit this session workspace:

1️⃣ Navigate to your main workspace:
   cd /path/to/your/main/project

2️⃣ Or use the session directory command to find your way:
   minsky session dir

3️⃣ Then try creating your session again:
   minsky session start --task <id> [session-name]
   minsky session start --description "<description>" [session-name]

💡 Why this restriction exists:
Sessions are isolated workspaces for specific tasks. Creating nested sessions would cause conflicts and confusion.

Need help? Run 'minsky sessions list' to see all available sessions.`);
    }

    // Determine repo URL or path first
    let repoUrl = repo;
    if (!repoUrl) {
      try {
        repoUrl = await deps.resolveRepoPath({});
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        throw new MinskyError(
          `--repo is required (not in a git repo and no --repo provided): ${error.message}`
        );
      }
    }

    // Determine the session name using task ID if provided
    let sessionName = name;
    let taskId: string | undefined = task;

    // Auto-create task if description is provided but no task ID
    if (description && !taskId) {
      const taskSpec = createTaskFromDescription(description);
      const createdTask = await deps.taskService.createTaskFromTitleAndDescription(
        taskSpec.title,
        taskSpec.description
      );
      taskId = createdTask.id;
      if (!quiet) {
        log.cli(`Created task ${taskId}: ${taskSpec.title}`);
      }
    }

    if (taskId && !sessionName) {
      // Normalize the task ID format using Zod validation
      const normalizedTaskId = taskIdSchema.parse(taskId);
      taskId = normalizedTaskId;

      // Verify the task exists
      const taskObj = await deps.taskService.getTask(normalizedTaskId);
      if (!taskObj) {
        throw new ResourceNotFoundError(`Task ${taskId} not found`, "task", taskId);
      }

      // Use the task ID as the session name
      sessionName = `task${taskId}`;
    }

    if (!sessionName) {
      throw new ValidationError("Session name could not be determined from task ID");
    }

    // Check if session already exists
    const existingSession = await deps.sessionDB.getSession(sessionName);
    if (existingSession) {
      throw new MinskyError(`Session '${sessionName}' already exists`);
    }

    // Check if a session already exists for this task
    if (taskId) {
      const existingSessions = await deps.sessionDB.listSessions();
      const taskSession = existingSessions.find((s: SessionRecord) => {
        const normalizedSessionTaskId = s.taskId?.startsWith("#") ? s.taskId : `#${s.taskId}`;
        const normalizedInputTaskId = taskId?.startsWith("#") ? taskId : `#${taskId}`;
        return normalizedSessionTaskId === normalizedInputTaskId;
      });

      if (taskSession) {
        throw new MinskyError(
          `A session for task ${taskId} already exists: '${taskSession.session}'`
        );
      }
    }

    // Extract the repository name
    const repoName = normalizeRepoName(repoUrl);

    // Normalize the repo name for local repositories to ensure path consistency
    let normalizedRepoName = repoName;
    if (repoName.startsWith("local/")) {
      // Replace slashes with dashes in the path segments after "local/"
      const parts = repoName.split("/");
      if (parts.length > 1) {
        // Keep "local" as is, but normalize the rest
        normalizedRepoName = `${parts[0]}-${parts.slice(1).join("-")}`;
      }
    } else {
      // For other repository types, normalize as usual
      normalizedRepoName = repoName.replace(/[^a-zA-Z0-9-_]/g, "-");
    }

    // Generate the expected repository path using simplified session-ID-based structure
    const sessionDir = getSessionDir(sessionName);

    // Check if session directory already exists and clean it up
    if (existsSync(sessionDir)) {
      try {
        rmSync(sessionDir, { recursive: true, force: true });
      } catch (error) {
        throw new MinskyError(
          `Failed to clean up existing session directory: ${getErrorMessage(error)}`
        );
      }
    }

    // Prepare session record but don't add to DB yet
    const sessionRecord: SessionRecord = {
      session: sessionName,
      repoUrl,
      repoName,
      createdAt: new Date().toISOString(),
      taskId,
      branch: branch || sessionName,
    };

    let sessionAdded = false;
    // Define branchName outside try block so it's available in return statement
    const branchName = branch || sessionName;

    try {
      // First clone the repo
      const gitCloneResult = await deps.gitService.clone({
        repoUrl,
        session: sessionName,
        workdir: sessionDir, // Explicit workdir path computed by SessionDB
      });

      // Create a branch based on the session name - use branchWithoutSession
      // since session record hasn't been added to DB yet
      const branchResult = await deps.gitService.branchWithoutSession({
        repoName: normalizedRepoName,
        session: sessionName,
        branch: branchName,
      });

      // Only add session to DB after git operations succeed
      await deps.sessionDB.addSession(sessionRecord);
      sessionAdded = true;
    } catch (gitError) {
      // Clean up session record if it was added but git operations failed
      if (sessionAdded) {
        try {
          await deps.sessionDB.deleteSession(sessionName);
        } catch (cleanupError) {
          log.error("Failed to cleanup session record after git error", {
            sessionName,
            gitError: getErrorMessage(gitError),
            cleanupError:
              getErrorMessage(cleanupError),
          });
        }
      }

      // Clean up the directory if it was created
      if (existsSync(sessionDir)) {
        try {
          rmSync(sessionDir, { recursive: true, force: true });
        } catch (cleanupError) {
          log.error("Failed to cleanup session directory after git error", {
            sessionDir,
            gitError: getErrorMessage(gitError),
            cleanupError:
              getErrorMessage(cleanupError),
          });
        }
      }

      throw gitError;
    }

    // Install dependencies if not skipped
    if (!skipInstall) {
      try {
        const { success, error } = await installDependencies(sessionDir, {
          packageManager: packageManager,
          quiet: quiet,
        });

        if (!success && !quiet) {
          log.cliWarn(`Warning: Dependency installation failed. You may need to run install manually.
Error: ${error}`);
        }
      } catch (installError) {
        // Log but don't fail session creation
        if (!quiet) {
          log.cliWarn(
            `Warning: Dependency installation failed. You may need to run install manually.
Error: ${getErrorMessage(installError)}`
          );
        }
      }
    }

    // Update task status to IN-PROGRESS if requested and if we have a task ID
    if (taskId && !noStatusUpdate) {
      try {
        // Get the current status first
        const previousStatus = await deps.taskService.getTaskStatus(taskId);

        // Update the status to IN-PROGRESS
        await deps.taskService.setTaskStatus(taskId, TASK_STATUS.IN_PROGRESS);
      } catch (error) {
        // Log the error but don't fail the session creation
        log.cliWarn(
          `Warning: Failed to update status for task ${taskId}: ${getErrorMessage(error)}`
        );
      }
    }

    if (!quiet) {
      log.debug(`Started session for task ${taskId}`, { session: sessionName });
    }

    return {
      session: sessionName,
      repoUrl,
      repoName: normalizedRepoName,
      branch: branchName,
      taskId,
    };
  } catch (error) {
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(
        `Failed to start session: ${getErrorMessage(error)}`,
        error
      );
    }
  }
} 
