import { readFile } from "fs/promises";
import { MinskyError, ValidationError, getErrorMessage } from "../../errors/index";
import type { SessionPRParameters } from "../../domain/schemas";
import { log } from "../../utils/logger";
import { type GitServiceInterface } from "../git";
import { TASK_STATUS } from "../tasks";
import type { TaskServiceInterface } from "../tasks/taskService";
import type { SessionProviderInterface } from "../session";
import { updateSessionImpl, extractPrDescription } from "./session-update-operations";
import {
  createRepositoryBackendFromSessionUrl,
  getRepositoryBackendFromConfig,
  extractGitHubInfoFromUrl,
} from "./repository-backend-detection";

import {
  createRepositoryBackend,
  RepositoryBackendType,
  type RepositoryBackend,
  type RepositoryBackendConfig,
} from "../repository/index";
import type { SessionRecord } from "./types";
import { assertSessionMutable } from "./session-mutability";
import type { PersistenceProvider, SqlCapablePersistenceProvider } from "../persistence/types";
import { ProvenanceService, computePreliminaryTier } from "../provenance/provenance-service";

export interface SessionPrDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  createRepositoryBackend?: (sessionRecord: string) => Promise<RepositoryBackend>;
  persistenceProvider?: PersistenceProvider;
  taskService?: TaskServiceInterface;
}

/**
 * Create repository backend from session record's stored configuration.
 * Only GitHub is supported; all sessions use the GitHub backend.
 */
