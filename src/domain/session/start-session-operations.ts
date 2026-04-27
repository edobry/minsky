import { existsSync } from "fs";
import { join } from "path";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import { taskIdSchema as TaskIdSchema } from "../../schemas/common";
import type { SessionStartParameters } from "../../domain/schemas";
import { log } from "../../utils/logger";
import { installDependencies } from "../../utils/package-manager";
import { type GitServiceInterface } from "../git";
import { normalizeRepoName } from "../repo-utils";
import { TASK_STATUS, type TaskServiceInterface } from "../tasks";
import { type WorkspaceUtilsInterface } from "../workspace";
import { createTaskFromDescription } from "../templates/session-templates";
import type { SessionProviderInterface, SessionRecord, Session } from "../session";
import { validateQualifiedTaskId, formatTaskIdForDisplay } from "../tasks/task-id-utils";
import { RepositoryBackendType } from "../repository";
import { generateSessionId, taskIdToBranchName } from "../tasks/task-id";
import { SessionStatus } from "./types";

export interface StartSessionDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  taskService: TaskServiceInterface;
  workspaceUtils: WorkspaceUtilsInterface;
  /** Reads repository backend (URL + type) from project config written by `minsky init`. */
  getRepositoryBackend: () => Promise<{
    repoUrl: string;
    backendType: RepositoryBackendType;
    github?: { owner: string; repo: string };
  }>;
  /** Optional filesystem adapter for testing to avoid real fs operations */
  fs?: {
    exists: (path: string) => boolean | Promise<boolean>;
    rm: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
  };
}

/**
 * Validated context returned by the precondition phase.
 * Contains all derived values needed by the mutation phase.
 * Once this is returned, all validation has passed and side effects may begin.
 */
interface ValidatedSessionContext {
  sessionId: string;
  taskId: string | undefined;
  repoUrl: string;
  backendType: RepositoryBackendType;
  cloneSource: string;
  referenceRepo: string | undefined;
  branchName: string;
  normalizedRepoName: string;
  sessionDir: string;
}

/**
 * Phase 1: Validate all preconditions and derive context.
 *
 * This function MUST NOT perform any side effects (no git clone, no DB writes,
 * no filesystem mutations). It may only read state and throw on invalid conditions.
 * Returns a ValidatedSessionContext that the mutation phase consumes.
 *
 * Structural invariant: if this function throws, the system state is unchanged.
 */
