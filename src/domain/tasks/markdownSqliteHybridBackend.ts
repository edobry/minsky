/**
 * Markdown Files + SQLite Hybrid Backend
 *
 * Implements true spec/metadata separation by using:
 * - Markdown files for task specifications (content, title, description)
 * - SQLite database for task metadata (relationships, provenance, etc.)
 *
 * This enables file-based specs with rich local metadata.
 */

import { join } from "path";
import { readFile, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import type {
  HybridTaskBackend,
  TaskSpecStorage,
  MetadataDatabase,
  Task,
  TaskSpec,
  TaskMetadata,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
  MetadataQuery,
  BackendCapabilities,
  SpecStorageCapabilities,
} from "./types";
import { createSqliteMetadataDatabase } from "./sqliteMetadataDatabase";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

/**
 * Markdown files specification storage
 * Handles task specs through markdown files in process/tasks/ directory
 */
export class MarkdownFilesSpecStorage implements TaskSpecStorage {
  name = "markdown-files";
  
  constructor(private readonly workspacePath: string) {}

  private get tasksDirectory(): string {
    return join(this.workspacePath, "process", "tasks");
  }

  async listTaskSpecs(options?: TaskListOptions): Promise<TaskSpec[]> {
    try {
      const fs = await import("fs/promises");
      const files = await fs.readdir(this.tasksDirectory);
      
      const specs: TaskSpec[] = [];
      for (const file of files) {
        if (file.endsWith(".md") && file.match(/^\d+/)) {
          const id = file.match(/^(\d+)/)?.[1];
          if (id) {
            const spec = await this.getTaskSpec(id);
            if (spec) {
              specs.push(spec);
            }
          }
        }
      }
      
      return specs;
    } catch (error) {
      log.error("Failed to list markdown task specs", {
        error: getErrorMessage(error as any),
        directory: this.tasksDirectory,
      });
      throw error;
    }
  }

  async getTaskSpec(id: string): Promise<TaskSpec | null> {
    try {
      const files = await import("fs/promises");
      const dirFiles = await files.readdir(this.tasksDirectory);
      
      // Find the markdown file for this task ID
      const taskFile = dirFiles.find(file => 
        file.startsWith(`${id}-`) && file.endsWith(".md")
      );
      
      if (!taskFile) {
        return null;
      }
      
      const filePath = join(this.tasksDirectory, taskFile);
      const content = await readFile(filePath, "utf-8");
      
      // Extract title from the first H1 header
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch?.[1] || taskFile.replace(/^\d+-/, "").replace(/\.md$/, "");
      
      return {
        id,
        title,
        description: content,
        content,
        specPath: filePath,
      };
    } catch (error) {
      if ((error as any)?.code === "ENOENT") {
        return null;
      }
      log.error("Failed to get markdown task spec", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      throw error;
    }
  }

  async createTaskSpec(spec: TaskSpec, options?: CreateTaskOptions): Promise<TaskSpec> {
    try {
      // Generate filename from title
      const sanitizedTitle = spec.title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-");
      
      const filename = `${spec.id}-${sanitizedTitle}.md`;
      const filePath = join(this.tasksDirectory, filename);
      
      // Check if file exists and force is not set
      if (existsSync(filePath) && !options?.force) {
        throw new Error(`Task spec file already exists: ${filename}`);
      }
      
      // Create markdown content
      const content = spec.content || `# ${spec.title}\n\n${spec.description || ""}`;
      
      // Ensure directory exists
      const fs = await import("fs/promises");
      await fs.mkdir(this.tasksDirectory, { recursive: true });
      
      // Write file
      await writeFile(filePath, content, "utf-8");
      
      return {
        ...spec,
        specPath: filePath,
        content,
      };
    } catch (error) {
      log.error("Failed to create markdown task spec", {
        error: getErrorMessage(error as any),
        spec: spec.title,
      });
      throw error;
    }
  }

  async updateTaskSpec(id: string, spec: Partial<TaskSpec>): Promise<void> {
    try {
      const existingSpec = await this.getTaskSpec(id);
      if (!existingSpec) {
        throw new Error(`Task spec not found: ${id}`);
      }
      
      // Update content if title or description changed
      let content = existingSpec.content || "";
      
      if (spec.title && spec.title !== existingSpec.title) {
        // Update the H1 header
        content = content.replace(/^#\s+.+$/m, `# ${spec.title}`);
      }
      
      if (spec.description !== undefined) {
        // Replace everything after the first H1
        const titleMatch = content.match(/^(#\s+.+$)/m);
        if (titleMatch) {
          content = `${titleMatch[1]}\n\n${spec.description}`;
        } else {
          content = `# ${spec.title || existingSpec.title}\n\n${spec.description}`;
        }
      }
      
      if (spec.content) {
        content = spec.content;
      }
      
      // Write updated content
      await writeFile(existingSpec.specPath!, content, "utf-8");
    } catch (error) {
      log.error("Failed to update markdown task spec", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      throw error;
    }
  }

  async deleteTaskSpec(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    try {
      const spec = await this.getTaskSpec(id);
      if (!spec || !spec.specPath) {
        return false;
      }
      
      await unlink(spec.specPath);
      return true;
    } catch (error) {
      log.error("Failed to delete markdown task spec", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      return false;
    }
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getSpecStorageCapabilities(): SpecStorageCapabilities {
    return {
      supportsFullTextSearch: false, // Would need external indexing
      supportsVersionHistory: true, // Through git
      supportsRealTimeSync: false, // File-based
      requiresSpecialWorkspace: true, // Needs workspace for file operations
      supportsTransactions: false, // File system doesn't support transactions
    };
  }
}

/**
 * Configuration for Markdown + SQLite hybrid backend
 */
export interface MarkdownSqliteHybridBackendOptions {
  workspacePath: string;
  metadataDatabasePath?: string;
}

/**
 * Hybrid backend combining Markdown files (specs) with SQLite (metadata)
 */
export class MarkdownSqliteHybridBackend implements HybridTaskBackend {
  name = "markdown-sqlite-hybrid";
  
  readonly specStorage: MarkdownFilesSpecStorage;
  readonly metadataStorage: MetadataDatabase;

  constructor(options: MarkdownSqliteHybridBackendOptions) {
    this.specStorage = new MarkdownFilesSpecStorage(options.workspacePath);
    
    this.metadataStorage = createSqliteMetadataDatabase({
      databasePath: options.metadataDatabasePath,
    });
  }

  async initialize(): Promise<void> {
    await this.metadataStorage.initialize();
  }

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    try {
      // Get specs from markdown files
      const specs = await this.specStorage.listTaskSpecs(options);
      
      // Get metadata for all tasks
      const tasks: Task[] = [];
      for (const spec of specs) {
        const metadata = await this.metadataStorage.getTaskMetadata(spec.id);
        
        // Filter by status if requested
        if (options?.status && metadata?.status !== options.status) {
          continue;
        }
        
        tasks.push({
          id: spec.id,
          title: spec.title,
          description: spec.description,
          status: metadata?.status || "TODO",
          metadata: metadata || {},
          specPath: spec.specPath,
          workspacePath: this.getWorkspacePath(),
        });
      }
      
      return tasks;
    } catch (error) {
      log.error("Failed to list markdown-sqlite hybrid tasks", {
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  async getTask(id: string): Promise<Task | null> {
    try {
      const [spec, metadata] = await Promise.all([
        this.specStorage.getTaskSpec(id),
        this.metadataStorage.getTaskMetadata(id),
      ]);

      if (!spec) {
        return null;
      }

      return {
        id: spec.id,
        title: spec.title,
        description: spec.description,
        status: metadata?.status || "TODO",
        metadata: metadata || {},
        specPath: spec.specPath,
        workspacePath: this.getWorkspacePath(),
      };
    } catch (error) {
      log.error("Failed to get markdown-sqlite hybrid task", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      throw error;
    }
  }

  async createTask(
    spec: TaskSpec,
    metadata?: TaskMetadata,
    options?: CreateTaskOptions
  ): Promise<Task> {
    try {
      // Create spec in markdown
      const createdSpec = await this.specStorage.createTaskSpec(spec, options);
      
      // Create metadata in SQLite
      const taskMetadata: TaskMetadata = {
        ...metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      
      await this.metadataStorage.setTaskMetadata(createdSpec.id, taskMetadata);

      return {
        id: createdSpec.id,
        title: createdSpec.title,
        description: createdSpec.description,
        status: taskMetadata.status || "TODO",
        metadata: taskMetadata,
        specPath: createdSpec.specPath,
        workspacePath: this.getWorkspacePath(),
      };
    } catch (error) {
      log.error("Failed to create markdown-sqlite hybrid task", {
        error: getErrorMessage(error as any),
        spec: spec.title,
      });
      throw error;
    }
  }

  async updateTask(
    id: string,
    updates: { spec?: Partial<TaskSpec>; metadata?: Partial<TaskMetadata> }
  ): Promise<void> {
    try {
      const promises: Promise<any>[] = [];

      // Update spec if provided
      if (updates.spec) {
        promises.push(this.specStorage.updateTaskSpec(id, updates.spec));
      }

      // Update metadata if provided
      if (updates.metadata) {
        const existingMetadata = await this.metadataStorage.getTaskMetadata(id);
        const updatedMetadata: TaskMetadata = {
          ...existingMetadata,
          ...updates.metadata,
          updatedAt: new Date().toISOString(),
        };
        promises.push(this.metadataStorage.setTaskMetadata(id, updatedMetadata));
      }

      await Promise.all(promises);
    } catch (error) {
      log.error("Failed to update markdown-sqlite hybrid task", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      throw error;
    }
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    try {
      const [specDeleted] = await Promise.all([
        this.specStorage.deleteTaskSpec(id, options),
        this.metadataStorage.deleteTaskMetadata(id),
      ]);
      
      return specDeleted;
    } catch (error) {
      log.error("Failed to delete markdown-sqlite hybrid task", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      return false;
    }
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const metadata = await this.metadataStorage.getTaskMetadata(id);
    return metadata?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    const existingMetadata = await this.metadataStorage.getTaskMetadata(id);
    const updatedMetadata: TaskMetadata = {
      ...existingMetadata,
      status: status as any,
      updatedAt: new Date().toISOString(),
    };
    
    await this.metadataStorage.setTaskMetadata(id, updatedMetadata);
  }

  async getTaskMetadata(id: string): Promise<TaskMetadata | null> {
    return this.metadataStorage.getTaskMetadata(id);
  }

  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    const updatedMetadata: TaskMetadata = {
      ...metadata,
      updatedAt: new Date().toISOString(),
    };
    
    await this.metadataStorage.setTaskMetadata(id, updatedMetadata);
  }

  async queryTasksByMetadata(query: MetadataQuery): Promise<Task[]> {
    try {
      // Query metadata first
      const metadataResults = await this.metadataStorage.queryTasks(query);
      
      // Get corresponding specs
      const tasks: Task[] = [];
      for (const metadata of metadataResults) {
        if (metadata.taskId) {
          const spec = await this.specStorage.getTaskSpec(metadata.taskId);
          if (spec) {
            tasks.push({
              id: spec.id,
              title: spec.title,
              description: spec.description,
              status: metadata.status || "TODO",
              metadata,
              specPath: spec.specPath,
              workspacePath: this.getWorkspacePath(),
            });
          }
        }
      }
      
      return tasks;
    } catch (error) {
      log.error("Failed to query markdown-sqlite hybrid tasks by metadata", {
        error: getErrorMessage(error as any),
        query,
      });
      throw error;
    }
  }

  getWorkspacePath(): string {
    return this.specStorage.getWorkspacePath();
  }

  getCapabilities(): BackendCapabilities {
    const specCaps = this.specStorage.getSpecStorageCapabilities();
    
    return {
      // Core operations
      supportsTaskCreation: true,
      supportsTaskUpdate: true,
      supportsTaskDeletion: true,

      // Essential metadata support
      supportsStatus: true,

      // Structural metadata (enabled by SQLite)
      supportsSubtasks: true,
      supportsDependencies: true,

      // Provenance metadata (enabled by SQLite)
      supportsOriginalRequirements: true,
      supportsAiEnhancementTracking: true,

      // Query capabilities
      supportsMetadataQuery: true,
      supportsFullTextSearch: specCaps.supportsFullTextSearch,

      // Update mechanism
      requiresSpecialWorkspace: specCaps.requiresSpecialWorkspace,
      supportsTransactions: false, // File system doesn't support transactions
      supportsRealTimeSync: specCaps.supportsRealTimeSync,
      
      // Hybrid backend indicators
      isHybridBackend: true,
      specStorageType: "markdown-files",
      metadataStorageType: "sqlite",
    };
  }
}

/**
 * Factory function to create Markdown + SQLite hybrid backend
 */
export function createMarkdownSqliteHybridBackend(
  options: MarkdownSqliteHybridBackendOptions
): MarkdownSqliteHybridBackend {
  return new MarkdownSqliteHybridBackend(options);
}