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
  SessionListParams,
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams,
} from "../schemas/session";
import type { GitServiceInterface } from "./git";

import { SessionService, type SessionDeps, createSessionDeps } from "./session/session-service";

// Re-export canonical types from sub-modules
export type { Session, SessionProviderInterface, SessionRecord } from "./session/types";
export type { SessionDbState } from "./session/session-db";

// Re-export factory and adapter
export { createSessionProvider } from "./session/session-db-adapter";
export { SessionDbAdapter } from "./session/session-db-adapter";

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
 */
async function resolvePartialDeps(partial?: Partial<SessionDeps>): Promise<SessionDeps> {
  if (!partial) return createSessionDeps();
  return {
    sessionDB: partial.sessionDB ?? (await createSessionProvider()),
    gitService: partial.gitService ?? createGitService(),
    taskService:
      partial.taskService ?? (await createConfiguredTaskService({ workspacePath: process.cwd() })),
    workspaceUtils: partial.workspaceUtils ?? createWorkspaceUtils(),
    getCurrentSession:
      partial.getCurrentSession ?? (async (p: string) => (await getCurrentSession(p)) ?? null),
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
  const service = new SessionService(await resolvePartialDeps(depsInput));
  return service.get(params);
}

/**
 * Lists all sessions.
 */
export async function listSessionsFromParams(
  params: SessionListParams,
  depsInput?: { sessionDB?: SessionProviderInterface }
): Promise<import("./session/types").Session[]> {
  const service = new SessionService(await resolvePartialDeps(depsInput));
  return service.list(params);
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
    sessionDB: depsInput?.sessionDB,
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

    // eslint-disable-next-line custom/no-excessive-as-unknown -- param schemas are structurally compatible but have optional vs required field mismatches
    const typedParams = sessionStartParams as unknown as import("./schemas").SessionStartParameters;
    return startSessionImpl(typedParams, {
      ...resolvedDeps,
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
): Promise<boolean> {
  const service = new SessionService(await resolvePartialDeps(depsInput));
  return service.delete(params);
}

/**
 * Gets session working directory based on parameters.
 */
export async function getSessionDirFromParams(
  params: SessionDirParams,
  depsInput?: { sessionDB?: SessionProviderInterface }
): Promise<string> {
  const service = new SessionService(await resolvePartialDeps(depsInput));
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
    getCurrentSession?: typeof getCurrentSession;
  }
): Promise<import("./session/types").Session> {
  // getCurrentSession from workspace has signature (path: string) => Promise<string | undefined>
  // but SessionDeps.getCurrentSession returns Promise<string | null>. Wrap if provided.
  const wrappedGetCurrentSession = depsInput?.getCurrentSession
    ? async (p: string) => {
        const result = await depsInput.getCurrentSession!(p);
        return result ?? null;
      }
    : undefined;

  const service = new SessionService(
    await resolvePartialDeps({
      sessionDB: depsInput?.sessionDB,
      gitService: depsInput?.gitService,
      getCurrentSession: wrappedGetCurrentSession,
    })
  );
  return service.update(params);
}

/**
 * Inspects current session based on workspace location.
 */
export async function inspectSessionFromParams(params: {
  json?: boolean;
}): Promise<import("./session/types").Session | null> {
  const service = new SessionService(await resolvePartialDeps());
  return service.inspect(params);
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
    getCurrentSession?: typeof getCurrentSession;
  }
): Promise<SessionReviewResult> {
  // getCurrentSession from workspace has signature (path: string) => Promise<string | undefined>
  // but SessionDeps.getCurrentSession returns Promise<string | null>. Wrap if provided.
  const wrappedGetCurrentSession = depsInput?.getCurrentSession
    ? async (p: string) => {
        const result = await depsInput.getCurrentSession!(p);
        return result ?? null;
      }
    : undefined;

  const service = new SessionService(
    await resolvePartialDeps({
      sessionDB: depsInput?.sessionDB,
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

  let sessionToUse = params.session;
  if (!sessionToUse && !params.task && params.repo) {
    const getCurrentSessionFunc =
      depsInput?.getCurrentSession ?? (async (p: string) => (await getCurrentSession(p)) ?? null);
    const detected = await getCurrentSessionFunc(params.repo);
    if (detected) sessionToUse = detected;
  }

  const { createSessionProvider } = await import("./session/session-db-adapter");
  const resolvedSessionDB = depsInput?.sessionDB ?? (await createSessionProvider());

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
export { listSessionsFromParams as sessionList };
export { getSessionFromParams as sessionGet };
export { startSessionFromParams as sessionStart };
export { deleteSessionFromParams as sessionDelete };
export { getSessionDirFromParams as sessionDir };
export { updateSessionFromParams as sessionUpdate };
export { approveSessionFromParams as sessionApprove };
export { inspectSessionFromParams as sessionInspect };
