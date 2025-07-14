import { existsSync, rmSync } from "fs";
import { readFile, writeFile, mkdir, access, rename } from "fs/promises";
import { join } from "path";
import { getMinskyStateDir, getSessionDir } from "../utils/paths";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
  createCommandFailureMessage,
  createErrorContext
} from "../errors/index";
import { taskIdSchema } from "../schemas/common";
import type {
  SessionListParams,
  SessionGetParams,
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams,
  SessionPrParams,
} from "../schemas/session";
import { log } from "../utils/logger";
import { installDependencies } from "../utils/package-manager";
import { type GitServiceInterface, preparePrFromParams } from "./git";
import { createGitService } from "./git";
import { ConflictDetectionService } from "./git/conflict-detection";
import { normalizeRepoName, resolveRepoPath } from "./repo-utils";
import { TaskService, TASK_STATUS, type TaskServiceInterface } from "./tasks";
import { execAsync } from "../utils/exec";
import {
  type WorkspaceUtilsInterface,
  getCurrentSession,
  getCurrentSessionContext,
} from "./workspace";
import * as WorkspaceUtils from "./workspace";
import { SessionDbAdapter } from "./session/session-db-adapter";
import { createTaskFromDescription } from "./templates/session-templates";
import { resolveSessionContextWithFeedback } from "./session/session-context-resolver";
import { startSessionImpl } from "./session/start-session-operations";
import { 
  updateSessionImpl, 
  checkPrBranchExistsOptimized, 
  updatePrStateOnCreation, 
  updatePrStateOnMerge,
  extractPrDescription
} from "./session/session-update-operations";

export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  backendType?: "local" | "remote" | "github"; // Added for repository backend support
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
  remote?: {
    authMethod?: "ssh" | "https" | "token";
    depth?: number;
  };
  branch?: string; // Branch property is already part of the interface
  prState?: {
    branchName: string;
    exists: boolean;
    lastChecked: string; // ISO timestamp
    createdAt?: string;   // When PR branch was created
    mergedAt?: string;    // When merged (for cleanup)
  };
}

export interface Session {
  session: string;
  repoUrl?: string;
  repoName?: string;
  branch?: string;
  createdAt?: string;
  taskId?: string;
  backendType?: "local" | "remote" | "github";
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
  remote?: {
    authMethod?: "ssh" | "https" | "token";
    depth?: number;
  };
}

/**
 * Interface for session database operations
 * This defines the contract for session management functionality
 */
export interface SessionProviderInterface {
  /**
   * Get all available sessions
   */
  listSessions(): Promise<SessionRecord[]>;

  /**
   * Get a specific session by name
   */
  getSession(session: string): Promise<SessionRecord | null>;

  /**
   * Get a specific session by task ID
   */
  getSessionByTaskId(taskId: string): Promise<SessionRecord | null>;

  /**
   * Add a new session to the database
   */
  addSession(record: SessionRecord): Promise<void>;

  /**
   * Update an existing session
   */
  updateSession(session: string, updates: Partial<Omit<SessionRecord, "session">>): Promise<void>;

  /**
   * Delete a session by name
   */
  deleteSession(session: string): Promise<boolean>;

  /**
   * Get the repository path for a session
   */
  getRepoPath(record: SessionRecord | any): Promise<string>;

  /**
   * Get the working directory for a session
   */
  getSessionWorkdir(sessionName: string): Promise<string>;
}

/**
 * Gets session details based on parameters
 * Using proper dependency injection for better testability
 * Now includes auto-detection capabilities via unified session context resolver
 */
export async function getSessionFromParams(
  params: SessionGetParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<Session | null> {
  const { name, task, repo } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: task,
      repo: repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: true,
    });

    // Get the session details using the resolved session name
    return deps.sessionDB.getSession(resolvedContext.sessionName);
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
 * Lists all sessions based on parameters
 * Using proper dependency injection for better testability
 */
export async function listSessionsFromParams(
  params: SessionListParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<Session[]> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  return deps.sessionDB.listSessions();
}

/**
 * Starts a new session based on parameters
 * Using proper dependency injection for better testability
 */
