import type { Task } from "./types";
import { parseTaskId, isQualifiedTaskId, extractBackend, extractLocalId } from "./unified-task-id";

// Enhanced TaskBackend interface with prefix property
export interface TaskBackend {
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

// Types for migration and cross-backend operations
export interface TaskExportData {
  spec: TaskSpec;
  metadata: Record<string, unknown>;
  backend: string;
  exportedAt: string;
}

export interface TaskSpec {
  title: string;
  description?: string;
  status?: string;
  [key: string]: unknown;
}

export interface TaskFilters {
  status?: string;
  backend?: string;
  [key: string]: unknown;
}

export interface MigrationResult {
  success: boolean;
  sourceTaskId: string;
  targetTaskId: string;
  conflicts?: string[];
  errors?: string[];
}

export interface CollisionReport {
  total: number;
  collisions: TaskCollision[];
  summary: {
    byBackend: Record<string, number>;
    byType: Record<string, number>;
  };
}

export interface TaskCollision {
  localId: string;
  backends: string[];
  type: "id_collision" | "spec_mismatch" | "metadata_conflict";
  details: string;
}

// Enhanced TaskService with multi-backend routing
export interface MultiBackendTaskService {
  // Backend management
  registerBackend(backend: TaskBackend): void;
  getBackend(backendName: string): TaskBackend | null;
  listBackends(): TaskBackend[];

  // Task operations with automatic routing
  createTask(spec: TaskSpec, backendName?: string): Promise<Task>;
  getTask(qualifiedTaskId: string): Promise<Task | null>;
  updateTask(qualifiedTaskId: string, updates: Partial<Task>): Promise<Task>;
  deleteTask(qualifiedTaskId: string): Promise<void>;

  // Cross-backend operations
  listAllTasks(filters?: TaskFilters): Promise<Task[]>;
  searchTasks(query: string, backends?: string[]): Promise<Task[]>;

  // Migration operations
  migrateTask(sourceId: string, targetBackend: string): Promise<MigrationResult>;
  detectCollisions(): Promise<CollisionReport>;

  // Backend selection for new tasks
  selectBackendForNewTask(): TaskBackend;
}

export class MultiBackendTaskServiceImpl implements MultiBackendTaskService {
  private backends = new Map<string, TaskBackend>();
  private defaultBackend: TaskBackend | null = null;

  registerBackend(backend: TaskBackend): void {
    if (this.backends.has(backend.prefix)) {
      throw new Error(`Backend with prefix '${backend.prefix}' already registered`);
    }

    this.backends.set(backend.prefix, backend);

    // Set first registered backend as default
    if (!this.defaultBackend) {
      this.defaultBackend = backend;
    }
  }

  getBackend(backendName: string): TaskBackend | null {
    return this.backends.get(backendName) || null;
  }

  listBackends(): TaskBackend[] {
    return Array.from(this.backends.values());
  }

  selectBackendForNewTask(): TaskBackend {
    if (!this.defaultBackend) {
      throw new Error("No backends registered");
    }
    return this.defaultBackend;
  }

  private routeToBackend(qualifiedTaskId: string): { backend: TaskBackend; localId: string } {
    // Check if it looks like a qualified ID first (has # in it)
    if (qualifiedTaskId.includes("#")) {
      const parsed = parseTaskId(qualifiedTaskId);
      if (parsed) {
        const backend = this.backends.get(parsed.backend);
        if (!backend) {
          throw new Error(`No backend registered for prefix '${parsed.backend}'`);
        }
        return { backend, localId: parsed.localId };
      } else {
        // Malformed qualified ID - still try to extract backend for error
        const hashIndex = qualifiedTaskId.indexOf("#");
        const backendPrefix = qualifiedTaskId.substring(0, hashIndex);
        throw new Error(`No backend registered for prefix '${backendPrefix}'`);
      }
    }

    // Handle unqualified IDs - use default backend
    if (!this.defaultBackend) {
      throw new Error("No default backend available for unqualified task ID");
    }
    return { backend: this.defaultBackend, localId: qualifiedTaskId };
  }

  async createTask(spec: TaskSpec, backendName?: string): Promise<Task> {
    let backend: TaskBackend;

    if (backendName) {
      const selectedBackend = this.getBackend(backendName);
      if (!selectedBackend) {
        throw new Error(`Backend '${backendName}' not found`);
      }
      backend = selectedBackend;
    } else {
      backend = this.selectBackendForNewTask();
    }

    return await backend.createTask(spec);
  }

