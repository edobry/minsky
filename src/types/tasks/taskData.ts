/**
 * Task data types for functional patterns implementation
 * These types represent the pure data structures used in task operations
 */

import type { TaskStatus } from "../../domain/tasks/taskConstants";

// Re-export task status types from centralized location
export type { TaskStatus } from "../../domain/tasks/taskConstants";
export { TaskStatus as TaskStatusType } from "../../domain/tasks/taskConstants";

/**
 * TaskData represents the pure data representation of a task
 * It contains only the essential data without methods or side effects
 *
 * TASK 283: Task IDs are stored in plain format (e.g., "283") without # prefix.
 * Use formatTaskIdForDisplay() from task-id-utils.ts when displaying to users.
 */
export interface TaskData {
  /** Task ID in storage format (plain number string, e.g., "283") */
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  specPath?: string;
  worklog?: Array<{ timestamp: string; message: string }>;
  mergeInfo?: {
    commitHash?: string;
    mergeDate?: string;
    mergedBy?: string;
    baseBranch?: string;
    prBranch?: string;
  };
}

/**
 * TaskState represents a collection of tasks with any metadata needed
 */
export interface TaskState {
  tasks: TaskData[];
  lastUpdated?: string;
  metadata?: Record<string, any>;
}

/**
 * TaskFilter defines criteria for filtering tasks
 */
export interface TaskFilter {
  status?: TaskStatus;
  id?: string;
  title?: string | RegExp;
  hasSpecPath?: boolean;
}

/**
 * TaskSpecData represents the data structure for a task specification file
 */
export interface TaskSpecData {
  title: string;
  description: string;
  id?: string;
  metadata?: Record<string, any>;
}

/**
 * TaskFileFormat represents the format of a task file (e.g., Markdown)
 */
export interface TaskFileFormat {
  parseContent: (content: any) => TaskState;
  formatContent: (_state: any) => string;
}

/**
 * TaskBackendConfig contains configuration for a specific task backend
 */
export interface TaskBackendConfig {
  name: string;
  workspacePath: string;
  taskFilePath?: string;
  taskSpecPath?: string;
}

/**
 * Task I/O operations result types
 */
export interface TaskFileOperationResult {
  success: boolean;
  error?: Error;
  filePath?: string;
}

export interface TaskReadOperationResult extends TaskFileOperationResult {
  content?: string;
}

export interface TaskWriteOperationResult extends TaskFileOperationResult {
  bytesWritten?: number;
}

/**
 * Convert legacy Task type to TaskData type
 * @param task Legacy Task object
 * @returns TaskData object
 */
export function toTaskData(task: any): TaskData {
  return {
    id: task!.id,
    title: task!.title,
    description: task!.description,
    status: task!.status,
    specPath: task!.specPath,
    worklog: task!.worklog,
    mergeInfo: task!.mergeInfo,
  };
}

/**
 * Convert TaskData to legacy Task type
 * @param taskData TaskData object
 * @returns Legacy Task object
 */
export function fromTaskData(taskData: TaskData): any {
  return {
    id: taskData!.id,
    title: taskData!.title,
    description: taskData!.description,
    status: taskData!.status,
    specPath: taskData!.specPath,
    worklog: taskData!.worklog,
    mergeInfo: taskData!.mergeInfo,
  };
}
