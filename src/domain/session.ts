import { existsSync, rmSync } from "fs";
import { readFile, writeFile, mkdir, access, rename } from "fs/promises";
import { join } from "path";
import { getMinskyStateDir, getSessionDbPath } from "../utils/paths.js";
import { 
  MinskyError, 
  ResourceNotFoundError, 
  ValidationError,
  getErrorMessage,
  createCommandFailureMessage,
  createErrorContext
} from "../errors/index.js";
import { taskIdSchema } from "../schemas/common.js";
import type {
  SessionListParams,
  SessionGetParams,
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams,
  SessionPrParams,
} from "../schemas/session.js";
import { log } from "../utils/logger.js";
import { installDependencies } from "../utils/package-manager.js";
import { type GitServiceInterface, preparePrFromParams } from "./git.js";
import { createGitService } from "./git.js";
import { ConflictDetectionService } from "./git/conflict-detection.js";
import { normalizeRepoName, resolveRepoPath } from "./repo-utils.js";
import { TaskService, TASK_STATUS, type TaskServiceInterface } from "./tasks.js";
import {
  type WorkspaceUtilsInterface,
  getCurrentSession,
  getCurrentSessionContext,
} from "./workspace.js";
import * as WorkspaceUtils from "./workspace.js";
import { SessionDbAdapter } from "./session/session-db-adapter.js";
import { createTaskFromDescription } from "./templates/session-templates.js";
import { resolveSessionContextWithFeedback } from "./session/session-context-resolver.js";
import { startSessionImpl } from "./session/start-session-operations.js";

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

  return startSessionImpl(params, deps);
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
    throw new ResourceNotFoundError("You must provide either a session name or task ID");
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
  let { name, branch, remote, noStash, noPush, force, skipConflictCheck, autoResolveDeleteConflicts, dryRun, skipIfAlreadyMerged } = params;

  log.debug("updateSessionFromParams called", { params });

  // Set up dependencies with defaults
  const deps = {
    gitService: depsInput?.gitService || createGitService(),
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  // Use unified session context resolver for consistent auto-detection
  let sessionName: string;
  try {
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: params.task,
      repo: params.repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: !name, // Only allow auto-detection if no name provided
    });
    sessionName = resolvedContext.sessionName;
    log.debug("Session resolved", { sessionName, resolvedBy: resolvedContext.resolvedBy });
  } catch (error) {
    log.debug("Failed to resolve session", { error, name, task: params.task });
    if (error instanceof ValidationError) {
      throw new ValidationError(
        "Session name is required. Either provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }

  log.debug("Dependencies set up", {
    hasGitService: !!deps.gitService,
    hasSessionDB: !!deps.sessionDB,
  });

  log.debug("Session update requested", {
    sessionName,
    branch,
    remote,
    noStash,
    noPush,
    force,
  });

  try {
    // Get session record
    log.debug("Getting session record", { name: sessionName });
    let sessionRecord = await deps.sessionDB.getSession(sessionName);

    // TASK #168 FIX: Self-repair logic for orphaned sessions
    if (!sessionRecord && sessionName) {
      log.debug("Session not found in database, attempting self-repair", { sessionName });
      const currentDir = process.cwd();

      // Check if we're in a session workspace
      if (currentDir.includes("/sessions/") && currentDir.includes(sessionName)) {
        log.debug("Detected orphaned session workspace, attempting to register", {
          sessionName,
          currentDir,
        });

        try {
          // Get repository URL from git remote
          const remoteOutput = await deps.gitService.execInRepository(
            currentDir,
            "git remote get-url origin"
          );
          const repoUrl = remoteOutput.trim();

          // Extract repo name from URL or path
          const repoName = repoUrl.includes("/")
            ? repoUrl.split("/").pop()?.replace(".git", "") || "unknown"
            : "local-minsky";

          // Extract task ID from session name - simpler and more reliable approach
          const taskId = sessionName.startsWith("task#") ? sessionName : undefined;

          // Create session record
          const newSessionRecord: SessionRecord = {
            session: sessionName,
            repoName,
            repoUrl,
            createdAt: new Date().toISOString(),
            taskId,
            branch: sessionName,
          };

          await deps.sessionDB.addSession(newSessionRecord);
          sessionRecord = newSessionRecord;

          log.cli(`🔧 Self-repair: Registered orphaned session '${sessionName}' in database`);
        } catch (repairError) {
          log.warn("Failed to self-repair orphaned session", {
            sessionName,
            error: repairError instanceof Error ? repairError.message : String(repairError),
          });
        }
      }
    }

    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${sessionName}' not found`, "session", sessionName);
    }

    log.debug("Session record found", { sessionRecord });

    // Get session workdir
    const workdir = await deps.sessionDB.getSessionWorkdir(sessionName);
    log.debug("Session workdir resolved", { workdir });

    // Get current branch
    const currentBranch = await deps.gitService.getCurrentBranch(workdir);
    log.debug("Current branch", { currentBranch });

    // Validate current state if not forced
    if (!force) {
      const hasUncommittedChanges = await deps.gitService.hasUncommittedChanges(workdir);
      if (hasUncommittedChanges && !noStash) {
        log.debug("Stashing uncommitted changes", { workdir });
        await deps.gitService.stashChanges(workdir);
        log.debug("Changes stashed");
      }
    }

    try {
      // Pull latest changes
      log.debug("Pulling latest changes", { workdir, remote: remote || "origin" });
      await deps.gitService.pullLatest(workdir, remote || "origin");
      log.debug("Latest changes pulled");

      // Determine target branch for merge - use actual default branch from repo instead of hardcoding "main"
      const branchToMerge = branch || await deps.gitService.fetchDefaultBranch(workdir);
      const remoteBranchToMerge = `${remote || "origin"}/${branchToMerge}`;
      
      // Enhanced conflict detection and smart merge handling
      if (dryRun) {
        log.cli("🔍 Performing dry run conflict check...");
        
        const conflictPrediction = await ConflictDetectionService.predictConflicts(
          workdir, currentBranch, remoteBranchToMerge
        );
        
        if (conflictPrediction.hasConflicts) {
          log.cli("⚠️  Conflicts detected during dry run:");
          log.cli(conflictPrediction.userGuidance);
          log.cli("\n🛠️  Recovery commands:");
          conflictPrediction.recoveryCommands.forEach(cmd => log.cli(`   ${cmd}`));
          
          throw new MinskyError("Dry run detected conflicts. Use the guidance above to resolve them.");
        } else {
          log.cli("✅ No conflicts detected. Safe to proceed with update.");
          return {
            session: sessionName,
            repoName: sessionRecord.repoName || "unknown",
            repoUrl: sessionRecord.repoUrl,
            branch: currentBranch,
            createdAt: sessionRecord.createdAt,
            taskId: sessionRecord.taskId,
          };
        }
      }

      // Fix for origin/origin/main bug: Pass base branch name without origin/ prefix
      // ConflictDetectionService expects plain branch names and adds origin/ internally
      const normalizedBaseBranch = branchToMerge;

      // Use smart session update for enhanced conflict handling
      const updateResult = await ConflictDetectionService.smartSessionUpdate(
        workdir, 
        currentBranch, 
        normalizedBaseBranch,
        {
          skipIfAlreadyMerged,
          autoResolveConflicts: autoResolveDeleteConflicts
        }
      );

      if (!updateResult.updated && updateResult.skipped) {
        log.cli(`✅ ${updateResult.reason}`);
        
        if (updateResult.reason?.includes("already in base")) {
          log.cli("\n💡 Your session changes are already merged. You can create a PR with --skip-update:");
          log.cli("   minsky session pr --title \"Your PR title\" --skip-update");
        }
        
        return {
          session: sessionName,
          repoName: sessionRecord.repoName || "unknown", 
          repoUrl: sessionRecord.repoUrl,
          branch: currentBranch,
          createdAt: sessionRecord.createdAt,
          taskId: sessionRecord.taskId,
        };
      }

      if (!updateResult.updated && updateResult.conflictDetails) {
        // Enhanced conflict guidance
        log.cli("🚫 Update failed due to merge conflicts:");
        log.cli(updateResult.conflictDetails);
        
        if (updateResult.divergenceAnalysis) {
          const analysis = updateResult.divergenceAnalysis;
          log.cli("\n📊 Branch Analysis:");
          log.cli(`   • Session ahead: ${analysis.aheadCommits} commits`);
          log.cli(`   • Session behind: ${analysis.behindCommits} commits`);
          log.cli(`   • Recommended action: ${analysis.recommendedAction}`);
          
          if (analysis.sessionChangesInBase) {
            log.cli(`\n💡 Your changes appear to already be in ${branchToMerge}. Try:`);
            log.cli("   minsky session pr --title \"Your PR title\" --skip-update");
          }
        }
        
        throw new MinskyError(updateResult.conflictDetails);
      }

      log.debug("Enhanced merge completed successfully", { updateResult });

      // Push changes if needed
      if (!noPush) {
        log.debug("Pushing changes to remote", { workdir, remote: remote || "origin" });
        await deps.gitService.push({
          repoPath: workdir,
          remote: remote || "origin",
        });
        log.debug("Changes pushed to remote");
      }

      // Restore stashed changes if we stashed them
      if (!noStash) {
        try {
          log.debug("Restoring stashed changes", { workdir });
          await deps.gitService.popStash(workdir);
          log.debug("Stashed changes restored");
        } catch (error) {
          log.warn("Failed to restore stashed changes", {
            error: getErrorMessage(error),
            workdir,
          });
          // Don't fail the entire operation if stash pop fails
        }
      }

      log.cli(`Session '${sessionName}' updated successfully`);

      return {
        session: sessionName,
        repoName: sessionRecord.repoName || "unknown",
        repoUrl: sessionRecord.repoUrl,
        branch: currentBranch,
        createdAt: sessionRecord.createdAt,
        taskId: sessionRecord.taskId,
      };
    } catch (error) {
      // If there's an error during update, try to clean up any stashed changes
      if (!noStash) {
        try {
          await deps.gitService.popStash(workdir);
          log.debug("Restored stashed changes after error");
        } catch (stashError) {
          log.warn("Failed to restore stashed changes after error", {
            stashError: getErrorMessage(stashError),
          });
        }
      }
      throw error;
    }
  } catch (error) {
    log.error("Session update failed", {
      error: getErrorMessage(error),
      name: sessionName,
    });
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(
        `Failed to update session: ${getErrorMessage(error)}`,
        error
      );
    }
  }
}

