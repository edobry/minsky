/**
 * Session domain facade
 *
 * This module is a thin wrapper that aggregates session sub-modules and exposes
 * a stable public API. Most logic lives in the sub-modules under ./session/.
 */

import {
  detectRepositoryBackendTypeFromUrl,
  getRepositoryBackendFromConfig,
} from "./session/repository-backend-detection";
import { createSessionProvider } from "./session/session-db-adapter";
import { createGitService } from "./git";
import { type TaskServiceInterface } from "./tasks";
import { createConfiguredTaskService } from "./tasks/taskService";

import {
  type SessionReviewParams,
  type SessionReviewResult,
} from "./session/session-review-operations";
import { type WorkspaceUtilsInterface, getCurrentSession, createWorkspaceUtils } from "./workspace";
import { sessionCommit } from "./session/session-commands";
import { startSessionImpl } from "./session/start-session-operations";
import type { RepositoryBackend } from "./repository/index";
import type { SessionRecord } from "./session/types";
import type { ApprovalInfo } from "./repository/approval-types";

import type {
  SessionGetParams,
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams,
} from "../schemas/session";
import type { GitServiceInterface } from "./git";

import { SessionService, type SessionDeps, createSessionDeps } from "./session/session-service";
import type { PersistenceProvider } from "./persistence/types";

// Re-export canonical types from sub-modules
export type { Session, SessionProviderInterface, SessionRecord } from "./session/types";
export type { SessionDbState } from "./session/session-db";

// Re-export factory and adapter
export { createSessionProvider } from "./session/session-db-adapter";
export { SessionDbAdapter } from "./session/session-db-adapter";

// Re-export shared session provider cache
export { getSharedSessionProvider } from "./session/session-provider-cache";

// Re-export review types
export type { SessionReviewParams, SessionReviewResult };

// Re-export PR state cache helpers
export {
  checkPrBranchExists,
  checkPrBranchExistsOptimized,
  updatePrStateOnCreation,
  updatePrStateOnMerge,
} from "./session/session-update-operations";

// Re-export new session-scoped git commands
export { sessionCommit };

// Re-export SessionService and related types for consumers
export { SessionService, createSessionDeps };
export type { SessionDeps };
export { createSessionService } from "./session/session-service";

// ---- Param-based facade functions (thin wrappers that inject defaults) ----

import type { SessionProviderInterface } from "./session/types";

/**
 * Resolves a partial deps object into a full SessionDeps, filling in any
 * missing fields with real implementations.
 *
 * In production, all fields are typically provided by the composition root /
 * container. The fallbacks here exist for direct callers (tests, scripts)
 * that provide at least sessionProvider.
 */
async function resolvePartialDeps(
  partial?: Partial<SessionDeps> & { persistenceProvider?: PersistenceProvider }
): Promise<SessionDeps> {
  if (!partial) {
    throw new Error(
      "resolvePartialDeps requires at least a sessionProvider. " +
        "Use the DI container to obtain fully-wired SessionDeps."
    );
  }

  const persistenceProvider = partial.persistenceProvider;

  // Create individual defaults lazily — only instantiate what's actually missing.
  // This avoids triggering heavy service initialization (e.g. PersistenceService)
  // when tests provide their own mocks for the fields they care about.
  const sessionProvider =
    partial.sessionProvider ??
    (persistenceProvider
      ? await createSessionProvider(undefined, persistenceProvider)
      : (() => {
          throw new Error(
            "Cannot create sessionProvider without persistenceProvider. " +
              "Pass sessionProvider or persistenceProvider in deps."
          );
        })());
  return {
    sessionProvider,
    gitService: partial.gitService ?? createGitService(),
    taskService:
      partial.taskService ??
      (await createConfiguredTaskService({
        workspacePath: process.cwd(),
        persistenceProvider,
      })),
    workspaceUtils: partial.workspaceUtils ?? createWorkspaceUtils(sessionProvider),
    getCurrentSession:
      partial.getCurrentSession ??
      (async (p: string) => {
        const { execAsync } = await import("../utils/exec");
        return (await getCurrentSession(p, execAsync, sessionProvider)) ?? null;
      }),
    getRepositoryBackend: partial.getRepositoryBackend ?? getRepositoryBackendFromConfig,
  };
}

/**
 * Gets session details based on parameters.
 * Supports auto-detection from current working directory.
 */
export async function getSessionFromParams(
  params: SessionGetParams,
  depsInput?: { sessionDB?: SessionProviderInterface }
): Promise<import("./session/types").Session | null> {
  const service = new SessionService(
    await resolvePartialDeps({ sessionProvider: depsInput?.sessionDB })
  );
  return service.get(params);
}

/**
 * Starts a new session based on parameters.
 */
