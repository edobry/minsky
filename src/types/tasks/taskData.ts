/**
 * Task data types for functional patterns implementation
 * These types represent the pure data structures used in task operations
 */

/**
 * TaskData represents the pure data representation of a task
 * It contains only the essential data without methods or side effects
 */
export interface TaskData {
  id: string;
  title: string;
  description?: string;
  status: string;
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
  metadata?: Record<string, unknown>;
}

/**
 * TaskFilter defines criteria for filtering tasks
 */
export interface TaskFilter {
  status?: string;
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
  metadata?: Record<string, unknown>;
}

/**
 * TaskStatusType defines the valid status values for tasks
 */
export enum TaskStatusType {
  TODO = "TODO",
  IN_PROGRESS = "IN-PROGRESS",
  IN_REVIEW = "IN-REVIEW",
  DONE = "DONE"
}

/**
 * TaskFileFormat represents the format of a task file (e.g., Markdown)
 */
export interface TaskFileFormat {
  parseContent: (content: string) => TaskState;
  formatContent: (state: TaskState) => string;
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
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    specPath: task.specPath,
    worklog: task.worklog,
    mergeInfo: task.mergeInfo,
  };
}

/**
 * Convert TaskData to legacy Task type
 * @param taskData TaskData object
 * @returns Legacy Task object
 */
export function fromTaskData(taskData: TaskData): any {
  return {
    id: taskData.id,
    title: taskData.title,
    description: taskData.description,
    status: taskData.status,
    specPath: taskData.specPath,
    worklog: taskData.worklog,
    mergeInfo: taskData.mergeInfo,
  };
} 