export async function startSessionFromParams(
  params: SessionStartParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: TaskServiceInterface;
    workspaceUtils?: WorkspaceUtilsInterface;
    resolveRepoPath?: typeof resolveRepoPath;
  }
): Promise<Session> {
  // Validate parameters using Zod schema (already done by type)
  const { name, repo, task, description, branch, noStatusUpdate, quiet, json, skipInstall, packageManager } =
    params;

  // Create dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService:
      depsInput?.taskService ||
      new TaskService({
        workspacePath: process.cwd(),
        backend: "markdown",
      }),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils.createWorkspaceUtils(),
    resolveRepoPath: depsInput?.resolveRepoPath || resolveRepoPath,
  };

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

/**
 * Deletes a session based on parameters
 * Using proper dependency injection for better testability
 */
export async function deleteSessionFromParams(
  params: SessionDeleteParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<boolean> {
  const { name, task, repo } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: task,
      repo: repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: true,
    });

    // Delete the session using the resolved session name
    return deps.sessionDB.deleteSession(resolvedContext.sessionName);
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
 * Gets session directory based on parameters
 * Using proper dependency injection for better testability
 */
export async function getSessionDirFromParams(
  params: SessionDirParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<string> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  let sessionName: string;

  if (params.task && !params.name) {
    // Find session by task ID
    const normalizedTaskId = taskIdSchema.parse(params.task);
    const session = await deps.sessionDB.getSessionByTaskId(normalizedTaskId);

    if (!session) {
      throw new ResourceNotFoundError(`No session found for task ID "${normalizedTaskId}"`);
    }

    sessionName = session.session;
  } else if (params.name) {
    sessionName = params.name;
  } else {
    throw new ResourceNotFoundError(`🚫 Session Directory: Missing Required Parameter

You must provide either a session name or task ID to get the session directory.

📖 Usage Examples:

  # Get directory by session name
  minsky session dir <session-name>

  # Get directory by task ID
  minsky session dir --task <task-id>
  minsky session dir -t <task-id>

💡 Tips:
  • List available sessions: minsky session list
  • Get session by task ID: minsky session get --task <task-id>
  • Check current session: minsky session inspect`);
  }

  const session = await deps.sessionDB.getSession(sessionName);

  if (!session) {
    throw new ResourceNotFoundError(`Session "${sessionName}" not found`);
  }

  // Get repo path from session using the getRepoPath method which has fallback logic
  const repoPath = await deps.sessionDB.getRepoPath(session);

  return repoPath;
}



/**
 * Interface-agnostic function for updating a session
 */
