/**
 * JsonFileTaskBackend implementation
 * 
 * Uses the DatabaseStorage abstraction to store tasks in JSON format.
 * This provides a more robust backend than the markdown format while
 * maintaining the same interface.
 */

import { join, dirname } from "path";
import type { TaskData, TaskState, TaskSpecData, TaskBackendConfig } from "../../types/tasks/taskData.js";
import type { TaskReadOperationResult, TaskWriteOperationResult } from "../../types/tasks/taskData.js";
import type { TaskBackend } from "./taskBackend.js";
import { createJsonFileStorage } from "../storage/json-file-storage.js";
import type { DatabaseStorage } from "../storage/database-storage.js";
import { log } from "../../utils/logger.js";
import { readFile, writeFile, mkdir, access } from "fs/promises";

/**
 * Configuration for JsonFileTaskBackend
 */
export interface JsonFileTaskBackendOptions extends TaskBackendConfig {
  /**
   * Custom database file path (optional)
   * If not provided, uses a default local path
   */
  dbFilePath?: string;
}

/**
 * JsonFileTaskBackend implementation using DatabaseStorage
 */
export class JsonFileTaskBackend implements TaskBackend {
  name = "json-file";
  private readonly workspacePath: string;
  private readonly storage: DatabaseStorage<TaskData, TaskState>;
  private readonly tasksDirectory: string;