async function validatePreconditions(
  params: SessionStartParameters,
  deps: StartSessionDependencies
): Promise<ValidatedSessionContext> {
  const {
    sessionId: inputSessionId,
    repo,
    task,
    description,
    branch,
    noStatusUpdate,
    quiet,
  } = params;

  const currentDir = process.env.PWD || process.cwd();
  const isInSession = await deps.workspaceUtils.isSessionWorkspace(currentDir);
  if (isInSession) {
    throw new MinskyError(`Cannot start session from within another session.

Current location: ${currentDir}

Navigate to your main workspace and try again:
  minsky session start --task <id>`);
  }

  // Determine repo URL and backend type from project config (written by `minsky init`).
  const configBackend = await deps.getRepositoryBackend();
  const repoUrl = configBackend.repoUrl;
  const backendType = configBackend.backendType;
  const cloneSource = repo || repoUrl;

  // Auto-detect local workspace for --reference clone optimization.
  let referenceRepo: string | undefined;
  if (!repo) {
    try {
      const { getConfiguration } = await import("../configuration/index");
      const cfg = getConfiguration() as { workspace?: { mainPath?: string } };
      const candidatePath = cfg.workspace?.mainPath || currentDir;

      const localRemote = (
        await deps.gitService.execInRepository(candidatePath, "git remote get-url origin")
      ).trim();
      if (localRemote) {
        const { normalizeRepositoryUri } = await import("../uri-utils");
        const opts = { validateLocalExists: false };
        const localName = normalizeRepositoryUri(localRemote, opts).name;
        const configName = normalizeRepositoryUri(repoUrl, opts).name;
        if (localName === configName) {
          referenceRepo = candidatePath;
          log.debug("Using local workspace as reference clone source", { referenceRepo });
        }
      }
    } catch {
      // Config not available or detection failed — skip optimization
    }
  }

  // Determine the session ID using task ID if provided
  let sessionId = inputSessionId;
  let taskId: string | undefined = task;

  // Auto-create task if description is provided but no task ID
  if (description && !taskId) {
    const taskSpec = createTaskFromDescription(description);
    const createdTask = await deps.taskService.createTaskFromTitleAndSpec(
      taskSpec.title,
      taskSpec.description
    );
    taskId = createdTask.id;
    // Auto-created tasks skip planning and go straight to READY
    await deps.taskService.setTaskStatus(taskId, TASK_STATUS.PLANNING);
    await deps.taskService.setTaskStatus(taskId, TASK_STATUS.READY);
    if (!quiet) {
      log.cli(`Created task ${taskId}: ${taskSpec.title}`);
    }
  }

  if (taskId && !sessionId) {
    // Normalize the task ID format using Zod validation
    let normalizedTaskId: string;
    try {
      normalizedTaskId = TaskIdSchema.parse(taskId);
    } catch (validationError) {
      const manualNormalized = validateQualifiedTaskId(taskId);
      if (manualNormalized) {
        normalizedTaskId = manualNormalized;
      } else {
        throw new ValidationError(
          `Invalid task ID format: '${taskId}'. Please provide either a qualified task ID (md#123, gh#456) or legacy format (123, task#123, #123).`
        );
      }
    }
    taskId = normalizedTaskId;

    // Verify the task exists
    const taskObj = await deps.taskService.getTask(normalizedTaskId);
    if (!taskObj) {
      throw new ResourceNotFoundError(`Task ${taskId} not found`, "task", taskId);
    }

    // Validate task status
    if (!noStatusUpdate) {
      const currentStatus = await deps.taskService.getTaskStatus(normalizedTaskId);

      if (currentStatus === TASK_STATUS.TODO) {
        throw new ValidationError(
          "Task must be in PLANNING status before starting a session. Set status to PLANNING first.",
          undefined,
          undefined
        );
      }

      if (currentStatus === TASK_STATUS.PLANNING) {
        throw new ValidationError(
          "Planning is not yet marked as complete. Set status to READY when investigation is done.",
          undefined,
          undefined
        );
      }
    }

    sessionId = generateSessionId();
  }

  if (!sessionId) {
    throw new ValidationError("Session ID could not be determined from task ID");
  }

  // Check if session already exists
  const existingSession = await deps.sessionDB.getSession(sessionId);
  if (existingSession) {
    throw new MinskyError(`Session '${sessionId}' already exists`);
  }

  // Check if a session already exists for this task
  if (taskId) {
    const existingSessions = await deps.sessionDB.listSessions();
    const taskSession = existingSessions.find((s: SessionRecord) => s.taskId === taskId);

    if (taskSession) {
      // Merged PR — always hard-block (session is frozen)
      if (taskSession.prState?.mergedAt) {
        throw new MinskyError(
          `A session for task ${formatTaskIdForDisplay(taskId)} exists ("${taskSession.sessionId}") but its PR was ` +
            `merged at ${taskSession.prState.mergedAt}. To start a new session for this task, ` +
            `delete the old one first:\n\n` +
            `  minsky session delete ${taskSession.sessionId}\n` +
            `  minsky session start --task ${formatTaskIdForDisplay(taskId)}`
        );
      }

      const { deriveSessionLiveness } = await import("./types");
      const liveness = deriveSessionLiveness(taskSession);

      // Stale/orphaned with --recover: delete the old session and proceed
      if ((liveness === "stale" || liveness === "orphaned") && params.recover) {
        log.cli(
          `Recovering abandoned session "${taskSession.sessionId}" (liveness: ${liveness})...`
        );
        await deps.sessionDB.deleteSession(taskSession.sessionId);
        // Fall through to create new session
      } else {
        // Build a more informative error message based on liveness
        const ageInfo = taskSession.lastActivityAt
          ? ` Last activity: ${new Date(taskSession.lastActivityAt).toISOString()}.`
          : "";
        const statusInfo = taskSession.status ? ` Status: ${taskSession.status}.` : "";

        if (liveness === "healthy") {
          throw new MinskyError(
            `A session for task ${formatTaskIdForDisplay(taskId)} is actively in use ("${taskSession.sessionId}").${statusInfo}${ageInfo} ` +
              `Another agent may be working on this task. Use the existing session, or delete it before starting a new one.`
          );
        }

        if (liveness === "idle") {
          throw new MinskyError(
            `A session for task ${formatTaskIdForDisplay(taskId)} exists ("${taskSession.sessionId}") and was recently idle.${statusInfo}${ageInfo} ` +
              `Use the existing session, or delete it before starting a new one.`
          );
        }

        // stale or orphaned (without --recover)
        throw new MinskyError(
          `A session for task ${formatTaskIdForDisplay(taskId)} appears abandoned ("${taskSession.sessionId}", liveness: ${liveness}).${statusInfo}${ageInfo}\n\n` +
            `To recover and start fresh:\n` +
            `  minsky session start --task ${formatTaskIdForDisplay(taskId)} --recover\n\n` +
            `Or to manually delete:\n` +
            `  minsky session delete ${taskSession.sessionId}`
        );
      }
    }
  }

  // Derive computed values (pure transforms, no side effects)
  const repoName = normalizeRepoName(repoUrl);
  let normalizedRepoName = repoName;
  if (repoName.startsWith("local/")) {
    const parts = repoName.split("/");
    if (parts.length > 1) {
      normalizedRepoName = `${parts[0]}-${parts.slice(1).join("-")}`;
    }
  } else {
    normalizedRepoName = repoName.replace(/[^a-zA-Z0-9-_]/g, "-");
  }

  const sessionBaseDir = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
  const sessionDir = join(sessionBaseDir, "minsky", "sessions", sessionId);
  const branchName = branch || (taskId ? taskIdToBranchName(taskId) : sessionId);

  return {
    sessionId,
    taskId,
    repoUrl,
    backendType,
    cloneSource,
    referenceRepo,
    branchName,
    normalizedRepoName,
    sessionDir,
  };
}

