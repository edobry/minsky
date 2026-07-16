import type { TaskServiceInterface } from "../tasks";
import type { GitServiceInterface } from "../git";
import type { WorkspaceUtilsInterface } from "../workspace";
import type { PullRequestInfo } from "./session-db";
import type { ProjectScope } from "../project/scope";
import type { InterfaceBinding } from "../interface-binding/types";

/**
 * Generic options for querying/listing session records at the storage layer.
 * (Relocated from the retired `storage/database-storage` module in mt#2329;
 * the sessions domain is now its sole consumer.)
 */
export interface DatabaseQueryOptions {
  /** Inclusive lower bound on createdAt (ISO string) */
  createdAfter?: string;
  /** Inclusive upper bound on createdAt (ISO string) */
  createdBefore?: string;
  /** Maximum number of records to return */
  limit?: number;
  /** Number of records to skip (for paging) */
  offset?: number;
  /**
   * Ordering directives applied at the storage layer.
   * Multiple entries are applied in order; the first is the primary sort key.
   * `field` must match a column on the entity (e.g., "lastActivityAt", "createdAt").
   */
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  /** Allow additional implementation-specific options */
  [key: string]: unknown;
}

export enum SessionStatus {
  CREATED = "CREATED",
  ACTIVE = "ACTIVE",
  PR_OPEN = "PR_OPEN",
  PR_APPROVED = "PR_APPROVED",
  MERGED = "MERGED",
  CLOSED = "CLOSED",
}

/**
 * Core session record interface
 *
 * Task IDs are stored in QUALIFIED format (e.g., "mt#283") — verified against
 * live rows and matched by getSessionByTaskId / listSessions({ taskId }) via
 * validateQualifiedTaskId (mt#2329 PR #1625 R1; the prior "plain 283" note was
 * stale). Use formatTaskIdForDisplay() from task-id-utils.ts for display.
 *
 * ### Design Decision: `interfaceBinding` lives on `SessionRecord`, not a
 * sibling `InterfaceBinding` table (mt#1628)
 *
 * mt#1628's spec asked this task to decide between a `SessionRecord` field
 * and a separate `InterfaceBinding` table, and document the tradeoffs.
 * Decision: a field on `SessionRecord` (this field), persisted as a JSON
 * text column — the same pattern already used for `prState`/`pullRequest`
 * (see `../storage/schemas/session-schema.ts`).
 *
 * Why NOT a new table:
 * - v0's surface-kind union is a hardcoded 2-value enum (`iterm-tab` |
 *   `unbound`; see `../interface-binding/types.ts`) — a session has at most
 *   ONE current binding, not a many-valued relation. A join table earns its
 *   cost when the cardinality or query shape needs it; neither applies yet.
 * - Generalizing to the full polymorphic surface-kind design (vscode-window,
 *   claude-desktop, autonomous-loop, ci-runner, ...) is explicitly out of
 *   scope for this task (mt#1506 owns that ADR) — building a normalized
 *   table now would be speculative infrastructure for a shape that hasn't
 *   been designed yet.
 * - Matches the existing embedded-JSON-on-`sessions` convention already
 *   used for `prState`/`pullRequest`, keeping this addition low-risk (an
 *   additive nullable column, no new join, no new migration-ordering
 *   concern).
 *
 * Related-but-distinct prior art considered and NOT reused for this field:
 * `presence_claims` (mt#2284/mt#2562) already stores a `terminalContext` env
 * bag (including `TERM_PROGRAM`/`TERM_SESSION_ID`) per session-grain
 * attachment row, self-registered by each session's own process. This
 * task's correlator (`../interface-binding/iterm-correlator.ts`) READS that
 * data as its candidate signal — see the module doc there — but does not
 * write bindings onto `presence_claims` rows, because those rows are keyed
 * by `(subjectKind, subjectId, actorId)` and owned by the self-registering
 * actor's write path; the correlator is a distinct third-party observer
 * process. `SessionRecord.interfaceBinding` is the session's own
 * "confirmed observation," independent of which actor(s) are attached.
 */