/**
 * Helper function to check if a PR branch exists for a session
 */
async function checkPrBranchExists(
  sessionName: string,
  gitService: GitServiceInterface,
  currentDir: string
): Promise<boolean> {
  const prBranch = `pr/${sessionName}`;
  
  try {
    // Check if branch exists locally
    const localBranchOutput = await gitService.execInRepository(
      currentDir,
      `git show-ref --verify --quiet refs/heads/${prBranch} || echo "not-exists"`
    );
    const localBranchExists = localBranchOutput.trim() !== "not-exists";
    
    if (localBranchExists) {
      return true;
    }
    
    // Check if branch exists remotely
    const remoteBranchOutput = await gitService.execInRepository(
      currentDir,
      `git ls-remote --heads origin ${prBranch}`
    );
    const remoteBranchExists = remoteBranchOutput.trim().length > 0;
    
    return remoteBranchExists;
  } catch (error) {
    log.debug("Error checking PR branch existence", {
      error: getErrorMessage(error),
      prBranch,
      sessionName,
    });
    return false;
  }
}

/**
 * Helper function to extract title and body from existing PR branch
 */
async function extractPrDescription(
  sessionName: string,
  gitService: GitServiceInterface,
  currentDir: string
): Promise<{ title: string; body: string } | null> {
  const prBranch = `pr/${sessionName}`;
  
  try {
    // Try to get from remote first
    const remoteBranchOutput = await gitService.execInRepository(
      currentDir,
      `git ls-remote --heads origin ${prBranch}`
    );
    const remoteBranchExists = remoteBranchOutput.trim().length > 0;
    
    let commitMessage = "";
    
    if (remoteBranchExists) {
      // Fetch the PR branch to ensure we have latest
      await gitService.execInRepository(currentDir, `git fetch origin ${prBranch}`);
      
      // Get the commit message from the remote branch's last commit
      commitMessage = await gitService.execInRepository(
        currentDir,
        `git log -1 --pretty=format:%B origin/${prBranch}`
      );
    } else {
      // Check if branch exists locally
      const localBranchOutput = await gitService.execInRepository(
        currentDir,
        `git show-ref --verify --quiet refs/heads/${prBranch} || echo "not-exists"`
      );
      const localBranchExists = localBranchOutput.trim() !== "not-exists";
      
      if (localBranchExists) {
        // Get the commit message from the local branch's last commit
        commitMessage = await gitService.execInRepository(
          currentDir,
          `git log -1 --pretty=format:%B ${prBranch}`
        );
      } else {
        return null;
      }
    }
    
    // Parse the commit message to extract title and body
    const lines = commitMessage.trim().split("\n");
    const title = lines[0] || "";
    const body = lines.slice(1).join("\n").trim();
    
    return { title, body };
  } catch (error) {
    log.debug("Error extracting PR description", {
      error: getErrorMessage(error),
      prBranch,
      sessionName,
    });
    return null;
  }
}

