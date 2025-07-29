import { readFile } from "fs/promises";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import type { SessionPRParameters } from "../../domain/schemas";
import { log } from "../../utils/logger";
import { type GitServiceInterface, preparePrFromParams } from "../git";
import { TASK_STATUS, TaskService } from "../tasks";
import type { SessionProviderInterface } from "../session";
import { updateSessionFromParams } from "../session";
import {
  checkPrBranchExistsOptimized,
  updatePrStateOnCreation,
  extractPrDescription,
} from "./session-update-operations";

export interface SessionPrDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
}

/**
 * Implementation of session PR creation operation
 * Extracted from session.ts for better maintainability
 */
export async function sessionPrImpl(
  params: SessionPRParameters,
  deps: SessionPrDependencies
): Promise<{
  prBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
}> {
  // STEP 0: Validate parameters using schema
  try {
    // Import schema here to avoid circular dependency issues
    const { SessionPRParametersSchema } = await import("../../domain/schemas");
    SessionPRParametersSchema.parse(params);
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
  const currentBranch = await deps.gitService.getCurrentBranch(currentDir);

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
  const hasUncommittedChanges = await deps.gitService.hasUncommittedChanges(currentDir);
  if (hasUncommittedChanges) {
    // Get the status of uncommitted changes to show in the error
    let statusInfo = "";
    try {
      const status = await deps.gitService.getStatus(currentDir);
      const changes = [];

      if (status.modified.length > 0) {
        changes.push(`📝 Modified files (${status.modified.length}):`);
        status.modified.forEach((file: string) => changes.push(`   ${file}`));
      }

      if (status.untracked.length > 0) {
        changes.push(`📄 New files (${status.untracked.length}):`);
        status.untracked.forEach((file: string) => changes.push(`   ${file}`));
      }

      if (status.deleted.length > 0) {
        changes.push(`🗑️  Deleted files (${status.deleted.length}):`);
        status.deleted.forEach((file: string) => changes.push(`   ${file}`));
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
  let bodyContent: string | undefined = params.body;
  if (params.bodyPath) {
    try {
      // Resolve relative paths relative to current working directory
      const filePath = require("path").resolve(params.bodyPath);
      const fileContent = await readFile(filePath, "utf-8");
      bodyContent = typeof fileContent === "string" ? fileContent : fileContent.toString();

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
        throw new ValidationError(`Failed to read body file: ${params.bodyPath}. ${errorMessage}`);
      }
    }
  }

  // Determine the session name
  let sessionName = params.session;

  // If no session name provided but task ID is, try to find the session by task ID
  if (!sessionName && params.task) {
    const taskId = params.task;
    const sessionRecord = await deps.sessionDB.getSessionByTaskId(taskId);
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
    bodySource: params.bodyPath ? "file" : params.body ? "parameter" : "none",
    baseBranch: params.baseBranch,
  });

  // STEP 4.5: PR Branch Detection and Title/Body Handling
  // This implements the new refresh functionality
  const prBranchExists = await checkPrBranchExistsOptimized(
    sessionName,
    deps.gitService,
    currentDir,
    deps.sessionDB
  );

  let titleToUse = params.title;
  let bodyToUse = bodyContent;

  if (!titleToUse && prBranchExists) {
    // Case: Existing PR + no title → Auto-reuse existing title/body (refresh)
    const hasNewBodyContent = !!(params.body || params.bodyPath);

    if (hasNewBodyContent) {
      log.cli("🔄 Refreshing existing PR (reusing title, using new body)...");
    } else {
      log.cli("🔄 Refreshing existing PR (reusing title and body)...");
    }

    const existingDescription = await extractPrDescription(
      sessionName,
      deps.gitService,
      currentDir
    );
    if (existingDescription) {
      titleToUse = existingDescription.title;
      // Only reuse existing body if user didn't provide new body content
      if (!hasNewBodyContent) {
        bodyToUse = existingDescription.body;
      }
      log.cli(`📝 Reusing existing title: "${titleToUse}"`);
      if (hasNewBodyContent) {
        log.cli(`📝 Using new body content from ${params.bodyPath ? "--body-path" : "--body"}`);
      }
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
    const hasNewBodyContent = !!(params.body || params.bodyPath);
    if (hasNewBodyContent) {
      log.cli("📝 Updating existing PR with new title and body...");
    } else {
      log.cli("📝 Updating existing PR with new title (keeping existing body)...");
      // If no new body provided, try to keep existing body
      const existingDescription = await extractPrDescription(
        sessionName,
        deps.gitService,
        currentDir
      );
      if (existingDescription && !bodyToUse) {
        bodyToUse = existingDescription.body;
        log.cli("📝 Preserving existing PR body");
      }
    }
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
      // BUG FIX: Require body/bodyPath for new PRs instead of just showing a tip
      throw new ValidationError(
        `PR description is required for new pull requests. Please provide one of:
  --body <text>       Direct PR body text
  --body-path <path>  Path to file containing PR body

Example:
  minsky session pr --title "feat: Add new feature" --body "This PR adds..."
  minsky session pr --title "fix: Bug fix" --body-path process/tasks/189/pr.md`
      );
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
        log.cli(
          "💡 Your session changes are already in the base branch. Proceeding with PR creation..."
        );
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
  await updatePrStateOnCreation(sessionName, deps.sessionDB);

  // Update task status to IN-REVIEW if associated with a task
  if (!params.noStatusUpdate) {
    const sessionRecord = await deps.sessionDB.getSession(sessionName);
    if (sessionRecord?.taskId) {
      try {
        const taskService = new TaskService({
          workspacePath: process.cwd(),
          backend: "markdown",
        });
        await taskService.setTaskStatus(sessionRecord.taskId, TASK_STATUS.IN_REVIEW);
        log.cli(`Updated task #${sessionRecord.taskId} status to IN-REVIEW`);
      } catch (error) {
        log.warn(`Failed to update task status: ${getErrorMessage(error)}`);
      }
    }
  }

  return result;
}
