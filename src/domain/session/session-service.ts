/**
 * SessionService — unified service class for all session operations
 *
 * Provides a single object that holds injected dependencies and delegates
 * to the impl functions defined in the session sub-modules. Dependencies
 * are injected at construction time via the DI container.
 */

import { injectable, inject } from "tsyringe";
import type { GitServiceInterface } from "../git/types";
import type { WorkspaceUtilsInterface } from "../workspace";
import type { TaskServiceInterface } from "../tasks/taskService";
import { RepositoryBackendType } from "../repository/index";
import type { SessionProviderInterface } from "./session-db-adapter";
import {
  getSessionImpl,
  listSessionsImpl,
  deleteSessionImpl,
  getSessionDirImpl,
  inspectSessionImpl,
  cleanupSessionImpl,
  type DeleteSessionResult,
} from "./session-lifecycle-operations";
import { startSessionImpl } from "./start-session-operations";
import { updateSessionImpl } from "./session-update-operations";
import { sessionReviewImpl } from "./session-review-operations";
import type { SessionReviewParams, SessionReviewResult } from "./session-review-operations";
import { approveSessionPr } from "./session-approval-operations";
import type { ApprovalInfo } from "../repository/approval-types";
import { sessionCommit } from "./session-commands";
import { sessionPrImpl } from "./session-pr-operations";
import type { SessionPrDependencies } from "./session-pr-operations";
import { mergeSessionPr } from "./session-merge-operations";
import type { SessionMergeParams, SessionMergeResult } from "./session-merge-operations";
import { scanSessionConflicts } from "./session-conflicts-operations";
import type {
  SessionConflictParams,
  SessionConflictScanOptions,
  SessionConflictScanResult,
} from "./session-conflicts-operations";
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
import type { SessionPRParameters } from "../schemas";

/**
 * The superset of all dependencies needed by any session operation.
 */
export interface SessionDeps {
  sessionProvider: SessionProviderInterface;
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
@injectable()
export class SessionService {
  constructor(@inject("sessionDeps") private deps: SessionDeps) {}

  /**
   * Get a session by name, task ID, or repo path.
   */
  async get(params: SessionGetParams): Promise<Session | null> {
    return getSessionImpl(params, { sessionDB: this.deps.sessionProvider });
  }

  /**
   * List all sessions.
   */
  async list(params: SessionListParams): Promise<Session[]> {
    return listSessionsImpl(params, { sessionDB: this.deps.sessionProvider });
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
      sessionDB: this.deps.sessionProvider,
      gitService: this.deps.gitService,
      taskService: this.deps.taskService,
      workspaceUtils: this.deps.workspaceUtils,
      getRepositoryBackend: this.deps.getRepositoryBackend,
    });
  }

  /**
   * Delete a session.
   */
  async delete(params: SessionDeleteParams): Promise<DeleteSessionResult> {
    return deleteSessionImpl(params, {
      sessionDB: this.deps.sessionProvider,
      gitService: this.deps.gitService,
    });
  }

  /**
   * Get the working directory for a session.
   */
  async getDir(params: SessionDirParams): Promise<string> {
    return getSessionDirImpl(params, { sessionDB: this.deps.sessionProvider });
  }

  /**
   * Update a session (fetch/merge latest from base branch).
   */
  async update(params: SessionUpdateParams): Promise<Session> {
    return updateSessionImpl(params as SessionUpdateParameters, {
      gitService: this.deps.gitService,
      sessionDB: this.deps.sessionProvider,
      getCurrentSession: async (repoPath?: string) =>
        (await this.deps.getCurrentSession(repoPath ?? process.cwd())) ?? undefined,
    });
  }

  /**
   * Inspect the current session from the working directory.
   */
  async inspect(params: { json?: boolean }): Promise<Session | null> {
    return inspectSessionImpl(params, { sessionDB: this.deps.sessionProvider });
  }

  /**
   * Review a session PR — returns structured diff/spec/description data.
   */
  async review(params: SessionReviewParams): Promise<SessionReviewResult> {
    return sessionReviewImpl(params, {
      sessionDB: this.deps.sessionProvider,
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
        sessionDB: this.deps.sessionProvider,
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

  /**
   * Commit and push changes within a session workspace.
   */
  async commit(params: {
    session: string;
    message: string;
    all?: boolean;
    amend?: boolean;
    noStage?: boolean;
  }): Promise<{
    success: boolean;
    nothingToCommit?: boolean;
    commitHash: string | null;
    shortHash?: string;
    subject?: string;
    branch?: string;
    authorName?: string;
    authorEmail?: string;
    timestamp?: string;
    message: string;
    filesChanged?: number;
    insertions?: number;
    deletions?: number;
    files?: Array<{ path: string; status: string }>;
    pushed: boolean;
  }> {
    return sessionCommit(params, this.deps.sessionProvider);
  }

  /**
   * Create a pull request for a session.
   */
  async createPr(
    params: SessionPRParameters,
    options?: { interface?: "cli" | "mcp"; workingDirectory?: string }
  ): Promise<{
    prBranch: string;
    baseBranch: string;
    title?: string;
    body?: string;
    url?: string;
  }> {
    const deps: SessionPrDependencies = {
      sessionDB: this.deps.sessionProvider,
      gitService: this.deps.gitService,
      taskService: this.deps.taskService,
    };
    return sessionPrImpl(params, deps, options);
  }

  /**
   * Merge an approved session pull request.
   */
  async mergePr(params: SessionMergeParams): Promise<SessionMergeResult> {
    return mergeSessionPr(params, {
      sessionDB: this.deps.sessionProvider,
      taskService: this.deps.taskService,
      gitService: this.deps.gitService,
    });
  }

  /**
   * Scan a session workspace for git conflict markers.
   */
  async scanConflicts(
    params: SessionConflictParams,
    options?: SessionConflictScanOptions
  ): Promise<SessionConflictScanResult> {
    return scanSessionConflicts(params, options ?? {}, this.deps.sessionProvider);
  }

  /**
   * Clean up a session — removes workspace directories and database record.
   */
  async cleanup(params: {
    sessionId: string;
    taskId?: string;
    force?: boolean;
    dryRun?: boolean;
  }): Promise<{
    sessionDeleted: boolean;
    directoriesRemoved: string[];
    errors: string[];
  }> {
    return cleanupSessionImpl(params, { sessionDB: this.deps.sessionProvider });
  }
}