export async function updateSessionFromParams(
  params: SessionUpdateParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    getCurrentSession?: typeof getCurrentSession;
  }
): Promise<Session> {
  // Set up dependencies with defaults
  const deps = {
    gitService: depsInput?.gitService || createGitService(),
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  return updateSessionImpl(params, deps);
}



/**
 * Interface-agnostic function for creating a PR for a session
 */
export async function sessionPrFromParams(
  params: SessionPrParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
  }
): Promise<{
  prBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
}> {
  // STEP 0: Validate parameters using schema
  try {
    // Import schema here to avoid circular dependency issues
    const { sessionPrParamsSchema } = await import("../schemas/session.js");
    sessionPrParamsSchema.parse(params);
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      // Extract the validation error message
      const zodError = error as unknown;
      const message = zodError.errors?.[0]?.message || "Invalid parameters";
      throw new ValidationError(message);
    }
    throw error;
  }

  // STEP 1: Validate we're in a session workspace and on a session branch
  const currentDir = process.cwd();
  const isSessionWorkspace = currentDir.includes("/sessions/");
  if (!isSessionWorkspace) {
    throw new MinskyError(
      "session pr command must be run from within a session workspace. Use 'minsky session start' first."
    );
  }

  // Get current git branch
  const gitService = depsInput?.gitService || createGitService();
  const currentBranch = await gitService.getCurrentBranch(currentDir);

  // STEP 2: Ensure we're NOT on a PR branch (should fail if on pr/* branch)
  if (currentBranch.startsWith("pr/")) {
    throw new MinskyError(
      `Cannot run session pr from PR branch '${currentBranch}'. Switch to your session branch first.`
    );
  }

  // STEP 3: Verify we're in a session directory (no branch format restriction)
  // The session name will be detected from the directory path or provided explicitly
  // Both task#XXX and named sessions are supported

  // STEP 4: Check for uncommitted changes
  const hasUncommittedChanges = await gitService.hasUncommittedChanges(currentDir);
  if (hasUncommittedChanges) {
    // Get the status of uncommitted changes to show in the error
    let statusInfo = "";
    try {
      const status = await gitService.getStatus(currentDir);
      const changes = [];

      if (status.modified.length > 0) {
        changes.push(`📝 Modified files (${status.modified.length}):`);
        status.modified.forEach((file) => changes.push(`   ${file}`));
      }

      if (status.untracked.length > 0) {
        changes.push(`📄 New files (${status.untracked.length}):`);
        status.untracked.forEach((file) => changes.push(`   ${file}`));
      }

      if (status.deleted.length > 0) {
        changes.push(`🗑️  Deleted files (${status.deleted.length}):`);
        status.deleted.forEach((file) => changes.push(`   ${file}`));
      }

      statusInfo = changes.length > 0 ? changes.join("\n") : "No detailed changes available";
    } catch (statusError) {
      statusInfo = "Unable to get detailed status.";
    }

    throw new MinskyError(
      `
🚫 Cannot create PR with uncommitted changes

You have uncommitted changes in your session workspace that need to be committed first.

Current changes:
${statusInfo}

To fix this, run one of the following:

📝 Commit your changes:
   git add .
   git commit -m "Your commit message"

📦 Or stash your changes temporarily:
   git stash

💡 Then try creating the PR again:
   minsky session pr --title "your title"

Need help? Run 'git status' to see what files have changed.
      `.trim()
    );
  }

  // Handle body content - read from file if bodyPath is provided
  let bodyContent = params.body;
  if (params.bodyPath) {
    try {
      // Resolve relative paths relative to current working directory
      const filePath = require("path").resolve(params.bodyPath);
      bodyContent = await readFile(filePath, "utf-8");

      if (!bodyContent.trim()) {
        throw new ValidationError(`Body file is empty: ${params.bodyPath}`);
      }

      log.debug(`Read PR body from file: ${filePath}`, {
        fileSize: bodyContent.length,
        bodyPath: params.bodyPath,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }

      const errorMessage = getErrorMessage(error);
      if (errorMessage.includes("ENOENT") || errorMessage.includes("no such file")) {
        throw new ValidationError(`Body file not found: ${params.bodyPath}`);
      } else if (errorMessage.includes("EACCES") || errorMessage.includes("permission denied")) {
        throw new ValidationError(`Permission denied reading body file: ${params.bodyPath}`);
      } else {
        throw new ValidationError(
          `Failed to read body file: ${params.bodyPath}. ${errorMessage}`
        );
      }
    }
  }

  // Determine the session name
  let sessionName = params.session;
  const sessionDb = depsInput?.sessionDB || createSessionProvider();

  // If no session name provided but task ID is, try to find the session by task ID
  if (!sessionName && params.task) {
    const taskId = params.task;
    const sessionRecord = await sessionDb.getSessionByTaskId(taskId);
    if (sessionRecord) {
      sessionName = sessionRecord.session;
    } else {
      throw new MinskyError(`No session found for task ID ${taskId}`);
    }
  }

  // If still no session name, try to detect from current directory
  if (!sessionName) {
    try {
      // Extract session name from path - assuming standard path format
      const pathParts = currentDir.split("/");
      const sessionsIndex = pathParts.indexOf("sessions");
      if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
        sessionName = pathParts[sessionsIndex + 1];
      }
    } catch (error) {
      // If detection fails, throw error
      throw new MinskyError(
        "Could not detect session from current directory. Please specify a session name or task ID."
      );
    }

    if (!sessionName) {
      throw new MinskyError(
        "Could not detect session from current directory. Please specify a session name or task ID."
      );
    }
  }

  log.debug(`Creating PR for session: ${sessionName}`, {
    session: sessionName,
    title: params.title,
    hasBody: !!bodyContent,
    bodySource: params.bodyPath ? "file" : "parameter",
    baseBranch: params.baseBranch,
  });

  // STEP 4.5: PR Branch Detection and Title/Body Handling
  // This implements the new refresh functionality
  const prBranchExists = await checkPrBranchExistsOptimized(sessionName, gitService, currentDir, sessionDb);

  let titleToUse = params.title;
  let bodyToUse = bodyContent;

  if (!titleToUse && prBranchExists) {
    // Case: Existing PR + no title → Auto-reuse existing title/body (refresh)
    log.cli("🔄 Refreshing existing PR (reusing title and body)...");

    const existingDescription = await extractPrDescription(sessionName, gitService, currentDir);
    if (existingDescription) {
      titleToUse = existingDescription.title;
      bodyToUse = existingDescription.body;
      log.cli(`📝 Reusing existing title: "${titleToUse}"`);
    } else {
      // Fallback if we can't extract description
      throw new MinskyError(
        `PR branch pr/${sessionName} exists but could not extract existing title/body. Please provide --title explicitly.`
      );
    }
  } else if (!titleToUse && !prBranchExists) {
    // Case: No PR + no title → Error (need title for first creation)
    throw new MinskyError(
      `PR branch pr/${sessionName} doesn't exist. Please provide --title for initial PR creation.`
    );
  } else if (titleToUse && prBranchExists) {
    // Case: Existing PR + new title → Use new title/body (update)
    log.cli("📝 Updating existing PR with new title/body...");
  } else if (titleToUse && !prBranchExists) {
    // Case: No PR + title → Normal creation flow
    log.cli("✨ Creating new PR...");
  }

  // STEP 4.6: Conditional body/bodyPath validation
  // For new PR creation, we need either body or bodyPath (unless we extracted from existing)
  if (!bodyToUse && !params.bodyPath && (!prBranchExists || !titleToUse)) {
    // Only require body/bodyPath when:
    // 1. No existing PR to reuse from (prBranchExists=false), OR
    // 2. Existing PR but new title provided (titleToUse=true) indicating update
    if (!prBranchExists) {
      log.cli("💡 Tip: For new PRs, consider providing --body or --body-path for a complete description");
      // Allow empty body for new PRs (user choice)
    }
  }

  // STEP 5: Enhanced session update with conflict detection (unless --skip-update is specified)
  if (!params.skipUpdate) {
    log.cli("🔍 Checking for conflicts before PR creation...");

    try {
      // Use enhanced update with conflict detection options
      await updateSessionFromParams({
        name: sessionName,
        repo: params.repo,
        json: false,
        force: false,
        noStash: false,
        noPush: false,
        dryRun: false,
        skipConflictCheck: params.skipConflictCheck,
        autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
        skipIfAlreadyMerged: true, // Skip update if changes already merged
      });
      log.cli("✅ Session updated successfully");
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      // Enhanced error handling for common conflict scenarios
      if (errorMessage.includes("already in base") || errorMessage.includes("already merged")) {
        log.cli("💡 Your session changes are already in the base branch. Proceeding with PR creation...");
      } else if (errorMessage.includes("conflicts")) {
        log.cli("⚠️  Merge conflicts detected. Consider using conflict resolution options:");
        log.cli("   • --auto-resolve-delete-conflicts: Auto-resolve delete/modify conflicts");
        log.cli("   • --skip-update: Skip update entirely if changes are already merged");
        throw new MinskyError(`Failed to update session before creating PR: ${errorMessage}`);
      } else {
        throw new MinskyError(`Failed to update session before creating PR: ${errorMessage}`);
      }
    }
  } else {
    log.cli("⏭️  Skipping session update (--skip-update specified)");
  }

  // STEP 6: Now proceed with PR creation
  const result = await preparePrFromParams({
    session: sessionName,
    title: titleToUse,
    body: bodyToUse,
    baseBranch: params.baseBranch,
    debug: params.debug,
  });

  // Update PR state cache after successful creation
  await updatePrStateOnCreation(sessionName, sessionDb);

  // Update task status to IN-REVIEW if associated with a task
  if (!params.noStatusUpdate) {
    const sessionRecord = await sessionDb.getSession(sessionName);
    if (sessionRecord?.taskId) {
      try {
        const taskService = new TaskService({
          workspacePath: process.cwd(),
          backend: "markdown",
        });
        await taskService.setTaskStatus(sessionRecord.taskId, TASK_STATUS.IN_REVIEW);
        log.cli(`Updated task #${sessionRecord.taskId} status to IN-REVIEW`);
      } catch (error) {
        log.warn(
          `Failed to update task status: ${getErrorMessage(error)}`
        );
      }
    }
  }

  return result;
}