export interface SessionRecord {
  sessionId: string;
  repoName: string;
  repoUrl: string;
  repoPath?: string; // Local path to the repository
  createdAt: string;
  /** Task ID in storage format (qualified, e.g., "mt#283") */
  taskId?: string;
  backendType?: "github" | "gitlab" | "bitbucket"; // Repository backend type
  lastActivityAt?: string;
  lastCommitHash?: string;
  lastCommitMessage?: string;
  commitCount?: number;
  status?: SessionStatus;
  agentId?: string;
  /** Git branch name created for this session */
  branch?: string;
  prState?: {
    branchName: string;
    exists?: boolean; // Whether the PR branch exists
    lastChecked: string; // ISO timestamp
    createdAt?: string; // When PR branch was created
    mergedAt?: string; // When merged (for cleanup)
  };
  pullRequest?: PullRequestInfo;

  // NEW: Simple PR approval tracking (Task #358)
  prBranch?: string; // PR branch if one exists ("pr/session-id")
  prApproved?: boolean; // Whether this session's PR is approved

  /** Project uuid this session belongs to (nullable; set on insert from resolved scope). */
  projectId?: string;

  /**
   * Local-Minsky-only operator-interface binding (mt#1628 — iTerm-tab
   * binding v0). Undefined means "never observed" (hosted Minsky, non-macOS
   * local Minsky, or the correlator hasn't run yet for this session) — the
   * read path (`../interface-binding/read.ts`'s `resolveInterfaceBinding`)
   * defaults an undefined value to an explicit `{ kind: "unbound" }` for
   * MCP/CLI consumers, so storage stays sparse while the read contract
   * stays total. See the Design Decision note above this interface.
   */
  interfaceBinding?: InterfaceBinding;

  // Legacy / compatibility fields
  /** @deprecated Use `sessionId` instead */
  name?: string;
  workspacePath?: string;
  sessionPath?: string;
  /** @deprecated Use `createdAt` instead */
  created?: string;
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
}

export type SessionLiveness = "healthy" | "idle" | "stale" | "orphaned";

export function deriveSessionLiveness(
  record: Pick<SessionRecord, "lastActivityAt" | "status" | "createdAt">,
  options?: { idleThresholdMs?: number; staleThresholdMs?: number }
): SessionLiveness {
  const idleMs = options?.idleThresholdMs ?? 30 * 60 * 1000; // 30 min
  const staleMs = options?.staleThresholdMs ?? 2 * 60 * 60 * 1000; // 2 hours

  const activityTime = record.lastActivityAt || record.createdAt;
  if (!activityTime) return "stale";

  const elapsed = Date.now() - new Date(activityTime).getTime();

  if (record.status === SessionStatus.MERGED || record.status === SessionStatus.CLOSED) {
    return "healthy"; // terminal states are always "healthy" — they're done
  }

  if (elapsed > staleMs) return "stale";
  if (elapsed > idleMs) return "idle";
  return "healthy";
}

/**
 * Session interface for external use
 *
 * Task IDs are stored in QUALIFIED format (e.g., "mt#283") — verified against
 * live rows and matched by getSessionByTaskId / listSessions({ taskId }) via
 * validateQualifiedTaskId (mt#2329 PR #1625 R1; the prior "plain 283" note was
 * stale). Use formatTaskIdForDisplay() from task-id-utils.ts for display.
 */
export interface Session {
  sessionId: string;
  repoUrl?: string;
  repoName?: string;
  /** @deprecated No longer stored persistently; kept for compatibility with code that still reads it */
  branch?: string;
  createdAt?: string;
  /** Task ID in storage format (qualified, e.g., "mt#283") */
  taskId?: string;
  /** Computed liveness status derived from lastActivityAt and session status */
  liveness?: SessionLiveness;
  backendType?: "github" | "gitlab" | "bitbucket";
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
  remote?: {
    authMethod?: "ssh" | "https" | "token";
    depth?: number;
  };
  prState?: {
    branchName: string;
    exists?: boolean;
    lastChecked: string;
    createdAt?: string;
    mergedAt?: string;
  };
  pullRequest?: PullRequestInfo;

