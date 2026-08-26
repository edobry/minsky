/**
 * Task Domain Types
 *
 * Centralized type definitions for the tasks domain.
 * Extracted from tasks.ts to improve modularity and maintainability.
 */
import type { GitServiceInterface } from "../git/types";
import type { FsLike } from "../interfaces/fs-like";
import type { ProjectScope } from "../project/scope";

/**
 * What a status write actually did, as reported by the backend's own store (mt#4457).
 *
 * `setTaskStatus` used to return `Promise<void>`, so the only signal a caller had was
 * "no exception was thrown". That is not the same question as "did the row change":
 * a Postgres UPDATE matching zero rows raises nothing, and the CLI/MCP adapter above
 * it reported a hardcoded `changed: true` regardless. A status write that did not land
 * was therefore indistinguishable from one that did, at every layer.
 *
 * Backends return the count rather than a boolean so the caller can tell "did not
 * land" (0) from "landed" (1) from "matched more rows than it should have" (>1) —
 * the last being a corruption signal a boolean would silently discard.
 */
export interface StatusWriteOutcome {
  /**
   * Records the write affected. 0 means the write did NOT persist and the caller
   * must treat the operation as failed, regardless of the absence of an error.
   */
  recordsAffected: number;
}

/**
 * A status write that returned without error and did not persist (mt#4457).
 *
 * A distinct class rather than a bare `Error` (PR #3342 R1) so callers can
 * discriminate it from a validation failure, a Zod error, or a backend fault —
 * the three have different remedies, and a caller that cannot tell them apart
 * will retry the ones it should surface and surface the ones it should retry.
 */
export class StatusWriteDidNotPersistError extends Error {
  readonly taskId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly recordsAffected: number;

  constructor(args: {
    taskId: string;
    fromStatus: string;
    toStatus: string;
    recordsAffected: number;
  }) {
    super(
      `Status write for ${args.taskId} did not persist: the update matched ` +
        `${args.recordsAffected} records (intended ${args.fromStatus} -> ${args.toStatus}). ` +
        `The task's status is unchanged. This is a failed write, not a no-op — ` +
        `do not treat it as success.`
    );
    this.name = "StatusWriteDidNotPersistError";
    this.taskId = args.taskId;
    this.fromStatus = args.fromStatus;
    this.toStatus = args.toStatus;
    this.recordsAffected = args.recordsAffected;
  }
}

/**
 * Simple backend capabilities interface
 * Defines what basic operations each backend supports
 */
export interface BackendCapabilities {
  canCreate?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
  canList?: boolean;
  supportsMetadata?: boolean;
  supportsSearch?: boolean;
  supportsTaskCreation?: boolean;
  supportsTaskUpdate?: boolean;
  supportsTaskDeletion?: boolean;
  supportsStatus?: boolean;
  supportsSubtasks?: boolean;
  supportsDependencies?: boolean;
  supportsOriginalRequirements?: boolean;
  supportsAiEnhancementTracking?: boolean;
  supportsMetadataQuery?: boolean;
  supportsFullTextSearch?: boolean;
  supportsTransactions?: boolean;
  supportsRealTimeSync?: boolean;
  supportsTags?: boolean;
}

/**
 * Task metadata for backends that support it
 */
export interface TaskMetadata {
  id: string;
  title: string;
  spec: string;
  status: string;
  backend: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Task interface - just title and spec, no separate description
 */
export interface Task {
  id: string;
  title: string;
  status: string;
  /** Task workflow kind. Determines which state machine applies. Default: "implementation" */
  kind?: string;
  backend?: string;
  /** Parent task ID if this is a subtask (populated from task graph, not stored in backend) */
  parentTaskId?: string;
  metadata?: Record<string, unknown>;
  spec?: string;
  tags?: string[];
  /** Creation timestamp from the backend store (populated by DB-backed backends). */
  createdAt?: Date;
  /** Last-modification timestamp from the backend store (populated by DB-backed backends). */
  updatedAt?: Date;
}

/**
 * Minimal TaskBackend interface - handles both GI and Markdown backends
 */
export interface TaskBackend {
  // ---- Core Identity ----
  name: string;
  prefix?: string;

  // ---- User-Facing Operations ----
  listTasks(options?: TaskListOptions): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  getTaskStatus(id: string): Promise<string | undefined>;
  setTaskStatus(id: string, status: string): Promise<StatusWriteOutcome>;
  createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task>;
  deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean>;
  getWorkspacePath(): string;
  getCapabilities(): BackendCapabilities;

  // ---- Optional Methods ----
  // getTasks: batch-fetch multiple tasks by ID; backends that support it avoid N+1 queries
  getTasks?(ids: string[]): Promise<Task[]>;
  // getTaskMetadata/setTaskMetadata: rich metadata access; only database-backed backends implement it
  getTaskMetadata?(id: string): Promise<TaskMetadata | null>;
  setTaskMetadata?(id: string, metadata: TaskMetadata): Promise<void>;
  // updateTags: replace all tags on a task; only tag-capable backends implement it
  updateTags?(id: string, tags: string[]): Promise<void>;
  // setTaskKind: set the workflow kind on a task; only database-backed backends implement it
  setTaskKind?(id: string, kind: string): Promise<void>;
}

/**
 * Task list filtering options
 */
export interface TaskListOptions {
  status?: string;
  backend?: string;
  all?: boolean;
  limit?: number;
  tags?: string[];
  /** Project scope for filtering (ADR-021, mt#2416). Defaults to ALL_PROJECTS when omitted. */
  projectScope?: ProjectScope;
  /**
   * Filter by workflow kind (mt#1812 / mt#2762), e.g. "implementation" | "umbrella" | "state-ops".
   * Validated against the workflow registry (isKnownKind) before it reaches this option.
   */
  kind?: string;
}

/**
 * Task creation options
 */
export interface CreateTaskOptions {
  force?: boolean;
  spec?: string; // This is the spec content for creation
  id?: string; // Specific ID to use instead of generating one
  status?: string; // Specific status to use instead of defaulting to TODO
  tags?: string[]; // Tags/labels for thematic batching
  kind?: string; // Workflow kind: "implementation" | "umbrella" (defaults to "implementation")
  /**
   * Request a specific backend by name or prefix (e.g. "minsky", "github").
   * When set, `createTaskFromTitleAndSpec` on a multi-backend service routes to
   * that backend rather than the configured default. If the requested backend is
   * not registered, the call fails with a clear error (mt#2572 Bug 4).
   */
  backend?: string;
}

/**
 * Task deletion options
 */
export interface DeleteTaskOptions {
  force?: boolean;
}

/**
 * Task service configuration
 */
export interface TaskServiceOptions {
  workspacePath: string;
  backend?: string;
  persistenceProvider: import("../persistence/types").BasePersistenceProvider;
}

/**
 * Task backend configuration
 */
export interface TaskBackendConfig {
  name: string;
  workspacePath: string;
  gitService?: GitServiceInterface;
  fs?: FsLike;
}