/**
 * Approves and merges a session PR branch
 */
export async function approveSessionFromParams(
  params: {
    session?: string;
    task?: string;
    repo?: string;
    json?: boolean;
  },
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: {
      setTaskStatus?: (taskId: string, status: string) => Promise<any>;
      getTaskStatus?: (taskId: string) => Promise<string | undefined>;
      getBackendForTask?: (taskId: string) => Promise<any>;
    };
    workspaceUtils?: any;
    getCurrentSession?: (repoPath: string) => Promise<string | null>;
  }
): Promise<{
  session: string;
  commitHash: string;
  mergeDate: string;
  mergedBy: string;
  baseBranch: string;
  prBranch: string;
  taskId?: string;
  isNewlyApproved: boolean;
}> {
  let sessionNameToUse = params.session;
  let taskId: string | undefined;

  // Set up session provider (use injected one or create default)
  const sessionDB = depsInput?.sessionDB || createSessionProvider();

  // Try to get session from task ID if provided
  if (params.task && !sessionNameToUse) {
    const taskIdToUse = taskIdSchema.parse(params.task);
    taskId = taskIdToUse;

    // Get session by task ID
    const session = await sessionDB.getSessionByTaskId(taskIdToUse);
    if (!session) {
      throw new ResourceNotFoundError(
        `No session found for task ${taskIdToUse}`,
        "task",
        taskIdToUse
      );
    }
    sessionNameToUse = session.session;
  }

  // Try to auto-detect session from repo path if no session name or task is provided
  if (!sessionNameToUse && params.repo) {
    const getCurrentSessionFunc = depsInput?.getCurrentSession || getCurrentSession;
    const detectedSession = await getCurrentSessionFunc(params.repo);
    if (detectedSession) {
      sessionNameToUse = detectedSession;
    }
  }

  // Validate that we have a session to work with
  if (!sessionNameToUse) {
    throw new ValidationError("No session detected. Please provide a session name or task ID");
  }

  // Get the session record
  const sessionRecord = await sessionDB.getSession(sessionNameToUse);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(
      `Session "${sessionNameToUse}" not found`,
      "session",
      sessionNameToUse
    );
  }

  // BUG FIX: Use the original repo URL/path for task updates, not session workspace
  const originalRepoPath = params.repo || sessionRecord.repoUrl || process.cwd();

  // Set up default dependencies with the correct repo path
  const deps = {
    sessionDB: depsInput?.sessionDB || sessionDB,
    gitService: depsInput?.gitService || createGitService(),
    taskService:
      depsInput?.taskService ||
      new TaskService({
        workspacePath: originalRepoPath,
        backend: "markdown",
      }),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  // If no taskId from params, use the one from session record
  if (!taskId && sessionRecord.taskId) {
    taskId = sessionRecord.taskId;
  }

  // BUG FIX: Use originalRepoPath for all git operations instead of session workspace
  // This ensures approval operations happen in the main repository, not the session workspace
  // The session workspace state becomes irrelevant for approval
  const workingDirectory = originalRepoPath;

  // Determine PR branch name (pr/<session-name>)
  const featureBranch = sessionNameToUse;
  const prBranch = `pr/${featureBranch}`;
  const baseBranch = "main"; // Default base branch, could be made configurable

  // Early exit check: If task is already DONE and PR branch doesn't exist, session is already complete
  if (taskId && deps.taskService.getTaskStatus) {
    try {
      const currentStatus = await deps.taskService.getTaskStatus(taskId);
      if (currentStatus === TASK_STATUS.DONE) {
        // Check if PR branch exists
        try {
          await deps.gitService.execInRepository(workingDirectory, `git show-ref --verify --quiet refs/heads/${prBranch}`);
          // PR branch exists, continue with normal flow
          log.debug(`PR branch ${prBranch} exists, continuing with normal flow`);
        } catch (branchError) {
          // PR branch doesn't exist and task is already DONE - session is complete
          log.debug(`Session ${sessionNameToUse} is already complete: task ${taskId} is DONE and PR branch ${prBranch} doesn't exist`);

          // Get current HEAD info for the response
          const commitHash = (
            await deps.gitService.execInRepository(workingDirectory, "git rev-parse HEAD")
          ).trim();
          const mergedBy = (
            await deps.gitService.execInRepository(workingDirectory, "git config user.name")
          ).trim();
          const mergeDate = new Date().toISOString();

          return {
            session: sessionNameToUse,
            commitHash,
            mergeDate,
            mergedBy,
            baseBranch,
            prBranch,
            taskId,
            isNewlyApproved: false,
          };
        }
      } else {
        log.debug(`Task ${taskId} is not DONE (status: ${currentStatus}), continuing with normal flow`);
      }
    } catch (statusError) {
      // If we can't check the status, continue with normal flow
      log.debug(`Could not check task status for ${taskId}, continuing with normal approval flow`);
    }
  }

  try {
    // Execute git commands to merge the PR branch in the main repository
    // First, check out the base branch
    await deps.gitService.execInRepository(workingDirectory, `git checkout ${baseBranch}`);
    // Fetch latest changes
    await deps.gitService.execInRepository(workingDirectory, "git fetch origin");

    // Check if the PR branch has already been merged
    let isNewlyApproved = true;
    let commitHash: string = "";
    let mergeDate: string = "";
    let mergedBy: string = "";

    try {
      // Check if the PR branch exists locally
      await deps.gitService.execInRepository(workingDirectory, `git show-ref --verify --quiet refs/heads/${prBranch}`);

      // Get the commit hash of the PR branch
      const prBranchCommitHash = (
        await deps.gitService.execInRepository(workingDirectory, `git rev-parse ${prBranch}`)
      ).trim();

      // REMOVED: Problematic race condition check
      // Instead of checking git merge-base --is-ancestor, let git merge handle it
      // This avoids the race condition where the check can fail during merge process

      // Attempt the merge - if it fails because already merged, git will tell us
      try {
        await deps.gitService.execInRepository(workingDirectory, `git merge --ff-only ${prBranch}`);

        // If merge succeeds, it's newly approved
        isNewlyApproved = true;

        // Get commit hash and date for the new merge
        commitHash = (
          await deps.gitService.execInRepository(workingDirectory, "git rev-parse HEAD")
        ).trim();
        mergeDate = new Date().toISOString();
        mergedBy = (
          await deps.gitService.execInRepository(workingDirectory, "git config user.name")
        ).trim();

        // Push the changes
        await deps.gitService.execInRepository(workingDirectory, `git push origin ${baseBranch}`);

        // Delete the PR branch from remote only if it exists there
        try {
          // Check if remote branch exists first using execAsync directly to avoid error logging
          // This is expected to fail if the branch doesn't exist, which is normal
          await execAsync(`git show-ref --verify --quiet refs/remotes/origin/${prBranch}`, {
            cwd: workingDirectory
          });
          // If it exists, delete it
          await deps.gitService.execInRepository(
            workingDirectory,
            `git push origin --delete ${prBranch}`
          );
        } catch (error) {
          // Remote branch doesn't exist, which is fine - just log it
          log.debug(`Remote PR branch ${prBranch} doesn't exist, skipping deletion`);
        }

        // Clean up local branches after successful merge
        await cleanupLocalBranches(deps.gitService, workingDirectory, prBranch, sessionNameToUse, taskId);

        // Update PR state to reflect merge
        await updatePrStateOnMerge(sessionNameToUse, deps.sessionDB);

      } catch (mergeError) {
        // Merge failed - check if it's because already merged
        const errorMessage = getErrorMessage(mergeError as Error);

        if (errorMessage.includes("Already up to date") || errorMessage.includes("nothing to commit")) {
          // PR branch has already been merged
          isNewlyApproved = false;
          log.debug(`PR branch ${prBranch} has already been merged`);

          // Update PR state to reflect it's already merged
          await updatePrStateOnMerge(sessionNameToUse, deps.sessionDB);

          // Get current HEAD info for already merged case
          commitHash = (
            await deps.gitService.execInRepository(workingDirectory, "git rev-parse HEAD")
          ).trim();

          // For already merged PRs, try to get the merge commit info
          try {
            const mergeCommitInfo = await deps.gitService.execInRepository(
              workingDirectory,
              `git log --merges --oneline --grep="Merge.*${prBranch}" -n 1 --format="%H|%ai|%an"`
            );
            if (mergeCommitInfo.trim()) {
              const parts = mergeCommitInfo.trim().split("|");
              if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
                commitHash = parts[0];
                mergeDate = new Date(parts[1]).toISOString();
                mergedBy = parts[2];
              } else {
                // Fallback to current HEAD info if format is unexpected
                mergeDate = new Date().toISOString();
                mergedBy = (
                  await deps.gitService.execInRepository(workingDirectory, "git config user.name")
                ).trim();
              }
            } else {
              // Fallback to current HEAD info if we can't find the merge commit
              mergeDate = new Date().toISOString();
              mergedBy = (
                await deps.gitService.execInRepository(workingDirectory, "git config user.name")
              ).trim();
            }
          } catch (error) {
            // Fallback to current HEAD info
            mergeDate = new Date().toISOString();
            mergedBy = (
              await deps.gitService.execInRepository(workingDirectory, "git config user.name")
            ).trim();
          }
        } else {
          // Some other merge error - re-throw it
          throw mergeError;
        }
      }
    } catch (error) {
      // PR branch doesn't exist locally, it might have been already merged and cleaned up
      isNewlyApproved = false;
      log.debug(`PR branch ${prBranch} doesn't exist locally, assuming already merged`);

      // Get current HEAD info
      commitHash = (
        await deps.gitService.execInRepository(workingDirectory, "git rev-parse HEAD")
      ).trim();
      mergeDate = new Date().toISOString();
      mergedBy = (
        await deps.gitService.execInRepository(workingDirectory, "git config user.name")
      ).trim();
    }

    // The merge logic has been moved inside the try block above
    // No need for separate isNewlyApproved check here

    // Create merge info
    const mergeInfo = {
      session: sessionNameToUse,
      commitHash,
      mergeDate,
      mergedBy,
      baseBranch,
      prBranch,
      taskId,
      isNewlyApproved,
    };

    // Update task status to DONE if we have a task ID and it's not already DONE
    if (taskId && deps.taskService.setTaskStatus && deps.taskService.getTaskStatus) {
      try {
        // Check current status first to avoid unnecessary updates
        const currentStatus = await deps.taskService.getTaskStatus(taskId);

        if (currentStatus !== TASK_STATUS.DONE) {
          log.debug(`Updating task ${taskId} status from ${currentStatus} to DONE`);
          await deps.taskService.setTaskStatus(taskId, TASK_STATUS.DONE);

          // After updating task status, check if there are uncommitted changes that need to be committed
          try {
            const statusOutput = await deps.gitService.execInRepository(workingDirectory, "git status --porcelain");
            const hasUncommittedChanges = statusOutput.trim().length > 0;

            if (hasUncommittedChanges) {
              log.debug("Task status update created uncommitted changes, committing them");

              // Stage the tasks.md file (or any other changed files from task status update)
              await deps.gitService.execInRepository(workingDirectory, "git add process/tasks.md");

              // Commit the task status update
              await deps.gitService.execInRepository(workingDirectory, `git commit -m "Update task ${taskId} status to DONE"`);

              // Push the commit
              await deps.gitService.execInRepository(workingDirectory, "git push");

              log.debug(`Committed and pushed task ${taskId} status update`);
            } else {
              log.debug("No uncommitted changes from task status update");
            }
          } catch (commitError) {
            // Log the error but don't fail the whole operation
            const errorMsg = `Failed to commit task status update: ${getErrorMessage(commitError as Error)}`;
            log.error(errorMsg, { taskId, error: commitError });
            log.cli(`Warning: ${errorMsg}`);
          }
        } else {
          log.debug(`Task ${taskId} is already DONE, skipping status update`);
        }
      } catch (error) {
        // BUG FIX: Use proper logging instead of console.error and make error visible
        const errorMsg = `Failed to update task status: ${getErrorMessage(error)}`;
        log.error(errorMsg, { taskId, error });
        log.cli(`Warning: ${errorMsg}`);
        // Still don't fail the whole operation, but now errors are visible
      }
    }

    return mergeInfo;
  } catch (error) {
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(
        `Failed to approve session: ${getErrorMessage(error)}`
      );
    }
  }
}

