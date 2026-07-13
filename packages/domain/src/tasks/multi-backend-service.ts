import { injectable } from "tsyringe";
import type {
  Task,
  TaskBackend,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
} from "./types";
export type { TaskBackend } from "./types";
import type { TaskServiceInterface } from "../tasks";
import { log } from "@minsky/shared/logger";

// Multi-backend specific interface - different from the main TaskBackend interface
export interface MultiBackendTaskBackend {
  name: string;
  prefix: string; // Backend-specific prefix for qualified IDs
  createTask(spec: TaskSpec): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
  listTasks(filters?: TaskFilters): Promise<Task[]>;
  supportsFeature(feature: string): boolean;
  // New multi-backend methods
  exportTask(taskId: string): Promise<TaskExportData>;
  importTask(data: TaskExportData): Promise<Task>;
  validateLocalId(localId: string): boolean;
}

export interface TaskSpec {
  id: string;
  title: string;
  spec: string;
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
  exportedAt?: string;
}

// Types for migration result tracking
export interface MigrationResult {
  success: boolean;
  tasksMigrated: number;
  errors: string[];
  backupFile?: string;
}

// Types for collision detection between backends
export interface TaskCollision {
  taskId: string;
  backends: string[];
  conflictType: "id" | "title" | "both";
}

export interface CollisionReport {
  collisions: TaskCollision[];
  totalChecked: number;
  hasConflicts: boolean;
}

// Public service interface - extends TaskServiceInterface for compatibility
export interface TaskService extends TaskServiceInterface {
  // Multi-backend specific methods
  registerBackend(backend: TaskBackend): void;
  listBackends(): TaskBackend[];

  // Additional multi-backend methods
  updateTask(taskId: string, updates: Partial<Task>): Promise<Task>;
}

// Complete implementation that supports both single-backend and multi-backend operations
@injectable()
export class TaskServiceImpl implements TaskService {
  private readonly backends: TaskBackend[] = [];
  private readonly workspacePath: string;
  private defaultBackend: TaskBackend | null = null;

  constructor(options: { workspacePath: string }) {
    this.workspacePath = options.workspacePath;
  }

  registerBackend(backend: TaskBackend): void {
    this.backends.push(backend);
    // Set first backend as default for unqualified IDs
    if (!this.defaultBackend) {
      this.defaultBackend = backend;
    }
  }

  setDefaultBackend(backendName: string): void {
    const backend = this.backends.find((b) => b.name === backendName);
    if (backend) {
      this.defaultBackend = backend;
    } else {
      log.warn(`Cannot set default backend '${backendName}' - backend not found`, {
        availableBackends: this.backends.map((b) => b.name),
      });
    }
  }

  listBackends(): TaskBackend[] {
    return [...this.backends];
  }

