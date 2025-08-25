import { readFile } from "fs/promises";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import type { SessionPRParameters } from "../../domain/schemas";
import { log } from "../../utils/logger";
import { type GitServiceInterface } from "../git";
import { TASK_STATUS, TaskServiceInterface } from "../tasks";
import { createConfiguredTaskService } from "../tasks/taskService";
import type { SessionProviderInterface } from "../session";
import { updateSessionFromParams } from "../session";
import {
  checkPrBranchExistsOptimized,
  updatePrStateOnCreation,
  extractPrDescription,
} from "./session-update-operations";
import {
  createRepositoryBackendForSession,
  extractGitHubInfoFromUrl,
} from "./repository-backend-detection";
import {
  createRepositoryBackend,
  RepositoryBackendType,
  type RepositoryBackend,
  type RepositoryBackendConfig,
} from "../repository/index";
import type { SessionRecord } from "./types";

export interface SessionPrDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  createRepositoryBackend?: (sessionRecord: any) => Promise<any>;
}

/**
 * Create repository backend from session record's stored configuration
 * instead of auto-detecting from git remote
 */
export async function createRepositoryBackendFromSession(
  sessionRecord: SessionRecord
): Promise<RepositoryBackend> {
  // Determine backend type from session configuration
  let backendType: RepositoryBackendType;

  if (sessionRecord.backendType) {
    // Use explicitly set backend type
    switch (sessionRecord.backendType) {
      case "github":
        backendType = RepositoryBackendType.GITHUB;
        break;
      case "remote":
        backendType = RepositoryBackendType.REMOTE;
        break;
      case "local":
      default:
        backendType = RepositoryBackendType.LOCAL;
        break;
    }
  } else {
    // Infer backend type from repoUrl format for backward compatibility
    if (sessionRecord.repoUrl.startsWith("/") || sessionRecord.repoUrl.startsWith("file://")) {
      backendType = RepositoryBackendType.LOCAL;
    } else if (sessionRecord.repoUrl.includes("github.com")) {
      backendType = RepositoryBackendType.GITHUB;
    } else {
      backendType = RepositoryBackendType.REMOTE;
    }
  }

  const config: RepositoryBackendConfig = {
    type: backendType,
    repoUrl: sessionRecord.repoUrl,
  };

  // Add GitHub-specific configuration by parsing from URL
  if (backendType === RepositoryBackendType.GITHUB) {
    const githubInfo = extractGitHubInfoFromUrl(sessionRecord.repoUrl);
    if (githubInfo) {
      config.github = {
        owner: githubInfo.owner,
        repo: githubInfo.repo,
      };
    }
  }

  return await createRepositoryBackend(config);
}

/**
 * Implementation of session PR creation operation
 * Updated to use repository backends for automatic workflow selection
 */
