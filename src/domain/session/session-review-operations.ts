import { ResourceNotFoundError, ValidationError, getErrorMessage } from "../../errors/index";
import { taskIdSchema as TaskIdSchema } from "../../schemas/common";
import { log } from "../../utils/logger";
import { type GitServiceInterface } from "../git";
import { createRepositoryBackend, RepositoryBackendType } from "../repository/index";
import { type TaskServiceInterface } from "../tasks";
import { type WorkspaceUtilsInterface } from "../workspace";
import { type SessionProviderInterface } from "./session-db-adapter";

// Import changeset abstraction for enhanced review capabilities
import { createChangesetService } from "../changeset/changeset-service";
import type { ChangesetDetails } from "../changeset/adapter-interface";

/**
 * Interface for session review parameters
 */
export interface SessionReviewParams {
  sessionId?: string;
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
  // Enhanced with changeset abstraction data
  changeset?: ChangesetDetails;
  platform?: string;
  /** Warnings from data-gathering steps that failed non-fatally */
  warnings?: string[];
}

/**
 * Dependencies required by sessionReviewImpl
 */
export interface SessionReviewDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  taskService: TaskServiceInterface & {
    getTaskSpecData?: (taskId: string) => Promise<string>;
  };
  workspaceUtils: WorkspaceUtilsInterface;
  getCurrentSession: (repoPath: string) => Promise<string | undefined>;
}

/**
 * Reviews a session PR by gathering and displaying relevant information
 */
