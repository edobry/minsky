/**
 * SessionService — unified service class for all session operations
 *
 * Provides a single object that holds injected dependencies and delegates
 * to the impl functions defined in the session sub-modules.  The companion
 * `createSessionDeps()` / `createSessionService()` factories wire in the
 * real implementations so callers get a fully-constructed service with no
 * manual wiring.
 */

import { createGitService } from "../git";
import type { GitServiceInterface } from "../git/types";
import { createWorkspaceUtils, getCurrentSession } from "../workspace";
import type { WorkspaceUtilsInterface } from "../workspace";
import { createConfiguredTaskService } from "../tasks/taskService";
import type { TaskServiceInterface } from "../tasks/taskService";
import { RepositoryBackendType } from "../repository/index";
import { createSessionProvider } from "./session-db-adapter";
import type { SessionProviderInterface } from "./session-db-adapter";
import { getRepositoryBackendFromConfig } from "./repository-backend-detection";
import {
  getSessionImpl,
  listSessionsImpl,
  deleteSessionImpl,
  getSessionDirImpl,
  inspectSessionImpl,
} from "./session-lifecycle-operations";
import { startSessionImpl } from "./start-session-operations";
import { updateSessionImpl } from "./session-update-operations";
import { sessionReviewImpl } from "./session-review-operations";
import type { SessionReviewParams, SessionReviewResult } from "./session-review-operations";
import { approveSessionPr } from "./session-approval-operations";
import type { ApprovalInfo } from "../repository/approval-types";

import type { Session } from "./types";
import type {
  SessionGetParams,
  SessionListParams,
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams,
} from "../../schemas/session";
import type { SessionStartParameters, SessionUpdateParameters } from "../schemas";

/**
 * The superset of all dependencies needed by any session operation.
 */
export interface SessionDeps {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  taskService: TaskServiceInterface & {
    /** Optional — available on backends that support spec retrieval */
    getTaskSpecData?: (taskId: string) => Promise<string>;
  };
  workspaceUtils: WorkspaceUtilsInterface;
  getCurrentSession: (repoPath: string) => Promise<string | null>;
  getRepositoryBackend: () => Promise<{
    repoUrl: string;
    backendType: RepositoryBackendType;
    github?: { owner: string; repo: string };
  }>;
}

/**
 * Creates all real-implementation dependencies for the SessionService.
 */
export async function createSessionDeps(): Promise<SessionDeps> {
  return {
    sessionDB: await createSessionProvider(),
    gitService: createGitService(),
    taskService: await createConfiguredTaskService({ workspacePath: process.cwd() }),
    workspaceUtils: createWorkspaceUtils(),
    // getCurrentSession returns string | undefined; wrap to match string | null contract
    getCurrentSession: async (repoPath: string) => {
      const result = await getCurrentSession(repoPath);
      return result ?? null;
    },
    getRepositoryBackend: getRepositoryBackendFromConfig,
  };
}

/**
 * Result type returned by SessionService.approve()
 */
export interface ApproveResult {
  sessionId: string;
  taskId?: string;
  prBranch?: string;
  approvalInfo: ApprovalInfo;
  wasAlreadyApproved: boolean;
}

/**
 * Unified session service class.
 *
 * Holds a set of injected dependencies and delegates each operation to the
 * corresponding impl function in the session sub-modules.
 */
export class SessionService {
  constructor(private deps: SessionDeps) {}

  /**
   * Get a session by name, task ID, or repo path.
   */
  async get(params: SessionGetParams): Promise<Session | null> {
    return getSessionImpl(params, { sessionDB: this.deps.sessionDB });
  }

  /**
   * List all sessions.
   */
  async list(params: SessionListParams): Promise<Session[]> {
    return listSessionsImpl(params, { sessionDB: this.deps.sessionDB });
  }

  /**
   * Start a new session.
   */
  async start(params: SessionStartParams): Promise<Session> {
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
    } as SessionStartParameters;

    return startSessionImpl(sessionStartParams, {
      sessionDB: this.deps.sessionDB,
      gitService: this.deps.gitService,
      taskService: this.deps.taskService,
      workspaceUtils: this.deps.workspaceUtils,
      getRepositoryBackend: this.deps.getRepositoryBackend,
    });
  }

  /**
   * Delete a session.
   */
  async delete(params: SessionDeleteParams): Promise<boolean> {
    return deleteSessionImpl(params, { sessionDB: this.deps.sessionDB });
  }

  /**
   * Get the working directory for a session.
   */
  async getDir(params: SessionDirParams): Promise<string> {
    return getSessionDirImpl(params, { sessionDB: this.deps.sessionDB });
  }

  /**
   * Update a session (fetch/merge latest from base branch).
   */
  async update(params: SessionUpdateParams): Promise<Session> {
    return updateSessionImpl(params as SessionUpdateParameters, {
      gitService: this.deps.gitService,
      sessionDB: this.deps.sessionDB,
      getCurrentSession: async (repoPath?: string) =>
        (await this.deps.getCurrentSession(repoPath ?? process.cwd())) ?? undefined,
    });
  }

  /**
   * Inspect the current session from the working directory.
   */
  async inspect(params: { json?: boolean }): Promise<Session | null> {
    return inspectSessionImpl(params, { sessionDB: this.deps.sessionDB });
  }

  /**
   * Review a session PR — returns structured diff/spec/description data.
   */
  async review(params: SessionReviewParams): Promise<SessionReviewResult> {
    return sessionReviewImpl(params, {
      sessionDB: this.deps.sessionDB,
      gitService: this.deps.gitService,
      taskService: this.deps.taskService,
      workspaceUtils: this.deps.workspaceUtils,
      getCurrentSession: async (repoPath?: string) =>
        (await this.deps.getCurrentSession(repoPath ?? process.cwd())) ?? undefined,
    });
  }

  /**
   * Approve a session PR branch.
   *
   * SECURITY (Task #358): Approval only — use 'session merge' separately.
   */
  async approve(params: {
    session?: string;
    task?: string;
    repo?: string;
    json?: boolean;
    reviewComment?: string;
  }): Promise<ApproveResult> {
    let sessionToUse = params.session;

    // Detect session from repo path when no explicit session/task provided
    if (!sessionToUse && !params.task && params.repo) {
      const detected = await this.deps.getCurrentSession(params.repo);
      if (detected) {
        sessionToUse = detected;
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
        sessionDB: this.deps.sessionDB,
        gitService: this.deps.gitService,
        taskService: this.deps.taskService,
        workspaceUtils: this.deps.workspaceUtils,
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
}

/**
 * Convenience factory — creates a fully-wired SessionService with real deps.
 */
export async function createSessionService(): Promise<SessionService> {
  return new SessionService(await createSessionDeps());
}
