/**
 * Session domain facade
 *
 * This module is a thin wrapper that aggregates session sub-modules and exposes
 * a stable public API. Most logic lives in the sub-modules under ./session/.
 */

import { createGitService } from "./git";
import {
  resolveRepositoryAndBackend,
  detectRepositoryBackendTypeFromUrl,
} from "./session/repository-backend-detection";
import { createSessionProvider } from "./session/session-db-adapter";
import { type TaskServiceInterface } from "./tasks";
import { createConfiguredTaskService } from "./tasks/taskService";

import {
  type SessionReviewParams,
  type SessionReviewResult,
  sessionReviewImpl,
} from "./session/session-review-operations";
import { type WorkspaceUtilsInterface, getCurrentSession } from "./workspace";
import * as WorkspaceUtils from "./workspace";
import { approveSessionPr } from "./session/session-approval-operations";
import { sessionCommit } from "./session/session-commands";
import {
  getSessionImpl,
  listSessionsImpl,
  deleteSessionImpl,
  getSessionDirImpl,
  inspectSessionImpl,
} from "./session/session-lifecycle-operations";
import { updateSessionImpl } from "./session/session-update-operations";
import { startSessionImpl } from "./session/start-session-operations";
import type { RepositoryBackend } from "./repository/index";

import type {
  SessionGetParams,
  SessionListParams,
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams,
} from "../schemas/session";
import type { SessionStartParameters, SessionUpdateParameters } from "./schemas";
import type { GitServiceInterface } from "./git";

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

// ---- Param-based facade functions (thin wrappers that inject defaults) ----

import type { SessionProviderInterface } from "./session/types";

/**
 * Gets session details based on parameters.
 * Supports auto-detection from current working directory.
 */
export async function getSessionFromParams(
  params: SessionGetParams,
  depsInput?: { sessionDB?: SessionProviderInterface }
): Promise<import("./session/types").Session | null> {
  const deps = {
    sessionDB: depsInput?.sessionDB ?? (await createSessionProvider()),
  };
  return getSessionImpl(params, deps);
}

/**
 * Lists all sessions.
 */
export async function listSessionsFromParams(
  params: SessionListParams,
  depsInput?: { sessionDB?: SessionProviderInterface }
): Promise<import("./session/types").Session[]> {
  const deps = {
    sessionDB: depsInput?.sessionDB ?? (await createSessionProvider()),
  };
  return listSessionsImpl(params, deps);
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
    resolveRepositoryAndBackend?: typeof resolveRepositoryAndBackend;
    /** Back-compat for older tests/consumers */
    resolveRepoPath?: typeof resolveRepositoryAndBackend;
    /** Optional filesystem adapter passthrough for tests */
    fs?: {
      exists: (path: string) => boolean | Promise<boolean>;
      rm: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
    };
  }
): Promise<import("./session/types").Session> {
  const deps = {
    sessionDB: depsInput?.sessionDB ?? (await createSessionProvider()),
    gitService: depsInput?.gitService ?? createGitService(),
    taskService:
      depsInput?.taskService ??
      (await createConfiguredTaskService({ workspacePath: process.cwd() })),
    workspaceUtils: depsInput?.workspaceUtils ?? WorkspaceUtils.createWorkspaceUtils(),
    resolveRepositoryAndBackend:
      depsInput?.resolveRepositoryAndBackend ??
      // Back-compat: wrap legacy resolveRepoPath(uri) => string into the new resolver interface
      (depsInput?.resolveRepoPath
        ? async (options?: { repoParam?: string; cwd?: string }) => {
            const resolveFn = depsInput.resolveRepoPath as unknown as (
              uri?: string
            ) => Promise<string>;
            const uri = await resolveFn(options?.repoParam || options?.cwd);
            const backendType = detectRepositoryBackendTypeFromUrl(uri);
            return { repoUrl: uri, backendType };
          }
        : resolveRepositoryAndBackend),
    fs: depsInput?.fs,
  } as const;

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

  return startSessionImpl(sessionStartParams as unknown as SessionStartParameters, deps);
}

/**
 * Deletes a session based on parameters.
 */
export async function deleteSessionFromParams(
  params: SessionDeleteParams,
  depsInput?: { sessionDB?: SessionProviderInterface }
): Promise<boolean> {
  const deps = {
    sessionDB: depsInput?.sessionDB ?? (await createSessionProvider()),
  };
  return deleteSessionImpl(params, deps);
}

/**
 * Gets session working directory based on parameters.
 */
export async function getSessionDirFromParams(
  params: SessionDirParams,
  depsInput?: { sessionDB?: SessionProviderInterface }
): Promise<string> {
  const deps = {
    sessionDB: depsInput?.sessionDB ?? (await createSessionProvider()),
  };
  return getSessionDirImpl(params, deps);
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
  const deps = {
    gitService: depsInput?.gitService ?? createGitService(),
    sessionDB: depsInput?.sessionDB ?? (await createSessionProvider()),
    getCurrentSession: depsInput?.getCurrentSession ?? getCurrentSession,
  };
  return updateSessionImpl(params as unknown as SessionUpdateParameters, deps);
}

/**
 * Inspects current session based on workspace location.
 */
export async function inspectSessionFromParams(params: {
  json?: boolean;
}): Promise<import("./session/types").Session | null> {
  const sessionProvider = await createSessionProvider();
  return inspectSessionImpl(params, { sessionDB: sessionProvider });
}

/**
 * Reviews a session PR.
 * Delegates to sessionReviewImpl in session-review-operations sub-module.
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
  return sessionReviewImpl(params, depsInput);
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
    createRepositoryBackendForSession?: (workingDirectory: string) => Promise<RepositoryBackend>;
    createRepositoryBackend?: (sessionRecord: any) => Promise<RepositoryBackend>;
    /** @deprecated kept for backward-compat with older tests */
    resolveRepoPath?: (...args: any[]) => Promise<string>;
  }
): Promise<{
  sessionName: string;
  taskId?: string;
  prBranch?: string;
  approvalInfo: {
    reviewId: number | string;
    approvedBy: string;
    approvedAt: string;
    prNumber: string | number;
    [key: string]: any;
  };
  wasAlreadyApproved: boolean;
}> {
  let sessionToUse = params.session;

  // Handle session detection from repo path (CLI interface concern)
  if (!sessionToUse && !params.task && params.repo) {
    const getCurrentSessionFunc = depsInput?.getCurrentSession ?? getCurrentSession;
    const detectedSession = await getCurrentSessionFunc(params.repo);
    if (detectedSession) {
      sessionToUse = detectedSession;
    }
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
      sessionDB: depsInput?.sessionDB,
      gitService: depsInput?.gitService,
      taskService: depsInput?.taskService,
      workspaceUtils: depsInput?.workspaceUtils,
      resolveRepoPath: depsInput?.resolveRepoPath,
      createRepositoryBackendForSession: depsInput?.createRepositoryBackendForSession,
    }
  );

  return {
    sessionName: result.session,
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
