/**
 * Task Domain Types
 *
 * Centralized type definitions for the tasks domain.
 * Extracted from tasks.ts to improve modularity and maintainability.
 */
import type { GitServiceInterface } from "../git/types";
import type { FsLike } from "../interfaces/fs-like";

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
  backend?: string;
  /** Parent task ID if this is a subtask (populated from task graph, not stored in backend) */
  parentTaskId?: string;
  metadata?: Record<string, unknown>;
  spec?: string;
  tags?: string[];
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
  setTaskStatus(id: string, status: string): Promise<void>;
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
