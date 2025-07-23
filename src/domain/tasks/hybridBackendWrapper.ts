/**
 * Hybrid Backend Wrapper
 *
 * Wraps any existing TaskBackend with SQLite metadata storage
 * This provides true spec/metadata separation without rewriting backends
 */

import type {
  TaskBackend,
  Task,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
  BackendCapabilities,
  TaskMetadata,
  MetadataQuery,
} from "./types";
import { createSqliteMetadataDatabase } from "./sqliteMetadataDatabase";
import type { SqliteMetadataDatabaseOptions } from "./sqliteMetadataDatabase";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

/**
 * Configuration for hybrid backend wrapper
 */
export interface HybridBackendWrapperOptions {
  /** The underlying task backend to wrap */
  backend: TaskBackend;
  /** SQLite database configuration */
  metadataDatabase?: SqliteMetadataDatabaseOptions;
}

/**
 * Wraps a TaskBackend with SQLite metadata storage
 * Provides spec/metadata separation for any backend
 */
export class HybridBackendWrapper implements TaskBackend {
  name: string;
  private readonly backend: TaskBackend;
  private readonly metadataDb: any; // MetadataDatabase interface

  constructor(options: HybridBackendWrapperOptions) {
    this.backend = options.backend;
    this.name = `${options.backend.name}-hybrid`;
    this.metadataDb = createSqliteMetadataDatabase(options.metadataDatabase || {});
  }

