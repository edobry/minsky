import type { Task, TaskBackend } from "./types";
import { promises as fs } from "fs";
import { getTasksFilePath } from "./taskIO";
import { parseTasksFromMarkdown, formatTasksToMarkdown } from "./taskFunctions";

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

// Public service interface used by tests and other modules
export interface MultiBackendTaskService {
  registerBackend(backend: TaskBackend): void;
  listBackends(): TaskBackend[];
  createTask(spec: TaskSpec, backendPrefix?: string): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  listAllTasks(): Promise<Task[]>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
}

// Minimal implementation used by integration tests
export class MultiBackendTaskServiceImpl implements MultiBackendTaskService {
  private readonly backends: TaskBackend[] = [];

  registerBackend(backend: TaskBackend): void {
    this.backends.push(backend);
  }

  listBackends(): TaskBackend[] {
    return [...this.backends];
  }

  private parsePrefixFromId(taskId: string): string | null {
    const match = taskId.match(/^([a-zA-Z0-9_-]+)#/);
    return match ? match[1] : null;
  }

  private getBackendByPrefix(prefix: string | null): TaskBackend | null {
    if (!prefix) return null;
    const found = this.backends.find((b: any) => (b as any).prefix === prefix);
    return found || null;
  }

  private qualifyTaskFromBackend(task: Task | null, backend: TaskBackend | null): Task | null {
    if (!task || !backend) return task;
    const prefix = (backend as any).prefix as string | undefined;
    if (!prefix) return task;
    const id = task.id || "";
    if (id.includes("#")) {
      // If legacy format like #123, convert to md#123; if already qualified, keep
      if (/^#/.test(id)) {
        return { ...task, id: `${prefix}${id}` };
      }
      return task;
    }
    return { ...task, id: `${prefix}#${id}` };
  }

  async createTask(spec: TaskSpec, backendPrefix?: string): Promise<Task> {
    const prefix = backendPrefix || this.parsePrefixFromId(spec.id);
    const backend = this.getBackendByPrefix(prefix);
    if (!backend) {
      throw new Error(`Backend not found for prefix: ${prefix ?? "<none>"}`);
    }
    // Markdown backend supports createTask with TaskSpec object
    const created = await (backend as any).createTask(spec);
    return this.qualifyTaskFromBackend(created, backend)!;
  }

  async getTask(taskId: string): Promise<Task | null> {
    const backend = this.getBackendByPrefix(this.parsePrefixFromId(taskId));
    if (backend) {
      const t = await backend.getTask(taskId);
      return this.qualifyTaskFromBackend(t, backend);
    }
    // Fallback: search all backends
    for (const b of this.backends) {
      const t = await b.getTask(taskId);
      if (t) return t;
    }
    return null;
  }

  async listAllTasks(): Promise<Task[]> {
    const results: Task[] = [];
    for (const b of this.backends) {
      const list = await b.listTasks();
      results.push(...list.map((t) => this.qualifyTaskFromBackend(t, b)!));
    }
    return results;
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task> {
    const backend = this.getBackendByPrefix(this.parsePrefixFromId(taskId));
    if (!backend) {
      throw new Error(`Backend not found for id: ${taskId}`);
    }

    // Update status via backend API if provided
    if (updates.status) {
      await backend.setTaskStatus(taskId, updates.status);
    }

    // Update title directly in tasks.md if provided
    if (typeof updates.title === "string") {
      const workspacePath = backend.getWorkspacePath();
      const tasksFilePath = getTasksFilePath(workspacePath);
      const content = await fs.readFile(tasksFilePath, "utf-8").catch(() => "");
      const tasks = parseTasksFromMarkdown(content);

      // Find task (replicating backend's matching logic)
      const index = tasks.findIndex((task) => {
        if (task.id === taskId) return true;
        const taskLocalId = task.id.includes("#") ? task.id.split("#").pop() : task.id;
        const searchLocalId = taskId.includes("#") ? taskId.split("#").pop() : taskId;
        if (taskLocalId === searchLocalId) return true;
        if (!/^#/.test(taskId) && task.id === `#${taskId}`) return true;
        if (taskId.startsWith("#") && task.id === taskId.substring(1)) return true;
        return false;
      });

      if (index !== -1) {
        tasks[index] = { ...tasks[index], title: updates.title } as any;
        const updated = formatTasksToMarkdown(tasks);
        await fs.writeFile(tasksFilePath, updated, "utf-8");
      }
    }

    const final = await this.getTask(taskId);
    if (!final) {
      throw new Error(`Task not found after update: ${taskId}`);
    }
    return final;
  }

  async deleteTask(taskId: string): Promise<void> {
    const backend = this.getBackendByPrefix(this.parsePrefixFromId(taskId));
    if (!backend) {
      throw new Error(`Backend not found for id: ${taskId}`);
    }
    await backend.deleteTask(taskId);
  }
}

// Backward-compatible factory stub (still unimplemented for production)
export function createMultiBackendTaskService(): MultiBackendTaskService {
  return new MultiBackendTaskServiceImpl();
}