/**
 * Clean up local branches after successful merge
 * Handles failures gracefully to not break the overall approval process
 */
async function cleanupLocalBranches(
  gitService: GitServiceInterface,
  workingDirectory: string,
  prBranch: string,
  sessionName: string,
  taskId?: string
): Promise<void> {
  // Extract task ID from session name if not provided and session follows task# pattern
  const taskBranchName = taskId ? taskId.replace("#", "") : sessionName.replace("task#", "");

  // Clean up the PR branch (e.g., pr/task#265)
  try {
    await gitService.execInRepository(workingDirectory, `git branch -d ${prBranch}`);
    log.debug(`Successfully deleted local PR branch: ${prBranch}`);
  } catch (error) {
    // Log but don't fail the operation if branch cleanup fails
    log.debug(`Failed to delete local PR branch ${prBranch}: ${getErrorMessage(error)}`);
  }

  // Clean up the task branch (e.g., task#265 or 265)
  // Try various possible branch name formats
  const possibleTaskBranches = [];

  // Add sessionName if it looks like a task branch (task#265)
  if (sessionName && sessionName !== prBranch) {
    possibleTaskBranches.push(sessionName);
  }

  // Add numeric version if we have a task ID (265)
  if (taskBranchName && taskBranchName !== sessionName) {
    possibleTaskBranches.push(taskBranchName);
  }

  // Add task prefix version (task265, task#265)
  if (taskBranchName) {
    possibleTaskBranches.push(`task${taskBranchName}`);
    possibleTaskBranches.push(`task#${taskBranchName}`);
  }

  // Filter out duplicates, empty strings, PR branch, and invalid branch names
  const uniqueBranches = [...new Set(possibleTaskBranches)].filter(
    branch => branch && branch !== prBranch && !branch.startsWith("#")
  );

  for (const branch of uniqueBranches) {
    try {
      await gitService.execInRepository(workingDirectory, `git branch -d ${branch}`);
      log.debug(`Successfully deleted local task branch: ${branch}`);
      break; // Stop after first successful deletion
    } catch (error) {
      // Log but continue trying other branch names
      log.debug(`Failed to delete local task branch ${branch}: ${getErrorMessage(error)}`);
    }
  }
}

