/**
 * Task Domain Types
 *
 * Centralized type definitions for the tasks domain.
 * Extracted from tasks.ts to improve modularity and maintainability.
 */

/**
 * Backend capabilities interface for capability discovery
 * Defines what metadata and operations each backend supports
 */
export interface BackendCapabilities {
  // Core operations
  supportsTaskCreation: boolean;
  supportsTaskUpdate: boolean;
  supportsTaskDeletion: boolean;

  // Essential metadata support (simplified scope from Task #235)
  supportsStatus: boolean;

  // Structural metadata (Tasks #238, #239)
  supportsSubtasks: boolean;
  supportsDependencies: boolean;

  // Provenance metadata (original user requirements tracking)
  supportsOriginalRequirements: boolean;
  supportsAiEnhancementTracking: boolean;

  // Query capabilities
  supportsMetadataQuery: boolean;
  supportsFullTextSearch: boolean;

  // Update mechanism
  requiresSpecialWorkspace: boolean;
  supportsTransactions: boolean;
  supportsRealTimeSync: boolean;
}

/**
 * Essential task metadata structure (simplified from Task #235 analysis)
 * Focuses only on structural and provenance metadata
 */
export interface TaskMetadata {
  // Core metadata
  createdAt?: string;
  updatedAt?: string;

  // Structural metadata (Tasks #238, #239)
  parentTask?: string;
  subtasks?: string[];
  dependencies?: {
    prerequisite?: string[];
    optional?: string[];
    related?: string[];
  };

  // Provenance metadata (from Task #235)
  originalRequirements?: string; // User's original intent
  aiEnhanced?: boolean;
  creationContext?: string;

  // Custom metadata for future extensibility
  custom?: Record<string, any>;
}

/**
 * Interface for task service operations
 * This defines the contract for task-related functionality
 */
export interface TaskServiceInterface {
  /**
   * Get all tasks with optional filtering
   */
  listTasks(options?: TaskListOptions): Promise<Task[]>;

  /**
   * Get a task by ID
   */
  getTask(id: string): Promise<Task | null>;

  /**
   * Get the status of a task
   */
  getTaskStatus(id: string): Promise<string | undefined>;

  /**
   * Set the status of a task
   */
  setTaskStatus(id: string, status: string): Promise<void>;

  /**
   * Get the workspace path for the current backend
   */
  getWorkspacePath(): string;

  /**
   * Create a task with the given specification path
   */
  createTask(specPath: string, options?: CreateTaskOptions): Promise<Task>;

  /**
   * Create a task from title and description
   */
  createTaskFromTitleAndDescription(
    title: string,
    description: string,
    options?: CreateTaskOptions
  ): Promise<Task>;

  /**
   * Delete a task
   */
  deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean>;

  /**
   * Get the backend type for a specific task
   */
  getBackendForTask(taskId: string): Promise<string>;
}

/**
 * Task interface for external use
 *
 * TASK 283: Task IDs are stored in plain format (e.g., "283") without # prefix.
 * Use formatTaskIdForDisplay() from task-id-utils.ts when displaying to users.
 */
export interface Task {
  /** Task ID in storage format (plain number string, e.g., "283") */
  id: string;
  title: string;
  status: string;
  description?: string;
  metadata?: any;
  path?: string;
  specPath?: string;
  workspacePath?: string;
  repositoryUri?: string;
}

export interface TaskBackend {
  name: string;
  listTasks(options?: TaskListOptions): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  getTaskStatus(id: string): Promise<string | undefined>;
  setTaskStatus(id: string, status: string): Promise<void>;
  getWorkspacePath(): string;
  createTask(specPath: string, options?: CreateTaskOptions): Promise<Task>;
  createTaskFromTitleAndDescription(
    title: string,
    description: string,
    options?: CreateTaskOptions
  ): Promise<Task>;
  setTaskMetadata?(id: string, metadata: any): Promise<void>;
  deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean>;

  // New capability discovery method
  getCapabilities(): BackendCapabilities;

  // Enhanced metadata methods (optional for now)
  getTaskMetadata?(id: string): Promise<TaskMetadata | null>;
  setTaskMetadata?(id: string, metadata: TaskMetadata): Promise<void>;
}

export interface TaskListOptions {
  status?: string;
}

export interface CreateTaskOptions {
  force?: boolean;
}

export interface DeleteTaskOptions {
  force?: boolean;
}

export interface TaskServiceOptions {
  workspacePath?: string;
  backend?: string;
}
