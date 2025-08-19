import type { Task } from "./types";

// Multi-backend specific interface - different from the main TaskBackend interface
export interface MultiBackendTaskBackend {
  name: string;
  prefix: string; // Backend-specific prefix for qualified IDs
  createTask(spec: TaskSpec): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
  listTasks(filters?: TaskFilters): Promise<Task[]>;
  getTaskSpecPath(taskId: string): string;
  supportsFeature(feature: string): boolean;
  // New multi-backend methods
  exportTask(taskId: string): Promise<TaskExportData>;
  importTask(data: TaskExportData): Promise<Task>;
  validateLocalId(localId: string): boolean;
}

export interface TaskSpec {
  id: string;
  title: string;
  description: string;
  status: string;
}

export interface TaskFilters {
  status?: string;
  backend?: string;
}

// Types for migration and cross-backend operations
export interface TaskExportData {
  spec: TaskSpec;
  metadata: Record<string, unknown>;
  backend: string;
}

// ... rest of existing code ...