export async function startSessionFromParams(
  params: SessionStartParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: TaskServiceInterface;
    workspaceUtils?: WorkspaceUtilsInterface;
    /** New config-based backend resolver (preferred). */
    getRepositoryBackend?: () => Promise<{
      repoUrl: string;
      backendType: import("./repository/index").RepositoryBackendType;
      github?: { owner: string; repo: string };
    }>;
    /** @deprecated Use getRepositoryBackend instead — accepted for backward-compat with tests */
    resolveRepositoryAndBackend?: (...args: unknown[]) => Promise<unknown>;
    /** @deprecated Use getRepositoryBackend instead — accepted for backward-compat with tests */
    resolveRepoPath?: (...args: unknown[]) => Promise<unknown>;
    /** Optional filesystem adapter passthrough for tests */
    fs?: {
      exists: (path: string) => boolean | Promise<boolean>;
      rm: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
    };
  }
): Promise<import("./session/types").Session> {
  // Resolve getRepositoryBackend dep with graceful backward-compat fallbacks.
  let getRepositoryBackendDep: () => Promise<{
    repoUrl: string;
    backendType: import("./repository/index").RepositoryBackendType;
    github?: { owner: string; repo: string };
  }>;

  if (depsInput?.getRepositoryBackend) {
    getRepositoryBackendDep = depsInput.getRepositoryBackend;
  } else if (depsInput?.resolveRepositoryAndBackend) {
    // Back-compat shim for older tests — wraps legacy resolver into new interface
    const legacyFn = depsInput.resolveRepositoryAndBackend as (
      opts?: Record<string, unknown>
    ) => Promise<{
      repoUrl: string;
      backendType: import("./repository/index").RepositoryBackendType;
      github?: { owner: string; repo: string };
    }>;
    getRepositoryBackendDep = async () => legacyFn({ cwd: process.cwd() });
  } else if (depsInput?.resolveRepoPath) {
    // Back-compat shim for older tests — wraps legacy path resolver into new interface
    const resolveFn = depsInput.resolveRepoPath as (...args: unknown[]) => Promise<string>;
    getRepositoryBackendDep = async () => {
      const uri = await resolveFn(undefined);
      const backendType = detectRepositoryBackendTypeFromUrl(uri);
      return { repoUrl: uri, backendType };
    };
  } else {
    getRepositoryBackendDep = getRepositoryBackendFromConfig;
  }

  const resolvedDeps = await resolvePartialDeps({
    sessionProvider: depsInput?.sessionDB,
    gitService: depsInput?.gitService,
    taskService: depsInput?.taskService,
    workspaceUtils: depsInput?.workspaceUtils,
    getRepositoryBackend: getRepositoryBackendDep,
  });

  if (depsInput?.fs) {
    // `fs` is not part of SessionDeps but startSessionImpl accepts it directly.
    // Fall back to lower-level call when an fs override is provided.
    const sessionStartParams = {
      name: params.name,
      task: params.task,
      description: params.description || "",
      branch: params.branch,
      packageManager: params.packageManager || "bun",
      skipInstall: params.skipInstall || false,
      noStatusUpdate: params.noStatusUpdate || false,
      quiet: params.quiet || false,
      repo: params.repo,
      debug: false,
      format: "text" as const,
      force: false,
    };

    // The manually-built sessionStartParams satisfies SessionStartParameters structurally, but
    // TypeScript cannot verify this because the Zod-inferred type has branded defaults that
    // differ from the plain object literal.  An as-unknown cast is the least-bad option here.
    // eslint-disable-next-line custom/no-excessive-as-unknown -- Zod-inferred type has branded defaults incompatible with plain object literal; structural bridge required
    const typedParams = sessionStartParams as unknown as import("./schemas").SessionStartParameters;
    return startSessionImpl(typedParams, {
      sessionDB: resolvedDeps.sessionProvider,
      gitService: resolvedDeps.gitService,
      taskService: resolvedDeps.taskService,
      workspaceUtils: resolvedDeps.workspaceUtils,
      getRepositoryBackend: resolvedDeps.getRepositoryBackend,
      fs: depsInput.fs,
    });
  }

  return new SessionService(resolvedDeps).start(params);
}

/**
 * Deletes a session based on parameters.
 */
export async function deleteSessionFromParams(
  params: SessionDeleteParams,
  depsInput?: { sessionDB?: SessionProviderInterface }
): Promise<import("./session/session-lifecycle-operations").DeleteSessionResult> {
  const service = new SessionService(
    await resolvePartialDeps({ sessionProvider: depsInput?.sessionDB })
  );
  return service.delete(params);
}

/**
 * Gets session working directory based on parameters.
 */
export async function getSessionDirFromParams(
  params: SessionDirParams,
  depsInput?: { sessionDB?: SessionProviderInterface }
): Promise<string> {
  const service = new SessionService(
    await resolvePartialDeps({ sessionProvider: depsInput?.sessionDB })
  );
  return service.getDir(params);
}

