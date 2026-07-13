import { existsSync } from "fs";
import { join } from "path";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../errors/index";
import { taskIdSchema as TaskIdSchema } from "../schemas/common";
import type { SessionStartParameters } from "../schemas";
import { log } from "@minsky/shared/logger";
import { installDependencies, installNestedDependencies } from "../utils/package-manager";
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
import type { ScopeResolverDb } from "../project/scope-resolver";

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
  /**
   * Optional database connection for project-scope resolution (ADR-021, mt#2416).
   * When provided, the session writer resolves the current project and stamps
   * `project_id` on the new session row. When absent (e.g. in-memory test doubles
   * that don't wire a DB), stamping is skipped — inserts stay nullable, preserving
   * current behavior for hosted/cockpit no-single-repo scenarios.
   */
  db?: ScopeResolverDb;
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

  // Check if a session already exists for this task.
  //
  // mt#2697: pushes the taskId filter down to sessionDB.listSessions({ taskId })
  // (same normalization codepath, same storage-layer query builder) instead of
  // fetching every session and matching in JS with strict equality. This is
  // deliberately UNSCOPED by project (no projectScope passed) — "is this task
  // already in use" is a global collision check, not a project-scoped browse.
  // session.list's task-filtered query (basic-commands.ts createSessionListCommand)
  // mirrors this same unscoped-when-task-filtered behavior so the two surfaces
  // can never structurally diverge on which rows count as "active" for a task.
  if (taskId) {
    const existingSessions = await deps.sessionDB.listSessions({ taskId });
    const taskSession = existingSessions[0];

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

  // ADR-021 / mt#2416: resolve the current project so the new session row is
  // stamped with project_id. Mirrors resolveCurrentProjectId in taskService.ts.
  // Best-effort: never throws — when no DB is resolvable or resolution fails,
  // projectId stays undefined and the insert stays nullable (the hosted/cockpit
  // no-single-repo case, or test doubles without a real DB connection).
  //
  // mt#2697: some callers (e.g. tasks.dispatch's internally-constructed
  // SessionService) don't wire deps.db even though a DB IS resolvable in their
  // process. Fixing this here — rather than in each caller's dep wiring — means
  // every caller gets stamping whenever a DB is reachable: when deps.db is
  // absent, fall back to a self-contained, one-shot PersistenceProvider
  // (open -> resolve scope -> close) instead of skipping stamping outright.
  // Unstamped rows are invisible to session.list's default project-scoped
  // query (project_id IS NULL never matches `project_id = $scope`), which was
  // the root cause of dispatch-created CREATED sessions disappearing from
  // `session_list task:"mt#X"` while still blocking a new dispatch.
  let resolvedProjectId: string | undefined;
  let dbForScopeResolution: ScopeResolverDb | undefined = deps.db;
  let ownedPersistenceProvider: import("../persistence/types").PersistenceProvider | undefined;

  // Single try/catch/finally spans acquisition AND use of the fallback
  // provider, so every exit path — acquisition throw, getDatabaseConnection
  // throw, scope-resolution throw, or plain success — routes through the
  // same finally and closes the provider exactly once. `ownedPersistenceProvider`
  // is assigned the moment a provider is acquired (before calling
  // getDatabaseConnection()), specifically so a throw from
  // getDatabaseConnection() itself can't leak the connection — the earlier
  // shape assigned ownership only after a successful getDatabaseConnection()
  // call, which left that one throw path unclosed.
  try {
    if (!dbForScopeResolution) {
      // Cheap, silent short-circuit: if configuration was never initialized
      // (hermetic tests, or a process that genuinely has no DB), there is
      // nothing to resolve — skip straight past rather than letting
      // resolvePersistenceProvider()'s initialize() log a noisy top-level
      // error for an outcome we already know.
      const { isConfigurationInitialized } = await import("../configuration/index");
      const { resolvePersistenceProvider } = await import("../persistence/factory");
      const provider = isConfigurationInitialized() ? await resolvePersistenceProvider() : null;
      if (provider) {
        ownedPersistenceProvider = provider;
        const rawDb = await provider.getDatabaseConnection?.();
        if (rawDb) {
          dbForScopeResolution = rawDb as ScopeResolverDb;
        }
      }
    }

    if (dbForScopeResolution) {
      const { resolveProjectIdentity } = await import("../project/identity");
      const { resolveProjectScope } = await import("../project/scope-resolver");
      const { isAllProjects } = await import("../project/scope");
      const identity = resolveProjectIdentity({ repoPath: sessionDir });
      const scope = await resolveProjectScope(identity, dbForScopeResolution);
      resolvedProjectId = isAllProjects(scope) ? undefined : scope;
    }
  } catch (err: unknown) {
    // dbForScopeResolution being set at catch-time means the throw happened
    // during identity/scope resolution (stage 2); unset means it happened
    // while acquiring the fallback DB (stage 1) — kept for debug legibility,
    // not behaviorally different (both leave resolvedProjectId undefined).
    const stage = dbForScopeResolution ? "project-scope resolution" : "fallback DB resolution";
    log.debug(`[session.start] ${stage} failed; session.project_id will be NULL`, {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (ownedPersistenceProvider) {
      try {
        await ownedPersistenceProvider.close();
      } catch (closeErr: unknown) {
        // Best-effort: a close failure must never mask resolvedProjectId
        // (already settled above) or escape as an unhandled rejection — log
        // and swallow.
        log.debug(
          "[session.start] Failed to close fallback persistence provider (best-effort, swallowed)",
          { error: closeErr instanceof Error ? closeErr.message : String(closeErr) }
        );
      }
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
    projectId: resolvedProjectId,
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
    // installDependencies captures (rather than streams) the package
    // manager's output in non-quiet mode (mt#2209), so print a concise
    // progress line here — otherwise this slow step would be silent.
    if (!quiet) {
      log.cli("Installing dependencies...");
    }
    try {
      const { success, error } = await installDependencies(sessionDir, {
        packageManager: packageManager,
        quiet: quiet,
      });

      if (success && !quiet) {
        // Completion marker — paired with the "Installing dependencies..."
        // line above so a successful (now-silent) install isn't ambiguous.
        log.cli("Installed dependencies.");
      } else if (!success && !quiet) {
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

    // Install nested workspace packages (mt#1379). Sessions clone the full
    // repo including nested packages under services/ and packages/ that
    // have their own package.json + lockfile and are NOT root workspaces.
    // Without this, the first test run for any nested package fails with
    // misleading "Cannot find module" errors. Best-effort: failures here
    // never fail session_start.
    try {
      const summary = await installNestedDependencies(sessionDir, { quiet });
      if (summary.attempted > 0 && !quiet) {
        if (summary.failed === 0) {
          log.debug(
            `[mt#1379] Installed ${summary.succeeded} nested package(s) under services/ or packages/`
          );
        } else {
          log.cli(
            `Warning: ${summary.failed} of ${summary.attempted} nested package install(s) failed. ` +
              `Run install manually in: ${summary.results
                .filter((r) => !r.success)
                .map((r) => r.path)
                .join(", ")}`
          );
        }
      }
    } catch (nestedError) {
      // installNestedDependencies is contracted not to throw, but defend
      // against future changes — a thrown error here must not fail
      // session_start.
      if (!quiet) {
        log.cli(
          `Warning: Nested-package install orchestration failed. You may need to run install manually in nested workspaces.
Error: ${getErrorMessage(nestedError)}`
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