  async getTask(qualifiedTaskId: string): Promise<Task | null> {
    const { backend, localId } = this.routeToBackend(qualifiedTaskId);
    return await backend.getTask(localId);
  }

  async updateTask(qualifiedTaskId: string, updates: Partial<Task>): Promise<Task> {
    const { backend, localId } = this.routeToBackend(qualifiedTaskId);
    return await backend.updateTask(localId, updates);
  }

  async deleteTask(qualifiedTaskId: string): Promise<void> {
    const { backend, localId } = this.routeToBackend(qualifiedTaskId);
    await backend.deleteTask(localId);
  }

  async listAllTasks(filters?: TaskFilters): Promise<Task[]> {
    if (filters?.backend) {
      // Filter by specific backend
      const backend = this.getBackend(filters.backend);
      if (!backend) {
        return [];
      }
      return await backend.listTasks(filters);
    }

    // Get tasks from all backends
    const allTasks: Task[] = [];
    const backends = this.listBackends();

    await Promise.all(
      backends.map(async (backend) => {
        try {
          const tasks = await backend.listTasks(filters);
          allTasks.push(...tasks);
        } catch (error) {
          // Log error but continue with other backends
          console.warn(`Failed to list tasks from backend ${backend.name}:`, error);
        }
      })
    );

    return allTasks;
  }

  async searchTasks(query: string, backends?: string[]): Promise<Task[]> {
    const backendsToSearch = backends
      ? (backends.map((name) => this.getBackend(name)).filter(Boolean) as TaskBackend[])
      : this.listBackends();

    const results: Task[] = [];

    await Promise.all(
      backendsToSearch.map(async (backend) => {
        try {
          const tasks = await backend.listTasks();
          const matchingTasks = tasks.filter(
            (task) =>
              task.title.toLowerCase().includes(query.toLowerCase()) ||
              task.description?.toLowerCase().includes(query.toLowerCase())
          );
          results.push(...matchingTasks);
        } catch (error) {
          console.warn(`Failed to search tasks in backend ${backend.name}:`, error);
        }
      })
    );

    return results;
  }

  async migrateTask(sourceId: string, targetBackend: string): Promise<MigrationResult> {
    try {
      const { backend: sourceBackend, localId } = this.routeToBackend(sourceId);
      const targetBackendInstance = this.getBackend(targetBackend);

      if (!targetBackendInstance) {
        return {
          success: false,
          sourceTaskId: sourceId,
          targetTaskId: "",
          errors: [`Target backend '${targetBackend}' not found`],
        };
      }

      // Export from source
      const exportData = await sourceBackend.exportTask(localId);

      // Import to target
      const newTask = await targetBackendInstance.importTask(exportData);

      return {
        success: true,
        sourceTaskId: sourceId,
        targetTaskId: newTask.id,
      };
    } catch (error) {
      return {
        success: false,
        sourceTaskId: sourceId,
        targetTaskId: "",
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  async detectCollisions(): Promise<CollisionReport> {
    const allTasks = await this.listAllTasks();
    const collisionMap = new Map<string, string[]>();

    // Group tasks by local ID
    for (const task of allTasks) {
      const localId = extractLocalId(task.id);
      if (localId) {
        const backend = extractBackend(task.id);
        if (backend) {
          if (!collisionMap.has(localId)) {
            collisionMap.set(localId, []);
          }
          collisionMap.get(localId)!.push(backend);
        }
      }
    }

    // Find collisions (same local ID across multiple backends)
    const collisions: TaskCollision[] = [];
    const backendCounts: Record<string, number> = {};

    for (const [localId, backends] of collisionMap.entries()) {
      if (backends.length > 1) {
        collisions.push({
          localId,
          backends,
          type: "id_collision",
          details: `Task ID '${localId}' exists in multiple backends: ${backends.join(", ")}`,
        });

        for (const backend of backends) {
          backendCounts[backend] = (backendCounts[backend] || 0) + 1;
        }
      }
    }

    return {
      total: collisions.length,
      collisions,
      summary: {
        byBackend: backendCounts,
        byType: {
          id_collision: collisions.length,
        },
      },
    };
  }
}

// Factory function for dependency injection
export function createMultiBackendTaskService(): MultiBackendTaskService {
  return new MultiBackendTaskServiceImpl();
}