  // NEW: Simple PR approval tracking (Task #358)
  prBranch?: string; // PR branch if one exists ("pr/session-id")
  prApproved?: boolean; // Whether this session's PR is approved
}

/**
 * Options for listing sessions, applied at the storage layer.
 *
 * Extends DatabaseQueryOptions (generic pagination/ordering) with
 * session-specific filter fields.
 */
export interface SessionListOptions extends DatabaseQueryOptions {
  /** Filter by task ID */
  taskId?: string;
  /** Filter by repo name */
  repoName?: string;
  /** Filter by session ID */
  session?: string;
  /** Exclude sessions with any of these statuses (DB-level WHERE NOT IN) */
  statusNotIn?: SessionStatus[];
  /** Project scope for filtering (ADR-021, mt#2416). Defaults to ALL_PROJECTS when omitted. */
  projectScope?: ProjectScope;
}

/**
 * Interface for session database operations
 * This defines the contract for session management functionality
 */
export interface SessionProviderInterface {
  /**
   * Get all available sessions
   */
  listSessions(options?: SessionListOptions): Promise<SessionRecord[]>;

  /**
   * Get a specific session by name
   */
  getSession(session: string): Promise<SessionRecord | null>;

  /**
   * Get a specific session by task ID
   */
  getSessionByTaskId(taskId: string): Promise<SessionRecord | null>;

  /**
   * Add a new session to the database
   */
  addSession(record: SessionRecord): Promise<void>;

  /**
   * Update an existing session
   */
  updateSession(session: string, updates: Partial<Omit<SessionRecord, "sessionId">>): Promise<void>;

  /**
   * Delete a session by name
   */
  deleteSession(session: string): Promise<boolean>;

  /**
   * Get the repository path for a session
   */
  getRepoPath(record: SessionRecord | Record<string, unknown>): Promise<string>;

  /**
   * Get the working directory for a session
   */
  getSessionWorkdir(sessionId: string): Promise<string>;
}

/**
 * Session review parameters interface
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
 * Session review result interface
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
  /** Warnings from data-gathering steps that failed non-fatally */
  warnings?: string[];
}

/**
 * Session dependencies for testing and dependency injection
 */
export interface SessionDependencies {
  sessionDB?: SessionProviderInterface;
  gitService?: GitServiceInterface;
  taskService?: TaskServiceInterface & {
    getTaskSpecData?: (taskId: string) => Promise<string>;
  };
  workspaceUtils?: WorkspaceUtilsInterface;
  getCurrentSession?: (repoPath: string) => Promise<string | null>;
}

/**
 * Session creation dependencies
 */
export interface SessionCreateDependencies extends SessionDependencies {
  resolveRepoPath?: (repoName: string) => Promise<string>;
}

/**
 * Session approval dependencies
 */
export interface SessionApprovalDependencies {
  sessionDB?: SessionProviderInterface;
  gitService?: GitServiceInterface;
  taskService?: {
    setTaskStatus?: (taskId: string, status: string) => Promise<void>;
    getBackendForTask?: (taskId: string) => Promise<string>;
  };
  workspaceUtils?: WorkspaceUtilsInterface;
  getCurrentSession?: (repoPath: string) => Promise<string | null>;
}

/**
 * Session approval result interface
 */
export interface SessionApprovalResult {
  session: string;
  commitHash: string;
  mergeDate: string;
  mergedBy: string;
  baseBranch: string;
  prBranch: string;
  taskId?: string;
  isNewlyApproved: boolean;
}

/**
 * Session prepare PR result interface
 */
export interface SessionPrResult {
  prBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
  url?: string; // PR URL from repository backend
  /**
   * Receipt of the IN-REVIEW status transition attempted post-PR-create.
   * See `StatusTransitionReceipt` in `session-pr-operations.ts` for the
   * full taxonomy of skip/success/failure cases (mt#1378).
   */
  statusTransition: import("./session-pr-operations").StatusTransitionReceipt;
  // Session information for CLI formatting
  session?: {
    sessionId: string;
    taskId?: string;
    repoName?: string;
  };
  sessionId?: string; // Alternative property name for formatter compatibility
}