export async function createRepositoryBackendFromSession(
  sessionRecord: SessionRecord,
  sessionDB: SessionProviderInterface
): Promise<RepositoryBackend> {
  const config: RepositoryBackendConfig = {
    type: RepositoryBackendType.GITHUB,
    repoUrl: sessionRecord.repoUrl,
  };

  // Parse GitHub owner/repo from URL
  const githubInfo = extractGitHubInfoFromUrl(sessionRecord.repoUrl);
  if (githubInfo) {
    config.github = {
      owner: githubInfo.owner,
      repo: githubInfo.repo,
    };
  }

  return await createRepositoryBackend(config, sessionDB);
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
  url?: string;
}> {
  // STEP 0: Validate parameters using schema
  try {
    // Import schema here to avoid circular dependency issues
    const { SessionPRParametersSchema } = await import("../../domain/schemas");
    SessionPRParametersSchema.parse(params);
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      // Extract the validation error message from ZodError
      const zodError = error as { errors?: Array<{ message: string }> };
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

  // STEP 3: Determine session ID from explicit parameter or directory (CLI only)
  let sessionId = params.session;

  // For CLI interface, try to extract session ID from directory if not explicitly provided
  if (!sessionId && interfaceType === "cli") {
    const pathParts = currentDir.split("/");
    const sessionsIndex = pathParts.indexOf("sessions");
    sessionId = sessionsIndex >= 0 ? pathParts[sessionsIndex + 1] : undefined;
  }

  if (!sessionId) {
    const errorMessage =
      interfaceType === "mcp"
        ? "Session parameter is required for MCP interface. Please provide session ID or task ID."
        : "Could not determine session ID from current directory or parameters";
    throw new MinskyError(errorMessage);
  }

  // STEP 3.5: Enforce merged-PR-freeze invariant
  const existingRecordForFreeze = await deps.sessionDB.getSession(sessionId);
  if (existingRecordForFreeze) {
    assertSessionMutable(existingRecordForFreeze, "create a pull request");
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
      const prDescription = await extractPrDescription(
        sessionId,
        deps.gitService,
        currentDir,
        deps.sessionDB
      );

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
    // Use enhanced update with conflict detection options — pass deps through
    // so updateSessionImpl doesn't try to create its own sessionProvider.
    await updateSessionImpl(
      {
        name: sessionId,
        repo: params.repo,
        json: false,
        force: false,
        noStash: false,
        noPush: false,
        dryRun: false,
        skipConflictCheck: params.skipConflictCheck,
        autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
        skipIfAlreadyMerged: true, // Automatically skip if changes already merged
      } as import("../schemas").SessionUpdateParameters,
      {
        sessionDB: deps.sessionDB,
        gitService: deps.gitService,
        getCurrentSession: async () => undefined,
      }
    );
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
    const sessionRecord = await deps.sessionDB.getSession(sessionId);

    let repositoryBackend: RepositoryBackend;

    if (deps.createRepositoryBackend) {
      // Use provided backend factory
      repositoryBackend = await deps.createRepositoryBackend(sessionId);
    } else if (sessionRecord?.repoUrl) {
      // Use session record's stored repository configuration (preferred)
      log.cli("📋 Using session repository configuration...");
      repositoryBackend = await createRepositoryBackendFromSession(sessionRecord, deps.sessionDB);
    } else {
      // Fall back to config-based detection (session missing repoUrl)
      log.warn(
        "Session record has no repoUrl; falling back to config-based detection. " +
          "Re-run 'minsky init' to write repository config and avoid this warning."
      );
      const { repoUrl: fallbackRepoUrl } = await getRepositoryBackendFromConfig();
      repositoryBackend = await createRepositoryBackendFromSessionUrl(
        fallbackRepoUrl,
        currentDir,
        deps.sessionDB
      );
    }

    // STEP 7.5: Validate and sanitize PR content for title duplication
    const { preparePrContent } = await import("./pr-validation");
    const preparedContent = preparePrContent(titleToUse, bodyToUse || "");

    // Log warnings about any sanitization that occurred
    if (preparedContent.warnings.length > 0) {
      preparedContent.warnings.forEach((warning) => log.warn(`PR Content Warning: ${warning}`));
    }

    // Compute authorship tier from static signals for label application
    const authorshipTier = computePreliminaryTier({
      taskOrigin: "human", // default: human-dispatched sessions
      specAuthorship: "mixed", // default: mixed authorship
      initiationMode: "dispatched", // all current sessions are human-dispatched
    });

    // Use repository backend to create pull request (includes authorship label)
    const baseBranch = params.baseBranch || "main";
    const prInfo = await repositoryBackend.pr.create({
      title: preparedContent.title,
      body: preparedContent.body,
      sourceBranch: currentBranch,
      baseBranch,
      session: sessionId,
      draft: params.draft || false,
      authorshipTier,
    });

    log.cli(`✅ Pull request created successfully!`);

    // PR state persistence is handled by repository backends

    // Record provenance for the created PR (non-fatal — failures log and continue)
    if (deps.persistenceProvider) {
      try {
        const provider = deps.persistenceProvider as SqlCapablePersistenceProvider;
        if (provider.getDatabaseConnection) {
          const db = await provider.getDatabaseConnection();
          if (db) {
            const provenanceService = new ProvenanceService(db);
            await provenanceService.createProvenanceRecord({
              artifactId: String(prInfo.number),
              artifactType: "pr",
              taskId: sessionRecord?.taskId ?? undefined,
              sessionId,
              taskOrigin: "human",
              specAuthorship: "mixed",
              initiationMode: "dispatched",
              participants: [],
            });
            log.debug(`Recorded provenance for PR #${prInfo.number}`);
          }
        }
      } catch (provenanceError) {
        log.warn(
          `Failed to record provenance for PR #${prInfo.number}: ${getErrorMessage(provenanceError)}`
        );
      }
    }

    // Update task status to IN-REVIEW if associated with a task
    if (!params.noStatusUpdate) {
      if (sessionRecord?.taskId) {
        try {
          if (deps.taskService) {
            await deps.taskService.setTaskStatus(sessionRecord.taskId, TASK_STATUS.IN_REVIEW);
          } else {
            log.warn("No taskService in deps — skipping status update to IN-REVIEW");
          }
          log.cli(`Updated task ${sessionRecord.taskId} status to IN-REVIEW`);
        } catch (error) {
          log.warn(`Failed to update task status: ${getErrorMessage(error)}`);
        }
      }
    }

    // GitHub backend uses the actual git branch (task/mt-NNN), not the session UUID
    const prBranchName = currentBranch;

    return {
      prBranch: prBranchName,
      baseBranch,
      title: titleToUse,
      body: bodyToUse,
      url: prInfo.url, // Include PR URL from repository backend
    };
  } catch (error) {
    throw new MinskyError(`Failed to create pull request: ${getErrorMessage(error)}`);
  }
}