export async function sessionReviewImpl(
  params: SessionReviewParams,
  deps: SessionReviewDependencies
): Promise<SessionReviewResult> {
  let sessionIdToUse = params.sessionId;
  let taskId: string | undefined;

  // Try to get session from task ID if provided
  if (params.task && !sessionIdToUse) {
    const taskIdToUse = TaskIdSchema.parse(params.task);
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
    sessionIdToUse = session.session;
  }

  // If session is still not set, try to detect it from repo path
  if (!sessionIdToUse && params.repo) {
    try {
      const sessionContext = await deps.getCurrentSession(params.repo);
      if (sessionContext) {
        sessionIdToUse = sessionContext;
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
  if (!sessionIdToUse) {
    try {
      const currentDir = process.cwd();
      const sessionContext = await deps.getCurrentSession(currentDir);
      if (sessionContext) {
        sessionIdToUse = sessionContext;
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
  if (!sessionIdToUse) {
    throw new ValidationError("No session detected. Please provide a session ID or task ID");
  }

  // Get the session record
  const sessionRecord = await deps.sessionDB.getSession(sessionIdToUse);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(
      `Session "${sessionIdToUse}" not found`,
      "session",
      sessionIdToUse
    );
  }

  // If no taskId from params, use the one from session record
  if (!taskId && sessionRecord.taskId) {
    taskId = sessionRecord.taskId;
  }

  // Get session workdir
  const sessionWorkdir = await deps.sessionDB.getSessionWorkdir(sessionIdToUse);

  // Track warnings from non-fatal data-gathering failures
  const warnings: string[] = [];

  // Initialize result (prBranch/baseBranch will be filled from backend details when available)
  const result: SessionReviewResult = {
    session: sessionIdToUse,
    taskId,
    prBranch: params.prBranch || `pr/${sessionRecord.branch || sessionIdToUse}`,
    baseBranch: "main",
  };

  // 1. Get task specification if available
  if (taskId) {
    try {
      const taskService = deps.taskService;

      // Check if taskService has getTaskSpecData method dynamically
      if ("getTaskSpecData" in taskService && typeof taskService.getTaskSpecData === "function") {
        const taskSpec = await taskService.getTaskSpecData(taskId);
        result.taskSpec = taskSpec;
      } else {
        log.debug("Task service does not support getTaskSpecData method");
      }
    } catch (error) {
      const msg = `Could not retrieve task specification for ${taskId}: ${getErrorMessage(error)}`;
      log.debug(msg);
      warnings.push(msg);
    }
  }

  // 2. Get changeset details using changeset abstraction (ENHANCED)
  let changesetOrBackendSucceeded = false;
  try {
    // Create changeset service for unified changeset operations
    const changesetService = await createChangesetService(sessionRecord.repoUrl, sessionWorkdir);

    // Determine changeset ID from session context
    // Try different possible changeset identifiers
    const possibleChangesetIds = [
      result.prBranch, // pr/session-id format
      sessionIdToUse, // session ID directly
      `${sessionIdToUse}`, // session ID as string
    ];

    let changesetDetails: ChangesetDetails | null = null;
    let changesetId: string | undefined;

    // Try to find the changeset by different ID formats
    for (const id of possibleChangesetIds) {
      try {
        const details = await changesetService.getDetails(id);
        if (details) {
          changesetDetails = details;
          changesetId = id;
          break;
        }
      } catch (error) {
        // Continue trying other IDs
        log.debug(`Changeset not found with ID: ${id}`, { error: getErrorMessage(error) });
      }
    }

    if (changesetDetails) {
      // Use changeset abstraction data as primary source
      result.changeset = changesetDetails;
      result.platform = await changesetService.getPlatform();
      changesetOrBackendSucceeded = true;

      // Update result with changeset data
      if (changesetDetails.sourceBranch) result.prBranch = changesetDetails.sourceBranch;
      if (changesetDetails.targetBranch) result.baseBranch = changesetDetails.targetBranch;
      result.prDescription = changesetDetails.description;

      // Use changeset diff stats if available
      if (changesetDetails.diffStats) {
        result.diffStats = {
          filesChanged: changesetDetails.diffStats.filesChanged,
          insertions: changesetDetails.diffStats.additions,
          deletions: changesetDetails.diffStats.deletions,
        };
      }

      // Use changeset full diff if available
      if (changesetDetails.fullDiff) {
        result.diff = changesetDetails.fullDiff;
      }

      log.debug("Successfully integrated changeset data", {
        changesetId,
        platform: result.platform,
        filesChanged: changesetDetails.diffStats?.filesChanged,
        reviewsCount: changesetDetails.reviews?.length || 0,
      });
    } else {
      log.debug("No changeset found, falling back to repository backend methods");

      // Fallback to repository backend approach — GitHub only
      const backend = await createRepositoryBackend(
        {
          type: RepositoryBackendType.GITHUB,
          repoUrl: sessionRecord.repoUrl,
        },
        deps.sessionDB
      );

      // Fetch PR details; if GitHub, backend infers PR number from session
      const details = await backend.pr.get({ session: sessionIdToUse });
      if (details) {
        if (details.headBranch) result.prBranch = details.headBranch;
        if (details.baseBranch) result.baseBranch = details.baseBranch;
        result.prDescription = details.body;
        changesetOrBackendSucceeded = true;
      }

      // Fetch diff
      const diffInfo = await backend.pr.getDiff({ session: sessionIdToUse });
      if (diffInfo) {
        result.diff = diffInfo.diff;
        if (diffInfo.stats) {
          result.diffStats = diffInfo.stats;
        }
        changesetOrBackendSucceeded = true;
      }
    }
  } catch (error) {
    const msg = `Changeset/repository backend lookup failed: ${getErrorMessage(error)}`;
    log.debug(msg, {
      session: sessionIdToUse,
      repoUrl: sessionRecord.repoUrl,
      backendType: sessionRecord.backendType,
    });
    warnings.push(msg);
  }

  // 3. Direct git fallback: if neither changeset nor repository backend produced diff content,
  //    fall back to running git commands directly against the session workdir.
  if (!result.diff && !changesetOrBackendSucceeded) {
    log.debug("Using direct git fallback for diff content");
    try {
      const gitService = deps.gitService;
      const prBranchToUse = result.prBranch;
      const baseBranch = result.baseBranch;

      // Try to determine the actual current branch in the workdir
      let currentBranch: string | undefined;
      try {
        currentBranch = await gitService.getCurrentBranch(sessionWorkdir);
      } catch {
        // ignore
      }

      // Determine the best diff range to use
      // Prefer diffing against base branch using the current branch or PR branch
      const headRef = currentBranch || prBranchToUse;

      // Try remote-tracking diff first (origin/base...head)
      let diffObtained = false;
      try {
        await gitService.execInRepository(sessionWorkdir, "git fetch origin");
      } catch {
        // fetch may fail for local-only repos, that's OK
      }

      // Strategy A: diff against origin/baseBranch...origin/prBranch
      if (!diffObtained) {
        try {
          const diffStatOutput = await gitService.execInRepository(
            sessionWorkdir,
            `git diff --stat origin/${baseBranch}...origin/${prBranchToUse}`
          );
          const diffOutput = await gitService.execInRepository(
            sessionWorkdir,
            `git diff origin/${baseBranch}...origin/${prBranchToUse}`
          );
          if (diffOutput && diffOutput.trim().length > 0) {
            result.diff = diffOutput;
            parseDiffStats(diffStatOutput, result);
            diffObtained = true;
          }
        } catch (error) {
          log.debug("Git fallback strategy A (origin remote refs) failed", {
            error: getErrorMessage(error),
          });
        }
      }

      // Strategy B: diff against baseBranch...headRef (local refs)
      if (!diffObtained) {
        try {
          const diffStatOutput = await gitService.execInRepository(
            sessionWorkdir,
            `git diff --stat ${baseBranch}...${headRef}`
          );
          const diffOutput = await gitService.execInRepository(
            sessionWorkdir,
            `git diff ${baseBranch}...${headRef}`
          );
          if (diffOutput && diffOutput.trim().length > 0) {
            result.diff = diffOutput;
            parseDiffStats(diffStatOutput, result);
            diffObtained = true;
          }
        } catch (error) {
          log.debug("Git fallback strategy B (local refs) failed", {
            error: getErrorMessage(error),
          });
        }
      }

      // Strategy C: diff against baseBranch...HEAD (uncommitted changes included)
      if (!diffObtained) {
        try {
          const diffStatOutput = await gitService.execInRepository(
            sessionWorkdir,
            `git diff --stat ${baseBranch}...HEAD`
          );
          const diffOutput = await gitService.execInRepository(
            sessionWorkdir,
            `git diff ${baseBranch}...HEAD`
          );
          if (diffOutput && diffOutput.trim().length > 0) {
            result.diff = diffOutput;
            parseDiffStats(diffStatOutput, result);
            diffObtained = true;
          }
        } catch (error) {
          log.debug("Git fallback strategy C (baseBranch...HEAD) failed", {
            error: getErrorMessage(error),
          });
        }
      }

      if (!diffObtained) {
        warnings.push(
          "Could not obtain diff content via any method (changeset, repository backend, or direct git commands)"
        );
      }

      // Also try to get PR description from git log if not already set
      if (!result.prDescription) {
        try {
          const prDesc = await gitService.execInRepository(
            sessionWorkdir,
            `git log -1 --pretty=format:%B ${headRef}`
          );
          if (prDesc && prDesc.trim().length > 0) {
            result.prDescription = prDesc.trim();
          }
        } catch {
          // not critical
        }
      }
    } catch (error) {
      const msg = `Direct git fallback also failed: ${getErrorMessage(error)}`;
      log.debug(msg);
      warnings.push(msg);
    }
  }

  // Attach warnings if any were collected
  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  return result;
}

/**
 * Parse git diff --stat output and populate diffStats on the result
 */
function parseDiffStats(diffStatOutput: string, result: SessionReviewResult): void {
  const statsMatch = diffStatOutput.match(
    /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
  );
  if (statsMatch) {
    result.diffStats = {
      filesChanged: parseInt(statsMatch[1] || "0", 10),
      insertions: parseInt(statsMatch[2] || "0", 10),
      deletions: parseInt(statsMatch[3] || "0", 10),
    };
  }
}