  async initialize(): Promise<void> {
    await this.metadataDb.initialize();
  }

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    try {
      // Get tasks from underlying backend
      const backendTasks = await this.backend.listTasks(options);
      
      // Enrich with metadata
      const tasks: Task[] = [];
      for (const task of backendTasks) {
        const metadata = await this.metadataDb.getTaskMetadata(task.id);
        
        // Merge backend task with metadata
        tasks.push({
          ...task,
          status: metadata?.status || task.status,
          metadata: metadata || {},
        });
      }
      
      return tasks;
    } catch (error) {
      log.error("Failed to list hybrid backend tasks", {
        error: getErrorMessage(error as any),
        backend: this.backend.name,
      });
      throw error;
    }
  }

  async getTask(id: string): Promise<Task | null> {
    try {
      const backendTask = await this.backend.getTask(id);
      if (!backendTask) {
        return null;
      }

      const metadata = await this.metadataDb.getTaskMetadata(id);
      
      return {
        ...backendTask,
        status: metadata?.status || backendTask.status,
        metadata: metadata || {},
      };
    } catch (error) {
      log.error("Failed to get hybrid backend task", {
        error: getErrorMessage(error as any),
        taskId: id,
        backend: this.backend.name,
      });
      throw error;
    }
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    // Check metadata first, fall back to backend
    const metadata = await this.metadataDb.getTaskMetadata(id);
    if (metadata?.status) {
      return metadata.status;
    }
    
    return this.backend.getTaskStatus(id);
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    try {
      // Update metadata
      const existingMetadata = await this.metadataDb.getTaskMetadata(id);
      const updatedMetadata: TaskMetadata = {
        ...existingMetadata,
        taskId: id,
        status: status as any,
        updatedAt: new Date().toISOString(),
      };
      
      await this.metadataDb.setTaskMetadata(id, updatedMetadata);
      
      // Also update backend if it supports it
      await this.backend.setTaskStatus(id, status);
    } catch (error) {
      log.error("Failed to set hybrid backend task status", {
        error: getErrorMessage(error as any),
        taskId: id,
        status,
      });
      throw error;
    }
  }

  getWorkspacePath(): string {
    return this.backend.getWorkspacePath();
  }

  async createTask(specPath: string, options?: CreateTaskOptions): Promise<Task> {
    try {
      // Create task in backend
      const task = await this.backend.createTask(specPath, options);
      
      // Create metadata
      const metadata: TaskMetadata = {
        taskId: task.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: task.status as any,
      };
      
      await this.metadataDb.setTaskMetadata(task.id, metadata);
      
      return {
        ...task,
        metadata,
      };
    } catch (error) {
      log.error("Failed to create hybrid backend task", {
        error: getErrorMessage(error as any),
        specPath,
      });
      throw error;
    }
  }

  async createTaskFromTitleAndDescription(
    title: string,
    description: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    try {
      // Create task in backend
      const task = await this.backend.createTaskFromTitleAndDescription(title, description, options);
      
      // Create metadata
      const metadata: TaskMetadata = {
        taskId: task.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: task.status as any,
      };
      
      await this.metadataDb.setTaskMetadata(task.id, metadata);
      
      return {
        ...task,
        metadata,
      };
    } catch (error) {
      log.error("Failed to create hybrid backend task from title/description", {
        error: getErrorMessage(error as any),
        title,
      });
      throw error;
    }
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    try {
      const backendResult = await this.backend.deleteTask(id, options);
      
      // Delete metadata if backend deletion succeeded
      if (backendResult) {
        await this.metadataDb.deleteTaskMetadata(id);
      }
      
      return backendResult;
    } catch (error) {
      log.error("Failed to delete hybrid backend task", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      return false;
    }
  }

  getCapabilities(): BackendCapabilities {
    // Get backend capabilities if available, otherwise use defaults
    const backendCaps = typeof this.backend.getCapabilities === 'function' 
      ? this.backend.getCapabilities()
      : {
          supportsTaskCreation: true,
          supportsTaskUpdate: true,
          supportsTaskDeletion: true,
          supportsStatus: true,
          supportsSubtasks: false,
          supportsDependencies: false,
          supportsOriginalRequirements: false,
          supportsAiEnhancementTracking: false,
          supportsMetadataQuery: false,
          supportsFullTextSearch: false,
          requiresSpecialWorkspace: false,
          supportsTransactions: false,
          supportsRealTimeSync: false,
          isHybridBackend: false,
        };
    
    return {
      ...backendCaps,
      // Enhanced with metadata capabilities
      supportsMetadataQuery: true,
      supportsSubtasks: true,
      supportsDependencies: true,
      supportsOriginalRequirements: true,
      supportsAiEnhancementTracking: true,
      
      // Hybrid backend indicators
      isHybridBackend: true,
      specStorageType: this.backend.name,
      metadataStorageType: "sqlite",
    };
  }

  // Metadata-specific methods
  async getTaskMetadata(id: string): Promise<TaskMetadata | null> {
    return this.metadataDb.getTaskMetadata(id);
  }

  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    const updatedMetadata: TaskMetadata = {
      ...metadata,
      taskId: id,
      updatedAt: new Date().toISOString(),
    };
    
    await this.metadataDb.setTaskMetadata(id, updatedMetadata);
  }

  async queryTasksByMetadata(query: MetadataQuery): Promise<Task[]> {
    try {
      // Query metadata
      const metadataResults = await this.metadataDb.queryTasks(query);
      
      // Get corresponding tasks from backend
      const tasks: Task[] = [];
      for (const metadata of metadataResults) {
        if (metadata.taskId) {
          const task = await this.backend.getTask(metadata.taskId);
          if (task) {
            tasks.push({
              ...task,
              status: metadata.status || task.status,
              metadata,
            });
          }
        }
      }
      
      return tasks;
    } catch (error) {
      log.error("Failed to query hybrid backend tasks by metadata", {
        error: getErrorMessage(error as any),
        query,
      });
      throw error;
    }
  }
}

/**
 * Factory function to create a hybrid backend wrapper
 */
export function createHybridBackend(
  backend: TaskBackend,
  options?: SqliteMetadataDatabaseOptions
): HybridBackendWrapper {
  return new HybridBackendWrapper({
    backend,
    metadataDatabase: options,
  });
}