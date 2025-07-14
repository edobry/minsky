/**
 * TaskBackend interface using functional patterns
 * Separates data retrieval, pure operations, and side effects
 */

import type { TaskData, TaskSpecData, TaskBackendConfig } from "../../types/tasks/taskData";
import type {
  TaskReadOperationResult,
  TaskWriteOperationResult,
} from "../../types/tasks/taskData.js";

/**
 * TaskBackend interface defines operations for task management
 * It separates responsibilities into:
 * 1. Data retrieval (returns raw data)
 * 2. Pure operations (transformations without side effects)
 * 3. Side effects (file I/O, API calls)
 */
export interface TaskBackend {
  /** Backend name */
  name: string;

  // ---- Data Retrieval (raw data) ----

  /**
   * Get tasks raw data
   * @returns Promise resolving to raw tasks data
   */
  getTasksData(): Promise<TaskReadOperationResult>;

  /**
   * Get task specification raw data
   * @param specPath Path to the task specification file
   * @returns Promise resolving to raw task spec data
   */
  getTaskSpecData(specPath: string): Promise<TaskReadOperationResult>;

  // ---- Pure Operations (no side effects) ----

  /**
   * Parse raw content into task data objects
   * @param content Raw content to parse
   * @returns Array of task data objects
   */
  parseTasks(content: string): TaskData[];

  /**
   * Format task data objects into raw content
   * @param tasks Array of task data objects
   * @returns Formatted content
   */
  formatTasks(tasks: TaskData[]): string;

  /**
   * Parse raw task specification content
   * @param content Raw task specification content
   * @returns Parsed task specification data
   */
  parseTaskSpec(content: string): TaskSpecData;

  /**
   * Format task specification data into raw content
   * @param spec Task specification data
   * @returns Formatted content
   */
  formatTaskSpec(spec: TaskSpecData): string;

  // ---- Side Effects (file I/O, API calls) ----

  /**
   * Save tasks data
   * @param content Formatted tasks content
   * @returns Promise resolving to operation result
   */
  saveTasksData(content: string): Promise<TaskWriteOperationResult>;

  /**
   * Save task specification data
   * @param specPath Path to the task specification file
   * @param content Formatted task specification content
   * @returns Promise resolving to operation result
   */
  saveTaskSpecData(specPath: string, content: string): Promise<TaskWriteOperationResult>;

  // ---- Helper Methods ----

  /**
   * Get workspace path
   * @returns Workspace path for this backend
   */
  getWorkspacePath(): string;

  /**
   * Get task specification file path from task ID and title
   * @param taskId Task ID
   * @param title Task title
   * @returns Task specification file path
   */
  getTaskSpecPath(taskId: string, title: string): string;

  /**
   * Check if file exists
   * @param path File path
   * @returns Promise resolving to true if file exists, false otherwise
   */
  fileExists(path: string): Promise<boolean>;

  /**
   * Delete a task
   * @param id Task ID to delete
   * @param options Delete options
   * @returns Promise resolving to true if deleted, false otherwise
   */
  deleteTask(id: string, options?: { force?: boolean }): Promise<boolean>;
}

/**
 * TaskBackendFactory interface for creating task backends
 */
export interface TaskBackendFactory {
  /**
   * Create a new task backend
   * @param config Backend configuration
   * @returns Task backend instance
   */
  createBackend(config: TaskBackendConfig): TaskBackend;
}