export async function sessionPrImpl(
  params: SessionPRParameters,
  deps: SessionPrDependencies,
  options?: {
    interface?: "cli" | "mcp";
    workingDirectory?: string;
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

  // STEP 0.5: Body validation (domain-level safety)
  // Ensure new PRs provide a description before any workspace-specific checks
  if (!params.body && !params.bodyPath) {
    throw new ValidationError(
      "PR description is required for new pull request creation. Provide --body or --body-path."
    );
  }

  // STEP 1: Validate we're in a session workspace and on a session branch (CLI only)
  const currentDir = options?.workingDirectory || process.cwd();
  const interfaceType = options?.interface || "cli";

  // Only validate workspace for CLI interface
  if (interfaceType === "cli") {
    const isSessionWorkspace = currentDir.includes("/sessions/");
    if (!isSessionWorkspace) {
      throw new MinskyError(
        "session pr command must be run from within a session workspace. Use 'minsky session start' first."
      );
    }
  }

  // Get current git branch
  const currentBranch = await deps.gitService.getCurrentBranch(currentDir);

  // STEP 2: Ensure we're NOT on a PR branch (should fail if on pr/* branch)
  if (currentBranch.startsWith("pr/")) {
    throw new MinskyError(
      `Cannot run session pr from PR branch '${currentBranch}'. Switch to your session branch first.`
    );
  }

  // STEP 3: Determine session name from explicit parameter or directory (CLI only)
  let sessionName = params.session;

  // For CLI interface, try to extract session name from directory if not explicitly provided
  if (!sessionName && interfaceType === "cli") {
    const pathParts = currentDir.split("/");
    const sessionsIndex = pathParts.indexOf("sessions");
    sessionName = sessionsIndex >= 0 ? pathParts[sessionsIndex + 1] : undefined;
  }

  if (!sessionName) {
    const errorMessage =
      interfaceType === "mcp"
        ? "Session parameter is required for MCP interface. Please provide session name or task ID."
        : "Could not determine session name from current directory or parameters";
    throw new MinskyError(errorMessage);
  }

  // STEP 4: Check for uncommitted changes
  const hasUncommittedChanges = await deps.gitService.hasUncommittedChanges(currentDir);
  if (hasUncommittedChanges) {
    // Get the status of uncommitted changes to show in the error
    let statusInfo = "";
    try {
      const status = await deps.gitService.getStatus(currentDir);
      const changes: string[] = [];

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
      statusInfo = "Could not retrieve file status";
    }

    throw new MinskyError(
      `Cannot create PR with uncommitted changes. Please commit your changes first.\n\n${statusInfo}\n\n💡 To commit your changes:\n   git add -A\n   git commit -m "Your commit message"`
    );
  }

  // STEP 5: Load PR title and body
  let titleToUse = params.title;
  let bodyToUse = params.body;

  // Load body from file if specified
  if (params.bodyPath) {
    try {
      const fileContent = await readFile(params.bodyPath, "utf-8");
      bodyToUse = fileContent.toString();
      log.debug("Loaded PR body from file", { bodyPath: params.bodyPath });
    } catch (error) {
      throw new MinskyError(`Failed to read PR body from file: ${getErrorMessage(error)}`);
    }
  }

  // Enhanced validation and description extraction for missing title/body
  if (!titleToUse || !bodyToUse) {
    try {
      const prDescription = await extractPrDescription(sessionName, deps.gitService, currentDir);

      if (prDescription) {
        titleToUse = titleToUse || prDescription.title;
        bodyToUse = bodyToUse || prDescription.body;
      }
    } catch (error) {
      log.debug("Could not extract existing PR description", { error: getErrorMessage(error) });
    }

    if (!titleToUse) {
      throw new MinskyError(
        `
⚠️  Missing PR Title

Please provide a title for your pull request:

📋 Examples:
   minsky session pr --title "feat: Add new feature"
   minsky session pr --title "fix: Bug fix"
   minsky session pr --title "docs: Update documentation"

💡 Or use conventional commit format with task ID:
   minsky session pr --title "feat(#123): Add user authentication"
   minsky session pr --title "fix(#456): Resolve API timeout issue"
      `.trim()
      );
    }
  }

  // STEP 6: Enhanced session update with automatic conflict detection
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
      skipIfAlreadyMerged: true, // Automatically skip if changes already merged
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
      log.cli("⚠️  Merge conflicts detected. Please resolve conflicts manually:");
      log.cli("   1. 🔍 Check conflicts: git status");
      log.cli("   2. ✏️ Resolve conflicts manually in your editor");
      log.cli("   3. 📝 Stage resolved files: git add <resolved-files>");
      log.cli("   4. ✅ Commit resolution: git commit");
      log.cli("   5. 🔄 Try PR creation again");
      log.cli("");
      log.cli("💡 Or use automatic conflict resolution:");
      log.cli("   • --auto-resolve-delete-conflicts: Auto-resolve delete/modify conflicts");
      throw new MinskyError(`Failed to update session before creating PR: ${errorMessage}`);
    } else {
      throw new MinskyError(`Failed to update session before creating PR: ${errorMessage}`);
    }
  }

  // STEP 7: Create repository backend and delegate PR creation
  try {
    log.cli("🔍 Creating repository backend...");

    // Get session record to use stored repository configuration
    const sessionRecord = await deps.sessionDB.getSession(sessionName);

    let repositoryBackend: any;

    if (deps.createRepositoryBackend) {
      // Use provided backend factory
      repositoryBackend = await deps.createRepositoryBackend(sessionName);
    } else if (sessionRecord?.repoUrl) {
      // Use session record's stored repository configuration (preferred)
      log.cli("📋 Using session repository configuration...");
      repositoryBackend = await createRepositoryBackendFromSession(sessionRecord);
    } else {
      // Fall back to auto-detection from git remote
      log.cli("🔍 Auto-detecting repository backend...");
      repositoryBackend = await createRepositoryBackendForSession(currentDir);
    }

    // STEP 7.5: Validate and sanitize PR content for title duplication
    const { preparePrContent } = await import("./pr-validation");
    const preparedContent = preparePrContent(titleToUse, bodyToUse || "");

    // Log warnings about any sanitization that occurred
    if (preparedContent.warnings.length > 0) {
      preparedContent.warnings.forEach((warning) => log.warn(`PR Content Warning: ${warning}`));
    }

    // Use repository backend to create pull request
    const baseBranch = params.baseBranch || "main";
    const prInfo = await repositoryBackend.createPullRequest(
      preparedContent.title,
      preparedContent.body,
      currentBranch,
      baseBranch,
      sessionName,
      params.draft || false
    );

    log.cli(`✅ Pull request created successfully!`);

    // PR state persistence is handled by repository backends (local backend updates commit hash)

    // Update task status to IN-REVIEW if associated with a task
    if (!params.noStatusUpdate) {
      if (sessionRecord?.taskId) {
        try {
          const taskService = await createConfiguredTaskService({
            workspacePath: process.cwd(),
          });
          await taskService.setTaskStatus(sessionRecord.taskId, TASK_STATUS.IN_REVIEW);
          log.cli(`Updated task ${sessionRecord.taskId} status to IN-REVIEW`);
        } catch (error) {
          log.warn(`Failed to update task status: ${getErrorMessage(error)}`);
        }
      }
    }

    // Determine correct branch format based on backend type
    let prBranchName: string;
    if (sessionRecord?.backendType === "github") {
      // GitHub backend uses session branch directly
      prBranchName = sessionName;
    } else {
      // Local/remote backends use pr/ prefix format
      prBranchName = typeof prInfo.number === "string" ? prInfo.number : `pr/${prInfo.number}`;
    }

    return {
      prBranch: prBranchName,
      baseBranch,
      title: titleToUse,
      body: bodyToUse,
    };
  } catch (error) {
    throw new MinskyError(`Failed to create pull request: ${getErrorMessage(error as any)}`);
  }
}
