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
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canList: boolean;
  supportsMetadata: boolean;
  supportsSearch: boolean;
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
}

/**
 * Minimal TaskBackend interface - handles both GI and Markdown backends
 */
export interface TaskBackend {
  // ---- Core Identity ----
  name: string;

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

  // ---- Optional Metadata Methods ----
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
}

/**
 * Task creation options
 */
export interface CreateTaskOptions {
  force?: boolean;
  spec?: string; // This is the spec content for creation
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
}