/**
 * Interface-agnostic function for creating a PR for a session
 */
export async function sessionPrFromParams(params: SessionPrParams): Promise<{
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
      const zodError = error as any;
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
  const gitService = createGitService();
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
  const sessionDb = createSessionProvider();

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
  const prBranchExists = await checkPrBranchExists(sessionName, gitService, currentDir);
  
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

  try {
    // Execute git commands to merge the PR branch in the main repository
    // First, check out the base branch
    await deps.gitService.execInRepository(workingDirectory, `git checkout ${baseBranch}`);
    // Fetch latest changes
    await deps.gitService.execInRepository(workingDirectory, "git fetch origin");
    // Perform the fast-forward merge from local PR branch
    await deps.gitService.execInRepository(workingDirectory, `git merge --ff-only ${prBranch}`);

    // Get commit hash and date
    const commitHash = (
      await deps.gitService.execInRepository(workingDirectory, "git rev-parse HEAD")
    ).trim();
    const mergeDate = new Date().toISOString();
    const mergedBy = (
      await deps.gitService.execInRepository(workingDirectory, "git config user.name")
    ).trim();

    // Push the changes
    await deps.gitService.execInRepository(workingDirectory, `git push origin ${baseBranch}`);

    // Delete the PR branch from remote only if it exists there
    try {
      // Check if remote branch exists first
      await deps.gitService.execInRepository(
        workingDirectory,
        `git show-ref --verify --quiet refs/remotes/origin/${prBranch}`
      );
      // If it exists, delete it
      await deps.gitService.execInRepository(
        workingDirectory,
        `git push origin --delete ${prBranch}`
      );
    } catch (error) {
      // Remote branch doesn't exist, which is fine - just log it
      log.debug(`Remote PR branch ${prBranch} doesn't exist, skipping deletion`);
    }

    // Create merge info
    const mergeInfo = {
      session: sessionNameToUse,
      commitHash,
      mergeDate,
      mergedBy,
      baseBranch,
      prBranch,
      taskId,
    };

    // Update task status to DONE if we have a task ID
    if (taskId && deps.taskService.setTaskStatus) {
      try {
        await deps.taskService.setTaskStatus(taskId, TASK_STATUS.DONE);
        log.cli(`Updated task ${taskId} status to DONE`);
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
        typeof (taskService as any).getTaskSpecData === "function"
      ) {
        const taskSpec = await (taskService as any).getTaskSpecData(taskId);
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
