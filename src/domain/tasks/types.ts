/**
 * Backend capabilities interface for capability discovery
 * Defines what metadata and operations each backend supports
 */
export interface BackendCapabilities {
  // Core operations
  supportsTaskCreation: boolean;
  supportsTaskUpdate: boolean;
  supportsTaskDeletion: boolean;

  // Essential metadata support
  supportsStatus: boolean;

  // Structural metadata (Tasks #238, #239)
  supportsSubtasks: boolean;
  supportsDependencies: boolean;

  // Provenance metadata
  supportsOriginalRequirements: boolean;
  supportsAiEnhancementTracking: boolean;

  // Query capabilities
  supportsMetadataQuery: boolean;
  supportsFullTextSearch: boolean;

  // Update mechanism
  requiresSpecialWorkspace: boolean;
  supportsTransactions: boolean;
  supportsRealTimeSync: boolean;

  // Hybrid backend support (Task #315)
  isHybridBackend: boolean;
  specStorageType?: string; // e.g., "github-issues", "markdown-files"
  metadataStorageType?: string; // e.g., "sqlite", "postgresql", "json"
}

import type { TaskStatus } from "./taskConstants";
import type { TaskSpecData } from "../../types/tasks/taskData";

/**
 * Task metadata structure for Task #315 infrastructure
 * Keeps it simple and focused on proven needs
 */
export interface TaskMetadata {
  // Core metadata
  taskId?: string;
  createdAt?: string;
  updatedAt?: string;

  // Basic task metadata that backends already support
  status?: TaskStatus;

  // Structural metadata - to be designed in Tasks #238, #239
  // Leave this space for future implementation
}

/**
 * Query structure for metadata queries
 */
export interface MetadataQuery {
  status?: TaskStatus;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
}

/**
 * Interface for metadata database operations
 * Provides persistent storage for task metadata separate from task specs
 */
export interface MetadataDatabase {
  // CRUD operations
  getTaskMetadata(taskId: string): Promise<TaskMetadata | null>;
  setTaskMetadata(taskId: string, metadata: TaskMetadata): Promise<void>;
  deleteTaskMetadata(taskId: string): Promise<void>;

  // Query operations
  queryTasks(query: MetadataQuery): Promise<TaskMetadata[]>;

  // Bulk operations
  setMultipleTaskMetadata(metadata: Record<string, TaskMetadata>): Promise<void>;
  deleteMultipleTaskMetadata(taskIds: string[]): Promise<void>;

  // Database management
  initialize(): Promise<void>;
  close(): Promise<void>;
  backup?(backupPath: string): Promise<void>;
  restore?(backupPath: string): Promise<void>;
}

/**
 * Interface for task specification storage
 * Handles the storage and retrieval of task content/specifications
 * Separate from metadata storage for hybrid backend architectures
 */
export interface TaskSpecStorage {
  name: string;

  // Core spec operations - using existing TaskSpecData
  listTaskSpecs(options?: TaskListOptions): Promise<TaskSpecData[]>;
  getTaskSpec(id: string): Promise<TaskSpecData | null>;
  createTaskSpec(spec: TaskSpecData, options?: CreateTaskOptions): Promise<TaskSpecData>;
  updateTaskSpec(id: string, spec: Partial<TaskSpecData>): Promise<void>;
  deleteTaskSpec(id: string, options?: DeleteTaskOptions): Promise<boolean>;

  // Workspace integration
  getWorkspacePath(): string;

  // Capability discovery
  getSpecStorageCapabilities(): SpecStorageCapabilities;
}

/**
 * Specification storage capabilities
 */
export interface SpecStorageCapabilities {
  supportsFullTextSearch: boolean;
  supportsVersionHistory: boolean;
  supportsRealTimeSync: boolean;
  requiresSpecialWorkspace: boolean;
  supportsTransactions: boolean;
}

/**
 * Hybrid backend that combines spec storage with metadata storage
 * This is the new architecture for true spec/metadata separation
 */
export interface HybridTaskBackend {
  name: string;
  specStorage: TaskSpecStorage;
  metadataStorage: MetadataDatabase;

  // Unified operations that coordinate between spec and metadata
  listTasks(options?: TaskListOptions): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(
    spec: TaskSpecData,
    metadata?: TaskMetadata,
    options?: CreateTaskOptions
  ): Promise<Task>;
  updateTask(
    id: string,
    updates: { spec?: Partial<TaskSpecData>; metadata?: Partial<TaskMetadata> }
  ): Promise<void>;
  deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean>;

  // Status operations (can be stored in metadata)
  getTaskStatus(id: string): Promise<string | undefined>;
  setTaskStatus(id: string, status: string): Promise<void>;

  // Metadata operations (delegated to metadata storage)
  getTaskMetadata(id: string): Promise<TaskMetadata | null>;
  setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void>;
  queryTasksByMetadata(query: MetadataQuery): Promise<Task[]>;

  // Workspace and capabilities
  getWorkspacePath(): string;
  getCapabilities(): BackendCapabilities;
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

  // Enhanced metadata methods (optional for now, using proper types)
  getTaskMetadata?(id: string): Promise<TaskMetadata | null>;
  setTaskMetadata?(id: string, metadata: TaskMetadata): Promise<void>;
  queryTasksByMetadata?(query: MetadataQuery): Promise<Task[]>;
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