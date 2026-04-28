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
 * Verifiable receipt for the IN-PROGRESS → IN-REVIEW transition that
 * `session_pr_create` attempts after PR creation.
 *
 * Returned on every PR-create call so the caller can disambiguate four cases
 * that previously all collapsed into `{success: true}` with the status write
 * silently logged-as-warn (mt#1378):
 *
 * - `succeeded=true`                       — the transition ran and stuck.
 * - `succeeded=false, reason="skipped: noStatusUpdate"`
 *                                          — caller opted out via param.
 * - `succeeded=false, reason="skipped: no taskId on session"`
 *                                          — session is not task-bound.
 * - `succeeded=false, reason="skipped: no taskService in deps"`
 *                                          — DI bundle is missing the dep.
 * - `succeeded=false, reason="setTaskStatus threw: <msg>"`
 *                                          — write was attempted and failed;
 *                                            the PR was still created.
 *
 * `from`/`to` are populated only when a transition was actually attempted
 * (so the caller can tell "tried and failed" from "skipped"). Reading
 * `from` uses `taskService.getTaskStatus` BEFORE the write so the receipt
 * reflects the pre-transition state, not the post-transition state.
 */
export interface StatusTransitionReceipt {
  from: string | null;
  to: string | null;
  succeeded: boolean;
  reason?: string;
}

/**
 * Compute and apply the post-PR-create IN-REVIEW status transition. Returns
 * a verifiable receipt describing exactly what happened — distinguishing
 * skip cases (caller opt-out, no taskId, no taskService) from attempted
 * transitions (success or write failure).
 *
 * Extracted from `sessionPrImpl` for direct unit testing (mt#1378). The
 * pre-mt#1378 implementation collapsed all skip/failure paths into a
 * single `log.warn` and a misleading `log.cli("Updated task ...")` that
 * fired even when no update happened.
 *
 * Exported for tests.
 */
export async function applyInReviewTransition(
  noStatusUpdate: boolean | undefined,
  taskId: string | undefined | null,
  taskService: TaskServiceInterface | undefined
): Promise<StatusTransitionReceipt> {
  if (noStatusUpdate) {
    return {
      from: null,
      to: null,
      succeeded: false,
      reason: "skipped: noStatusUpdate",
    };
  }
  if (!taskId) {
    return {
      from: null,
      to: null,
      succeeded: false,
      reason: "skipped: no taskId on session",
    };
  }
  if (!taskService) {
    log.warn("No taskService in deps — skipping status update to IN-REVIEW");
    return {
      from: null,
      to: null,
      succeeded: false,
      reason: "skipped: no taskService in deps",
    };
  }

  // Read pre-transition status so the receipt reflects the from-state
  // accurately even if the write succeeds and changes it. Failing to
  // read is non-fatal — we still attempt the write.
  let fromStatus: string | null = null;
  try {
    const current = await taskService.getTaskStatus(taskId);
    fromStatus = current ?? null;
  } catch (readError) {
    log.warn(`Failed to read prior task status for ${taskId}: ${getErrorMessage(readError)}`);
  }

  try {
    await taskService.setTaskStatus(taskId, TASK_STATUS.IN_REVIEW);
    // Only log success on the success path. Pre-mt#1378 this fired
    // unconditionally and lied when the write was skipped or failed.
    log.cli(`Updated task ${taskId} status to IN-REVIEW`);
    return {
      from: fromStatus,
      to: TASK_STATUS.IN_REVIEW,
      succeeded: true,
    };
  } catch (writeError) {
    const reason = `setTaskStatus threw: ${getErrorMessage(writeError)}`;
    log.warn(`Failed to update task status: ${getErrorMessage(writeError)}`);
    return {
      from: fromStatus,
      to: TASK_STATUS.IN_REVIEW,
      succeeded: false,
      reason,
    };
  }
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
  statusTransition: StatusTransitionReceipt;
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
  let sessionId = params.sessionId ?? params.session;

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
    //
    // mt#1281: must be `sessionId`, not `name` — the receiving schema
    // (`SessionUpdateParameters`) defines the field as `sessionId`. The prior
    // `name:` form was silently dropped by the type cast, leaving the
    // resolver inside `updateSessionImpl` to throw "Session ID is required"
    // on every PR create.
    const updateParams: import("../schemas").SessionUpdateParameters = {
      sessionId,
      repo: params.repo,
      branch: undefined,
      remote: undefined,
      force: false,
      noStash: false,
      noPush: false,
      dryRun: false,
      skipConflictCheck: params.skipConflictCheck ?? false,
      autoResolveDeleteConflicts: params.autoResolveDeleteConflicts ?? false,
      // In PR-create context: must merge even when session files appear in base, because sibling
      // PRs may have committed identical compile artifacts. Setting true causes phantom conflicts
      // on GitHub merge — see mt#1334.
      skipIfAlreadyMerged: false,
    };
    await updateSessionImpl(updateParams, {
      sessionDB: deps.sessionDB,
      gitService: deps.gitService,
      getCurrentSession: async () => undefined,
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

    // Apply the IN-REVIEW transition and capture a verifiable receipt for
    // every code path so callers can detect skipped or failed transitions
    // instead of inferring success from a silent log.warn (mt#1378).
    const statusTransition = await applyInReviewTransition(
      params.noStatusUpdate,
      sessionRecord?.taskId,
      deps.taskService
    );

    // GitHub backend uses the actual git branch (task/mt-NNN), not the session UUID
    const prBranchName = currentBranch;

    return {
      prBranch: prBranchName,
      baseBranch,
      title: titleToUse,
      body: bodyToUse,
      url: prInfo.url, // Include PR URL from repository backend
      statusTransition,
    };
  } catch (error) {
    throw new MinskyError(`Failed to create pull request: ${getErrorMessage(error)}`);
  }
}