/**
 * Creates a default SessionProvider implementation
 * This factory function provides a consistent way to get a session provider with optional customization
 */
export function createSessionProvider(options?: {
  dbPath?: string;
  useNewBackend?: boolean;
}): SessionProviderInterface {
  // Always use the new configuration-based backend
  return new SessionDbAdapter();
}

/**
 * Inspects current session based on workspace location
 */
export async function inspectSessionFromParams(params: {
  json?: boolean;
}): Promise<Session | null> {
  // Auto-detect the current session from the workspace
  const context = await getCurrentSessionContext(process.cwd());

  if (!context?.sessionId) {
    throw new ResourceNotFoundError("No session detected for the current workspace");
  }

  const session = await createSessionProvider().getSession(context.sessionId);

  return session;
}

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
export async function sessionReviewFromParams(
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
        typeof (taskService as unknown).getTaskSpecData === "function"
      ) {
        const taskSpec = await (taskService as unknown).getTaskSpecData(taskId);
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

// Re-export types from session-db module for convenience
export type { SessionRecord, SessionDbState } from "./session/session-db";

// Re-export the SessionDbAdapter class
export { SessionDbAdapter } from "./session/session-db-adapter";

// Export SessionDB as function for backward compatibility with existing imports
// This replaces the old class-based compatibility layer with a cleaner function-based approach
export const SessionDB = createSessionProvider;