  private parsePrefixFromId(taskId: string): string | null {
    const match = taskId.match(/^([a-zA-Z0-9_-]+)#/);
    return match ? match[1] || null : null;
  }

  private getBackendByPrefix(prefix: string | null): TaskBackend | null {
    if (!prefix) return null;
    const found = this.backends.find((b) => b.prefix === prefix);
    return found || null;
  }

  private qualifyTaskFromBackend(task: Task | null, backend: TaskBackend | null): Task | null {
    if (!task || !backend) return task;
    const prefix = backend.prefix;
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

  // TaskServiceInterface implementation
  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const results: Task[] = [];
    for (const b of this.backends) {
      const list = await b.listTasks(options);
      results.push(
        ...list.map((t) => this.qualifyTaskFromBackend(t, b)).filter((t): t is Task => t !== null)
      );
    }
    return results;
  }

  // Alias for backward compatibility
  async listAllTasks(): Promise<Task[]> {
    return this.listTasks();
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task> {
    const backend = this.getBackendByPrefix(this.parsePrefixFromId(taskId));
    if (!backend) {
      throw new Error(`Backend not found for id: ${taskId}`);
    }

    // Get current task to merge with updates
    const currentTask = await backend.getTask(taskId);
    if (!currentTask) {
      throw new Error(`Task ${taskId} not found`);
    }

    // If backend has setTaskMetadata method, use it for comprehensive updates
    type BackendWithMetadata = typeof backend & {
      setTaskMetadata: (id: string, meta: Record<string, unknown>) => Promise<void>;
    };
    if (
      "setTaskMetadata" in backend &&
      typeof (backend as BackendWithMetadata).setTaskMetadata === "function"
    ) {
      const metadata = {
        id: taskId,
        title: updates.title !== undefined ? updates.title : currentTask.title,
        status: updates.status !== undefined ? updates.status : currentTask.status,
        spec: updates.spec,
        backend: currentTask.backend || backend.name,
        updatedAt: new Date(),
      };

      await (backend as BackendWithMetadata).setTaskMetadata(taskId, metadata);
    } else {
      // Fallback to individual updates for backends without setTaskMetadata

      // Update status via backend API if provided
      if (updates.status) {
        await backend.setTaskStatus(taskId, updates.status);
      }
    }

    // Handle tags update if backend supports it
    if (updates.tags !== undefined) {
      if (backend.getCapabilities().supportsTags && backend.updateTags) {
        await backend.updateTags(taskId, updates.tags);
      } else {
        log.warn(
          `Backend "${backend.name}" does not support tags; tag update skipped for ${taskId}`
        );
      }
    }

    const final = await this.getTask(taskId);
    // In tests with mocked IO, allow eventual consistency without throwing
    return (final || (await backend.getTask(taskId))) as Task;
  }

  async getTasks(ids: string[]): Promise<Task[]> {
    if (ids.length === 0) return [];

    // Partition IDs by backend prefix
    const byBackend = new Map<TaskBackend, string[]>();
    const unrouted: string[] = [];

    for (const id of ids) {
      const backend = this.getBackendByPrefix(this.parsePrefixFromId(id));
      if (backend) {
        const existing = byBackend.get(backend) ?? [];
        existing.push(id);
        byBackend.set(backend, existing);
      } else {
        unrouted.push(id);
      }
    }

    const results: Task[] = [];

    // Fetch from each backend, using batch getTasks if available, otherwise sequential
    for (const [backend, backendIds] of byBackend) {
      if (typeof backend.getTasks === "function") {
        const tasks = await backend.getTasks(backendIds);
        results.push(
          ...tasks
            .map((t) => this.qualifyTaskFromBackend(t, backend))
            .filter((t): t is Task => t !== null)
        );
      } else {
        for (const id of backendIds) {
          const t = await backend.getTask(id);
          if (t) {
            const qualified = this.qualifyTaskFromBackend(t, backend);
            if (qualified) results.push(qualified);
          }
        }
      }
    }

    // Unrouted IDs: search all backends sequentially
    for (const id of unrouted) {
      for (const b of this.backends) {
        const t = await b.getTask(id);
        if (t) {
          const qualified = this.qualifyTaskFromBackend(t, b);
          if (qualified) results.push(qualified);
          break;
        }
      }
    }

    return results;
  }

  async deleteTask(taskId: string, options?: DeleteTaskOptions): Promise<boolean> {
    const prefix = this.parsePrefixFromId(taskId);
    const backend = this.getBackendByPrefix(prefix);

    // Primary route: attempt deletion via routed backend when available
    if (backend) {
      const deleted = await backend.deleteTask(taskId, options);
      if (deleted) {
        return true;
      }
      // Fall through to fallback search if primary backend reported not deleted
    }

    // Fallback: locate the task on any registered backend and delete there
    // This handles cases where IDs are qualified with a prefix whose backend
    // is unavailable, or where the task is stored under a different backend
    // but shares the same local identifier.
    for (const b of this.backends) {
      try {
        const found = await b.getTask(taskId);
        if (found) {
          const deleted = await b.deleteTask(taskId, options);
          if (deleted) return true;
        }
      } catch (_err) {
        // Ignore and continue trying other backends
      }
    }

    // If nothing deleted, return false to allow caller to format a failure
    return false;
  }

  // ---- TaskServiceInterface Required Methods ----

  async getTaskStatus(id: string): Promise<string | undefined> {
    // 1. Dedicated status read on the routed backend (single source of truth
    //    when available). Avoids early-returning from `backend.getTask`, which
    //    could surface backend-internal caches.
    try {
      const backend = this.routeToBackend(id);
      try {
        const status = await backend.getTaskStatus(id);
        if (typeof status !== "undefined") return status;
      } catch {
        // ignore: backend may not implement getTaskStatus directly
      }

      // 1b. Backend list-scan fallback for partial-implementation mocks where
      //     getTaskStatus is unimplemented but listTasks populates rows.
      try {
        const list = await backend.listTasks();
        const found = list.find((t) => {
          if (t.id === id) return true;
          const taskLocalId = t.id.includes("#") ? t.id.split("#").pop() : t.id;
          const searchLocalId = id.includes("#") ? id.split("#").pop() : id;
          if (taskLocalId === searchLocalId) return true;
          if (!/^#/.test(id) && t.id === `#${id}`) return true;
          if (id.startsWith("#") && t.id === id.substring(1)) return true;
          return false;
        });
        if (found && typeof found.status !== "undefined") return found.status;
      } catch {
        // ignore list errors in mocked environments
      }
    } catch {
      // routeToBackend threw (no prefix routes, no default backend); fall
      // through to the cross-backend aggregated search below rather than
      // throwing — preserves previous tolerance during boot / partial wiring.
    }

    // 2. Cross-backend aggregated search as final fallback. Tolerant of
    //    routing failures and unqualified IDs that match across backends.
    const task = await this.getTask(id);
    return typeof task?.status !== "undefined" ? task.status : undefined;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    const backend = this.routeToBackend(id);
    await backend.setTaskStatus(id, status);
    // Ensure cached reads see the updated status in mocked environments
    try {
      await backend.getTask(id); // touch backend to refresh any caches; ignore result
    } catch (_e) {
      // ignore errors from touch read in tests
    }
    return;
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    // If the caller requested a specific backend, route there instead of using the
    // configured default.  This is the fix for mt#2572 Bug 4: when the minsky DB
    // backend is down, GitHub becomes the effective defaultBackend, so tasks_create
    // with backend:"minsky" would silently create gh# issues.  Now we look up the
    // requested backend explicitly and throw a clear error if it isn't registered.
    let backend: (typeof this.backends)[number] | null | undefined = this.defaultBackend;

    if (options?.backend) {
      const requestedName = options.backend;
      backend = this.backends.find((b) => b.name === requestedName || b.prefix === requestedName);
      if (!backend) {
        const available = this.backends.map((b) => `${b.name}(${b.prefix}#)`).join(", ");
        throw new Error(
          `Requested backend '${requestedName}' is not registered. ` +
            `Available backends: ${available || "none"}. ` +
            `If you expected '${requestedName}' to be available, check the database ` +
            `connection and backend configuration.`
        );
      }
    }

    if (!backend) {
      throw new Error("No backends registered");
    }

    const created = await backend.createTaskFromTitleAndSpec(title, spec, options);
    const qualified = this.qualifyTaskFromBackend(created, backend);
    if (!qualified) {
      throw new Error(`Failed to qualify created task from backend: ${backend.name}`);
    }
    return qualified;
  }

  async getBackendForTask(taskId: string): Promise<string> {
    const prefix = this.parsePrefixFromId(taskId);
    if (prefix) {
      const backend = this.getBackendByPrefix(prefix);
      return backend?.name || "unknown";
    }
    return this.defaultBackend?.name || "default";
  }

  // ---- TaskServiceInterface Required Methods (continued) ----

  async getTaskSpecContent(
    taskId: string,
    section?: string
  ): Promise<{ task: Task; specPath: string; content: string; section?: string }> {
    const backend = this.routeToBackend(taskId);

    // Get the task first
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Check if backend has a getTaskSpecContent method
    type BackendWithSpecContent = typeof backend & {
      getTaskSpecContent: (
        id: string,
        section?: string
      ) => Promise<{ task: Task; specPath: string; content: string; section?: string }>;
    };
    if ((backend as BackendWithSpecContent).getTaskSpecContent) {
      return await (backend as BackendWithSpecContent).getTaskSpecContent(taskId, section);
    }

    // Fallback: return empty content — spec is stored in the backend, not on disk
    return {
      task,
      specPath: "",
      content: task.spec || "",
      section,
    };
  }

  // ---- Helper Methods ----

  private routeToBackend(taskId: string): TaskBackend {
    const backend = this.getBackendByPrefix(this.parsePrefixFromId(taskId)) || this.defaultBackend;
    if (!backend) {
      throw new Error(`No backend available for task: ${taskId}`);
    }
    return backend;
  }
}

// Production-ready factory function
export function createTaskService(options: { workspacePath: string }): TaskService {
  return new TaskServiceImpl(options);
}
