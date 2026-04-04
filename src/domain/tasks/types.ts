/**
 * Task Domain Types
 *
 * Centralized type definitions for the tasks domain.
 * Extracted from tasks.ts to improve modularity and maintainability.
 */

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
  specPath?: string;
  backend?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  spec?: string;
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
  // createTask: legacy method for creating from a spec file path; only some backends support it
  createTask?(specPath: string | any, options?: any): Promise<Task>;
  // getTaskSpecPath: returns relative path for a task's spec file; only file-based backends implement it
  getTaskSpecPath?(taskId: string, title: string): string;
  // getTaskMetadata/setTaskMetadata: rich metadata access; only database-backed backends implement it
  getTaskMetadata?(id: string): Promise<TaskMetadata | null>;
  setTaskMetadata?(id: string, metadata: TaskMetadata): Promise<void>;
}

/**
 * Task list filtering options
 */
export interface TaskListOptions {
  status?: string;
  backend?: string;
  all?: boolean;
  limit?: number;
}

/**
 * Task creation options
 */
export interface CreateTaskOptions {
  force?: boolean;
  spec?: string; // This is the spec content for creation
  description?: string; // Alternative to spec for description-based creation
  id?: string; // Specific ID to use instead of generating one
  status?: string; // Specific status to use instead of defaulting to TODO
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
}

/**
 * Task backend configuration
 */
export interface TaskBackendConfig {
  name: string;
  workspacePath: string;
  gitService?: any;
}