  constructor(options: JsonFileTaskBackendOptions) {
    this.workspacePath = options.workspacePath;
    this.tasksDirectory = join(this.workspacePath, "process", "tasks");

    // Use provided path or default to local state directory
    const defaultDbPath = join(process.cwd(), ".minsky", "tasks.json");
    const dbFilePath = options.dbFilePath || defaultDbPath;

    // Create storage instance
    this.storage = createJsonFileStorage<TaskData, TaskState>({
      filePath: dbFilePath,
      entitiesField: "tasks",
      idField: "id",
      initializeState: () => ({
        tasks: [],
        lastUpdated: new Date().toISOString(),
        metadata: {}
      }),
      prettyPrint: true,
    });
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    try {
      const result = await this.storage.readState();
      if (!result.success) {
        return {
          success: false,
          error: result.error,
          filePath: this.storage.getStorageLocation()
        };
      }

      // Convert state to a tasks.md-like format for compatibility
      const tasks = result.data?.tasks || [];
      const content = this.formatTasks(tasks);

      return {
        success: true,
        content,
        filePath: this.storage.getStorageLocation()
      };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: typedError,
        filePath: this.storage.getStorageLocation()
      };
    }
  }

  async getTaskSpecData(specPath: string): Promise<TaskReadOperationResult> {
    try {
      const fullPath = specPath.startsWith("/") 
        ? specPath 
        : join(this.workspacePath, specPath);

      const content = await readFile(fullPath, "utf8");
      return {
        success: true,
        content,
        filePath: fullPath
      };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: typedError,
        filePath: specPath
      };
    }
  }

  // ---- Pure Operations ----

  parseTasks(content: string): TaskData[] {
    // Try to parse as JSON first
    try {
      const data = JSON.parse(content);
      if (data.tasks && Array.isArray(data.tasks)) {
        return data.tasks;
      }
    } catch {
      // If JSON parsing fails, fall back to markdown parsing
      return this.parseMarkdownTasks(content);
    }

    return [];
  }

  formatTasks(tasks: TaskData[]): string {
    // Format as JSON for storage
    const state: TaskState = {
      tasks,
      lastUpdated: new Date().toISOString(),
      metadata: {}
    };
    return JSON.stringify(state, null, 2);
  }

  parseTaskSpec(content: string): TaskSpecData {
    // Basic parsing of task spec content
    const lines = content.split('\n');
    let title = '';
    let description = '';
    let id = '';
    let inDescription = false;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) {
        const headerText = trimmed.slice(2);
        
        // Try to extract task ID and title from header like "Task #123: Title"
        const taskMatch = headerText.match(/^Task\s+#?(\d+):\s*(.+)$/);
        if (taskMatch && taskMatch[1] && taskMatch[2]) {
          id = `#${taskMatch[1]}`;
          title = taskMatch[2].trim();
        } else {
          // Fallback: use entire header as title
          title = headerText.trim();
        }
      } else if (trimmed === '## Context' || trimmed === '## Description') {
        inDescription = true;
      } else if (trimmed.startsWith('## ') && inDescription) {
        inDescription = false;
      } else if (inDescription && trimmed) {
        description += (description ? '\n' : '') + trimmed;
      }
    }
    
    return {
      id,
      title,
      description: description.trim(),
      metadata: {}
    };
  }

  formatTaskSpec(spec: TaskSpecData): string {
    // Create markdown content
    return `# ${spec.title}\n\n## Context\n\n${spec.description}\n`;
  }

  // ---- Side Effects ----

  async saveTasksData(content: string): Promise<TaskWriteOperationResult> {
    try {
      // Parse the content to get tasks
      const tasks = this.parseTasks(content);
      
      // Create state object
      const state: TaskState = {
        tasks,
        lastUpdated: new Date().toISOString(),
        metadata: {}
      };

      // Initialize storage if needed
      await this.storage.initialize();

      // Write to storage
      const result = await this.storage.writeState(state);
      
      return {
        success: result.success,
        error: result.error,
        bytesWritten: result.bytesWritten,
        filePath: this.storage.getStorageLocation()
      };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: typedError,
        filePath: this.storage.getStorageLocation()
      };
    }
  }

  async saveTaskSpecData(specPath: string, content: string): Promise<TaskWriteOperationResult> {
    try {
      const fullPath = specPath.startsWith("/") 
        ? specPath 
        : join(this.workspacePath, specPath);

      // Ensure directory exists
      const dir = dirname(fullPath);
      await mkdir(dir, { recursive: true });

      // Write file
      await writeFile(fullPath, content, "utf8");

      return {
        success: true,
        bytesWritten: content.length,
        filePath: fullPath
      };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: typedError,
        filePath: specPath
      };
    }
  }

  // ---- Helper Methods ----

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getTaskSpecPath(taskId: string, title: string): string {
    const id = taskId.startsWith("#") ? taskId.slice(1) : taskId;
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return join("process", "tasks", `${id}-${normalizedTitle}.md`);
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  // ---- Database-specific methods ----

  /**
   * Get all tasks from the database
   * @returns Promise resolving to array of task data
   */
  async getAllTasks(): Promise<TaskData[]> {
    try {
      await this.storage.initialize();
      return await this.storage.getEntities();
    } catch (error) {
      log.error("Failed to get all tasks from database", { 
        error: error instanceof Error ? error.message : String(error) 
      });
      return [];
    }
  }

  /**
   * Get a task by ID from the database
   * @param id Task ID
   * @returns Promise resolving to task data or null
   */
  async getTaskById(id: string): Promise<TaskData | null> {
    try {
      await this.storage.initialize();
      return await this.storage.getEntity(id);
    } catch (error) {
      log.error("Failed to get task by ID from database", { 
        id,
        error: error instanceof Error ? error.message : String(error) 
      });
      return null;
    }
  }

  /**
   * Create a new task in the database
   * @param task Task data to create
   * @returns Promise resolving to created task data
   */
  async createTaskData(task: TaskData): Promise<TaskData> {
    try {
      await this.storage.initialize();
      return await this.storage.createEntity(task);
    } catch (error) {
      log.error("Failed to create task in database", { 
        task,
        error: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }

  /**
   * Update a task in the database
   * @param id Task ID
   * @param updates Task data updates
   * @returns Promise resolving to updated task data or null
   */
  async updateTaskData(id: string, updates: Partial<TaskData>): Promise<TaskData | null> {
    try {
      await this.storage.initialize();
      return await this.storage.updateEntity(id, updates);
    } catch (error) {
      log.error("Failed to update task in database", { 
        id,
        updates,
        error: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }

  /**
   * Delete a task from the database
   * @param id Task ID
   * @returns Promise resolving to true if deleted, false if not found
   */
  async deleteTaskData(id: string): Promise<boolean> {
    try {
      await this.storage.initialize();
      return await this.storage.deleteEntity(id);
    } catch (error) {
      log.error("Failed to delete task from database", { 
        id,
        error: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }

  /**
   * Get the database storage location
   * @returns Storage location path
   */
  getStorageLocation(): string {
    return this.storage.getStorageLocation();
  }

  // ---- Private helper methods ----

  /**
   * Parse tasks from markdown format (for backwards compatibility)
   * @param content Markdown content
   * @returns Array of task data
   * @private
   */
  private parseMarkdownTasks(content: string): TaskData[] {
    const tasks: TaskData[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- [ ] ') || trimmed.startsWith('- [x] ')) {
        const completed = trimmed.startsWith('- [x] ');
        const taskLine = trimmed.slice(6); // Remove '- [ ] ' or '- [x] '
        
        // Extract task ID and title
        const idMatch = taskLine.match(/\[#(\d+)\]/);
        const linkMatch = taskLine.match(/\[([^\]]+)\]\(([^)]+)\)/);
        
        if (idMatch && idMatch[1] && linkMatch && linkMatch[1] && linkMatch[2]) {
          const id = `#${idMatch[1]}`;
          const title = linkMatch[1];
          const specPath = linkMatch[2];
          
          tasks.push({
            id,
            title,
            status: completed ? "DONE" : "TODO",
            specPath
          });
        }
      }
    }

    return tasks;
  }
}

/**
 * Create a new JsonFileTaskBackend
 * @param config Backend configuration
 * @returns JsonFileTaskBackend instance
 */
export function createJsonFileTaskBackend(config: JsonFileTaskBackendOptions): TaskBackend {
  return new JsonFileTaskBackend(config);
} 
 