/**
 * Updates a session (fetch/merge latest from base branch).
 */
export async function updateSessionFromParams(
  params: SessionUpdateParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    getCurrentSession?: (repoPath: string) => Promise<string | undefined>;
  }
): Promise<import("./session/types").Session> {
  // getCurrentSession returns Promise<string | undefined> but SessionDeps expects Promise<string | null>
  const wrappedGetCurrentSession = depsInput?.getCurrentSession
    ? async (p: string) => {
        const result = await depsInput.getCurrentSession!(p);
        return result ?? null;
      }
    : undefined;

  const service = new SessionService(
    await resolvePartialDeps({
      sessionProvider: depsInput?.sessionDB,
      gitService: depsInput?.gitService,
      getCurrentSession: wrappedGetCurrentSession,
    })
  );
  return service.update(params);
}

/**
 * Reviews a session PR.
 * Delegates to SessionService.review().
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
    getCurrentSession?: (repoPath: string) => Promise<string | undefined>;
  }
): Promise<SessionReviewResult> {
  // getCurrentSession returns Promise<string | undefined> but SessionDeps expects Promise<string | null>
  const wrappedGetCurrentSession = depsInput?.getCurrentSession
    ? async (p: string) => {
        const result = await depsInput.getCurrentSession!(p);
        return result ?? null;
      }
    : undefined;

  const service = new SessionService(
    await resolvePartialDeps({
      sessionProvider: depsInput?.sessionDB,
      gitService: depsInput?.gitService,
      taskService: depsInput?.taskService,
      workspaceUtils: depsInput?.workspaceUtils,
      getCurrentSession: wrappedGetCurrentSession,
    })
  );
  return service.review(params);
}

/**
 * Approves a session PR branch (DOES NOT MERGE).
 *
 * SECURITY (Task #358): This function only performs approval. Use 'session merge'
 * separately to merge. This prevents unauthorized merges and ensures proper code
 * review workflow.
 */
export async function approveSessionFromParams(
  params: {
    session?: string;
    task?: string;
    repo?: string;
    json?: boolean;
    reviewComment?: string;
  },
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: TaskServiceInterface;
    workspaceUtils?: WorkspaceUtilsInterface;
    getCurrentSession?: (repoPath: string) => Promise<string | null>;
    createRepositoryBackend?: (sessionRecord: SessionRecord) => Promise<RepositoryBackend>;
    persistenceProvider?: PersistenceProvider;
    /** @deprecated kept for backward-compat with older tests */
    resolveRepoPath?: (...args: unknown[]) => Promise<string>;
    /** @deprecated Use createRepositoryBackend instead */
    createRepositoryBackendForSession?: (...args: unknown[]) => Promise<RepositoryBackend>;
  }
): Promise<{
  sessionId: string;
  taskId?: string;
  prBranch?: string;
  approvalInfo: ApprovalInfo;
  wasAlreadyApproved: boolean;
}> {
  // When deprecated createRepositoryBackendForSession is provided (test compat),
  // call approveSessionPr directly to pass it through
  const { approveSessionPr } = await import("./session/session-approval-operations");

  const resolvedSessionDB = depsInput?.sessionDB ?? (await createSessionDeps()).sessionProvider;

  let sessionToUse = params.session;
  if (!sessionToUse && !params.task && params.repo) {
    const getCurrentSessionFunc =
      depsInput?.getCurrentSession ??
      (async (p: string) => {
        const { execAsync } = await import("../utils/exec");
        return (await getCurrentSession(p, execAsync, resolvedSessionDB)) ?? null;
      });
    const detected = await getCurrentSessionFunc(params.repo);
    if (detected) sessionToUse = detected;
  }

  const result = await approveSessionPr(
    {
      session: sessionToUse,
      task: params.task,
      repo: params.repo,
      json: params.json,
      reviewComment: params.reviewComment,
    },
    {
      sessionDB: resolvedSessionDB,
      gitService: depsInput?.gitService,
      taskService: depsInput?.taskService,
      workspaceUtils: depsInput?.workspaceUtils,
      createRepositoryBackendForSession: depsInput?.createRepositoryBackendForSession,
      persistenceProvider: depsInput?.persistenceProvider,
    }
  );

  return {
    sessionId: result.session,
    taskId: result.taskId,
    prBranch: result.prBranch,
    approvalInfo: result.approvalInfo,
    wasAlreadyApproved: result.wasAlreadyApproved,
  };
}

// Shorter alias exports for adapters
export { getSessionFromParams as sessionGet };
export { startSessionFromParams as sessionStart };
export { deleteSessionFromParams as sessionDelete };
export { getSessionDirFromParams as sessionDir };
export { updateSessionFromParams as sessionUpdate };
export { approveSessionFromParams as sessionApprove };
