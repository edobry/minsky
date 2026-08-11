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
import type { SessionProviderInterface } from "./types";
import type { ScopeResolverDb } from "../project/scope-resolver";
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
import type { SessionUpdateResult } from "./session-stash-restore";
import { sessionReviewImpl } from "./session-review-operations";
import type { SessionReviewParams, SessionReviewResult } from "./session-review-operations";
import { approveSessionPr } from "./session-pr-approval-operations";
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
} from "../schemas/session";
import type { SessionUpdateParameters } from "../schemas";
import type { SessionPRParameters } from "../schemas";
import type { SessionStartParametersWithIntent } from "./start-session-operations";
import type { SessionLaunchIntent } from "./session-startability";

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
  /**
   * Optional database connection for project-scope write-stamping (ADR-021, mt#2416).
   * When present, session.start stamps project_id on the new session row.
   */
  db?: ScopeResolverDb;
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
/**
 * Build the parameter object `startSessionImpl` receives (mt#3955).
 *
 * Spread FIRST, then defaults, then the values this layer fixes — so a field the
 * caller supplied reaches the domain unless something here deliberately overrides
 * it.
 *
 * ## Why this is a function, and why it spreads
 *
 * It used to be an inline object literal listing every field by hand, and
 * `recover` was not on the list. `startSessionImpl` therefore saw `undefined`,
 * took its non-recover branch, and re-emitted "session appears abandoned" to an
 * operator who had just followed that error's own instruction to re-run with
 * `--recover`. Nothing caught it because the literal is cast with `as`: a MISSING
 * optional field is not a type error, so the flag went nowhere in silence.
 *
 * This was the second time that same flag was dropped by a hand-written copy —
 * mt#2742 fixed the adapter -> service hop with the identical symptom. Listing
 * fields by hand makes every layer boundary an independent chance to forget one.
 * Spreading removes the chance rather than patching the instance.
 *
 * Exported and pure so the construction can be asserted directly. The alternative
 * — driving `SessionService.start` and patching its `startSessionImpl` import to
 * see what arrived — is the shape `testing-standards.mdc §Testable Design` tells
 * you to refactor instead of mock.
 *
 * ## The widened forwarding is deliberate (PR #2823 R1)
 *
 * Spreading forwards every enumerable property the caller passed, where the old
 * literal forwarded an allowlist. That IS a behavior change and it is the point:
 * the allowlist is what silently dropped `recover`. The alternative — enumerate
 * the permitted keys — is the same construct that failed twice, so it would
 * restore the defect to buy back the narrowing.
 *
 * The extra properties are inert: `startSessionImpl` destructures the fields it
 * needs and never enumerates keys, so an unexpected one is carried and ignored
 * rather than acted on. The narrowing that matters is the TYPE, which is why the
 * cast below is the part worth being uncomfortable about — not the spread.
 */
export function buildSessionStartParams(
  params: SessionStartParams & { launchIntent?: SessionLaunchIntent }
): SessionStartParametersWithIntent {
  return {
    ...params,
    description: params.description || "",
    packageManager: params.packageManager || "bun",
    skipInstall: params.skipInstall || false,
    noStatusUpdate: params.noStatusUpdate || false,
    quiet: params.quiet || false,
    // Fixed by this layer regardless of what the caller passed — these stay
    // AFTER the spread so they win.
    debug: false,
    format: "text" as const,
    force: false,
    // PR #2823 R1 asked for `satisfies` here instead of `as`, which is the right
    // instinct — a cast can hide a mismatch. Tried it; it does NOT compile, and
    // the reason is worth recording rather than working around silently.
    //
    // This method accepts `SessionStartParams` (`schemas/session.ts`) but
    // `startSessionImpl` requires `SessionStartParameters`
    // (`schemas/session-schemas.ts`) — two different schemas for one operation.
    // The domain one makes `sessionId` and `branch` REQUIRED; the service-facing
    // one has both optional, which is correct, since `session_start --task <id>`
    // supplies neither. So the cast is not laziness here: it is bridging a real
    // divergence, and `satisfies` fails on fields a caller legitimately omits.
    //
    // Reconciling the two schemas is a genuine fix and a bigger change than this
    // one, so it is not smuggled into an approved PR. mt#3212 owns it — it
    // covers all 8 `*Params`/`*Parameters` pairs across these two files, and
    // this pair is row 1. Until then the cast stays, and the test file beside
    // this function is what actually guards the forwarding it cannot check.
  } as SessionStartParametersWithIntent;
}

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
   *
   * Params construction is {@link buildSessionStartParams} — pure, exported, and
   * tested directly, because the defect it fixes (mt#3955) lived entirely in that
   * construction and could otherwise only be observed by patching the
   * `startSessionImpl` import this method reaches itself.
   */
  async start(
    params: SessionStartParams & {
      /** mt#2986: domain-only launch intent — not part of the MCP-facing schema. */
      launchIntent?: SessionLaunchIntent;
    }
  ): Promise<Session> {
    const sessionStartParams = buildSessionStartParams(params);

    return startSessionImpl(sessionStartParams, {
      sessionDB: this.deps.sessionProvider,
      gitService: this.deps.gitService,
      taskService: this.deps.taskService,
      workspaceUtils: this.deps.workspaceUtils,
      getRepositoryBackend: this.deps.getRepositoryBackend,
      db: this.deps.db,
    });
  }

  /**
   * Delete a session.
   *
   * NOTE (mt#3105): the live-actor gate inside `deleteSessionImpl` reads
   * presence claims via an optional persistence provider. `SessionDeps`
   * deliberately excludes persistence (adapter-composition concern — see
   * `registerSessionCommands`'s `getOptionalPersistenceProvider`), so THIS
   * path runs the gate without a provider and fail-closes (refuses) for
   * non-terminal sessions unless an overrideReason is supplied. The
   * production delete path (`session.delete` command) calls
   * `deleteSessionImpl` directly with the provider wired.
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
  async update(params: SessionUpdateParams): Promise<SessionUpdateResult> {
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
    dryRun?: boolean;
    /** mt#3021 SC2 + mt#3104: git-state guard + liveness gate override — see cleanupSessionImpl. */
    overrideReason?: string;
  }): Promise<{
    sessionDeleted: boolean;
    directoriesRemoved: string[];
    errors: string[];
  }> {
    return cleanupSessionImpl(params, {
      sessionDB: this.deps.sessionProvider,
      gitService: this.deps.gitService,
    });
  }
}