/**
 * Phase 2: Execute side effects using validated context.
 *
 * This function MUST NOT throw ValidationError — all validation has already
 * passed in validatePreconditions(). It performs git clone, DB writes, and
 * status transitions.
 */
async function executeMutations(
  ctx: ValidatedSessionContext,
  params: SessionStartParameters,
  deps: StartSessionDependencies
): Promise<Session> {
  const fsAdapter = deps.fs || {
    exists: (p: string) => existsSync(p),
    rm: async (p: string, o: { recursive: boolean; force: boolean }) => {
      try {
        const fsp = await import("fs/promises");
        if (typeof fsp.rm === "function") return fsp.rm(p, o);
        if (typeof fsp.rmdir === "function")
          return fsp.rmdir(p, { recursive: o.recursive } as Parameters<typeof fsp.rmdir>[1]);
      } catch (_e) {
        void 0;
      }
      return;
    },
  };

  const {
    sessionId,
    taskId,
    repoUrl,
    backendType,
    cloneSource,
    referenceRepo,
    branchName,
    normalizedRepoName,
    sessionDir,
  } = ctx;
  const { noStatusUpdate, quiet, skipInstall, packageManager } = params;

  // Warn on deprecated skipInstall flag
  if (skipInstall) {
    log.warn(
      "⚠️  DEPRECATED: --skip-install creates a broken workspace that CANNOT pass typecheck " +
        "hooks or run tests. This flag will be removed in a future release. " +
        "Remove skipInstall from your session_start call."
    );
  }

  // Clean up stale session directory if one exists
  if (await Promise.resolve(fsAdapter.exists(sessionDir))) {
    try {
      await fsAdapter.rm(sessionDir, { recursive: true, force: true });
    } catch (error) {
      throw new MinskyError(
        `Failed to clean up existing session directory: ${getErrorMessage(error)}`
      );
    }
  }

  // Prepare session record
  const sessionRecord: SessionRecord = {
    sessionId: sessionId,
    repoUrl,
    repoName: normalizeRepoName(repoUrl),
    createdAt: new Date().toISOString(),
    taskId,
    backendType,
    branch: branchName,
    lastActivityAt: new Date().toISOString(),
    status: SessionStatus.CREATED,
  };

  let sessionAdded = false;

  try {
    const _gitCloneResult = await deps.gitService.clone({
      repoUrl: cloneSource,
      session: sessionId,
      workdir: sessionDir,
      referenceRepo,
    });

    const _branchResult = await deps.gitService.branchWithoutSession({
      repoName: normalizedRepoName,
      session: sessionId,
      branch: branchName,
    });

    await deps.sessionDB.addSession(sessionRecord);
    sessionAdded = true;
  } catch (gitError) {
    if (sessionAdded) {
      try {
        await deps.sessionDB.deleteSession(sessionId);
      } catch (cleanupError) {
        log.error("Failed to cleanup session record after git error", {
          sessionId,
          gitError: getErrorMessage(gitError),
          cleanupError: getErrorMessage(cleanupError),
        });
      }
    }

    if (await Promise.resolve(fsAdapter.exists(sessionDir))) {
      try {
        await fsAdapter.rm(sessionDir, { recursive: true, force: true });
      } catch (cleanupError) {
        log.error("Failed to cleanup session directory after git error", {
          sessionDir,
          gitError: getErrorMessage(gitError),
          cleanupError: getErrorMessage(cleanupError),
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
        log.cli(`Warning: Dependency installation failed. You may need to run install manually.
Error: ${error}`);
      }
    } catch (installError) {
      if (!quiet) {
        log.cli(
          `Warning: Dependency installation failed. You may need to run install manually.
Error: ${getErrorMessage(installError)}`
        );
      }
    }
  }

  // Transition task status to IN-PROGRESS
  if (taskId && !noStatusUpdate) {
    try {
      const currentStatus = await deps.taskService.getTaskStatus(taskId);

      if (currentStatus === TASK_STATUS.READY || currentStatus === TASK_STATUS.IN_PROGRESS) {
        if (currentStatus === TASK_STATUS.READY) {
          try {
            const specResult = await deps.taskService.getTaskSpecContent(taskId);
            if (specResult) {
              const uncheckedCriteria = specResult.content
                .split("\n")
                .filter((line) => /^\s*- \[ \]/.test(line))
                .map((line) => line.trim());
              if (uncheckedCriteria.length > 0) {
                log.cliWarn(
                  `Warning: Task ${taskId} has ${uncheckedCriteria.length} unchecked success criteria:\n${uncheckedCriteria
                    .map((c) => `  ${c}`)
                    .join("\n")}`
                );
              }
            }
          } catch (_specError) {
            // Non-fatal
          }
        }

        await deps.taskService.setTaskStatus(taskId, TASK_STATUS.IN_PROGRESS);
      }
    } catch (error) {
      log.cliWarn(`Warning: Failed to update status for task ${taskId}: ${getErrorMessage(error)}`);
    }
  }

  if (!quiet) {
    log.debug(`Started session for task ${taskId}`, { session: sessionId });
  }

  return {
    sessionId: sessionId,
    repoUrl,
    repoName: normalizedRepoName,
    taskId,
  };
}

/**
 * Implementation of session start operation.
 *
 * Structured as two phases:
 * 1. validatePreconditions() — checks all invariants, returns validated context
 * 2. executeMutations() — performs side effects using validated context
 *
 * This separation ensures that validation failures cannot leave orphaned state.
 */
export async function startSessionImpl(
  params: SessionStartParameters,
  deps: StartSessionDependencies
): Promise<Session> {
  try {
    log.debug("Starting session with params", {
      sessionId: params.sessionId,
      task: params.task,
      inputBranch: params.branch,
      noStatusUpdate: params.noStatusUpdate,
      quiet: params.quiet,
      skipInstall: params.skipInstall,
      packageManager: params.packageManager,
    });

    const ctx = await validatePreconditions(params, deps);
    return await executeMutations(ctx, params, deps);
  } catch (error) {
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(`Failed to start session: ${getErrorMessage(error)}`, error);
    }
  }
}
