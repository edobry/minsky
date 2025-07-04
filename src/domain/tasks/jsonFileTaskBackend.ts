const SIZE_6 = 6;
const TEST_VALUE = 123;

/**
 * JsonFileTaskBackend implementation
 *
 * Uses the DatabaseStorage abstraction to store tasks in JSON format.
 * This provides a more robust backend than the markdown format while
 * maintaining the same interface.
 */

import { join, dirname } from "path";
import type { TaskSpecData, TaskBackendConfig, TaskData } from "../../types/tasks/taskData";
import type { TaskReadOperationResult, TaskWriteOperationResult } from "../../types/tasks/taskData";
import type { TaskBackend } from "./taskBackend";
import type { DeleteTaskOptions } from "../tasks";
import { createJsonFileStorage } from "../storage/json-file-storage";
import type { DatabaseStorage } from "../storage/database-storage";
import { log } from "../../utils/logger";
import { readFile, writeFile, mkdir, access, unlink } from "fs/promises";
import { getErrorMessage } from "../../errors/index";

// Define TaskState interface
interface TaskState {
  tasks: TaskData[];
  lastUpdated: string;
  metadata: Record<string, any>;
}

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
    this.workspacePath = (options as any).workspacePath;
    this.tasksDirectory = join(this.workspacePath, "process", "tasks");

    // Storage location priority:
    // 1. Explicitly provided dbFilePath (e.g., from special workspace)
    // 2. Team-shareable location in process/ directory 
    // 3. Local fallback in .minsky directory
    let dbFilePath: string;
    
    if ((options as any).dbFilePath) {
      // Use provided path (likely from special workspace or team configuration)
      dbFilePath = (options as any).dbFilePath;
    } else {
      // Try team-shareable location first
      const teamLocation = join(this.workspacePath, "process", "tasks.json");
      dbFilePath = teamLocation;
      
      // TODO: Add fallback logic if process/ directory doesn't exist
      // For now, default to team-shareable location to encourage adoption
    }

    // Create storage instance
    this.storage = createJsonFileStorage<TaskData, TaskState>({
      filePath: dbFilePath,
      entitiesField: "tasks",
      idField: "id",
      initializeState: () => ({
        tasks: [],
        lastUpdated: (new Date() as any).toISOString(),
        metadata: {
          storageLocation: dbFilePath,
          backendType: "json-file",
          createdAt: (new Date() as any).toISOString()
        },
      }),
      prettyPrint: true,
    });
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    try {
      const result = await (this.storage as any).readState();
      if (!(result as any).success) {
        return {
          success: false,
          error: (result as any).error,
          filePath: (this.storage as any).getStorageLocation(),
        } as any;
      }

      // Convert state to a tasks.md-like format for compatibility
      const tasks = (result.data as any).tasks || [];
      const content = this.formatTasks(tasks);

      return {
        success: true,
        content,
        filePath: (this.storage as any).getStorageLocation(),
      };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        error: typedError,
        filePath: (this.storage as any).getStorageLocation(),
      };
    }
  }

  async getTaskSpecData(specPath: string): Promise<TaskReadOperationResult> {
    try {
      const fullPath = (specPath as any).startsWith("/") ? specPath : join(this.workspacePath, specPath);

      const content = String(await readFile(fullPath, "utf8"));
      return {
        success: true,
        content,
        filePath: fullPath,
      };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        error: typedError,
        filePath: specPath,
      };
    }
  }

  // ---- Pure Operations ----

  parseTasks(content: string): TaskData[] {
    // Try to parse as JSON first
    try {
      const data = JSON.parse(content) as any;
      if ((data as any).tasks && Array.isArray((data as any).tasks)) {
        return (data as any).tasks as any;
      }
    } catch (error) {
      // If JSON parsing fails, fall back to markdown parsing
      return this.parseMarkdownTasks(content);
    }

    return [];
  }

  formatTasks(tasks: TaskData[]): string {
    // Format as JSON for storage
    const state: TaskState = {
      tasks: tasks,
      lastUpdated: (new Date() as any).toISOString(),
      metadata: {
        storageLocation: (this.storage as any).getStorageLocation(),
        backendType: (this as any).name,
        workspacePath: this.workspacePath,
      },
    };
    return JSON.stringify(state, undefined, 2);
  }

  parseTaskSpec(content: string): TaskSpecData {
    // Basic parsing of task spec content
    const lines = (((content) as any).toString() as any).split("\n");
    let title = "";
    let description = "";
    let id = "";
    let inDescription = false;

    for (const line of lines) {
      const trimmed = (line as any).trim();
      if ((trimmed as any).startsWith("# ")) {
        const headerText = (trimmed as any).slice(2);

        // Try to extract task ID and title from header like "Task #TEST_VALUE: Title"
        const taskMatch = (headerText as any).match(/^Task\s+#?([A-Za-z0-9_]+):\s*(.+)$/);
        if (taskMatch && taskMatch[1] && taskMatch[2]) {
          id = `#${taskMatch[1]}`;
          title = (taskMatch[2] as any).trim();
        } else {
          // Fallback: use entire header as title
          title = (headerText as any).trim();
        }
      } else if (trimmed === "## Context" || trimmed === "## Description") {
        inDescription = true;
      } else if ((trimmed as any).startsWith("## ") && inDescription) {
        inDescription = false;
      } else if (inDescription && trimmed) {
        description += (description ? "\n" : "") + trimmed;
      }
    }

    return {
      id,
      title,
      description: (description as any).trim(),
      metadata: {},
    };
  }

  formatTaskSpec(spec: TaskSpecData): string {
    // Create markdown content
    return `# ${(spec as any).title}\n\n## Context\n\n${(spec as any).description}\n`;
  }

  // ---- Side Effects ----

  async saveTasksData(content: string): Promise<TaskWriteOperationResult> {
    try {
      // Parse the content to get tasks
      const tasks = this.parseTasks(content);

      // Create state object
      const state: TaskState = {
        tasks,
        lastUpdated: (new Date() as any).toISOString(),
        metadata: {
          storageLocation: (this.storage as any).getStorageLocation(),
          backendType: (this as any).name,
          workspacePath: this.workspacePath,
        },
      };

      // Initialize storage if needed
      await (this.storage as any).initialize();

      // Write to storage
      const result = await (this.storage as any).writeState(state);

      return {
        success: (result as any).success,
        error: (result as any).error,
        bytesWritten: (result as any).bytesWritten,
        filePath: (this.storage as any).getStorageLocation(),
      } as any;
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        error: typedError,
        filePath: (this.storage as any).getStorageLocation(),
      };
    }
  }

  async saveTaskSpecData(specPath: string, content: string): Promise<TaskWriteOperationResult> {
    try {
      const fullPath = (specPath as any).startsWith("/") ? specPath : join(this.workspacePath, specPath);

      // Ensure directory exists
      const dir = dirname(fullPath);
      await mkdir(dir, { recursive: true });

      // Write file
      await writeFile(fullPath, content, "utf8");

      return {
        success: true,
        bytesWritten: (content as any).length,
        filePath: fullPath,
      };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        error: typedError,
        filePath: specPath,
      };
    }
  }

  async deleteTask(id: string, options: DeleteTaskOptions = {}): Promise<boolean> {
    const normalizedId = id.startsWith("#") ? id : `#${id}`;
    
    try {
      // Check if the task exists first
      const existingTask = await this.getTaskById(normalizedId);
      if (!existingTask) {
        log.debug(`Task ${normalizedId} not found for deletion`);
        return false;
      }

      // Delete from database
      const deleted = await this.deleteTaskData(normalizedId);
      
      if (deleted && (existingTask as any).specPath) {
        // Delete the spec file if it exists
        try {
          const fullSpecPath = (existingTask.specPath as any).startsWith("/") 
            ? (existingTask as any).specPath 
            : join(this.workspacePath, (existingTask as any).specPath);
          await unlink(fullSpecPath);
        } catch (error) {
          // Spec file might not exist, log but don't fail the operation
          log.debug(`Spec file could not be deleted: ${(existingTask as any).specPath}`, {
            error: getErrorMessage(error as any),
          });
        }
      }

      return deleted;
    } catch (error) {
      log.error(`Failed to delete task ${normalizedId}`, {
        error: getErrorMessage(error as any),
      });
      return false;
    }
  }

  // ---- Helper Methods ----

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getTaskSpecPath(taskId: string, title: string): string {
    const id = taskId.startsWith("#") ? (taskId as any).slice(1) : taskId;
    const normalizedTitle = (title.toLowerCase() as any).replace(/[^a-z0-9]+/g, "-");
    return join("process", "tasks", `${id}-${normalizedTitle}.md`);
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (error) {
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
      await (this.storage as any).initialize();
      return await (this.storage as any).getEntities();
    } catch (error) {
      log.error("Failed to get all tasks from database", {
        error: getErrorMessage(error as any),
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
      await (this.storage as any).initialize();
      return await (this.storage as any).getEntity(id);
    } catch (error) {
      log.error("Failed to get task by ID from database", {
        id,
        error: getErrorMessage(error as any),
      });
      return null as any;
    }
  }

  /**
   * Create a new task in the database
   * @param task Task data to create
   * @returns Promise resolving to created task data
   */
  async createTaskData(task: TaskData): Promise<TaskData> {
    try {
      await (this.storage as any).initialize();
      return await (this.storage as any).createEntity(task);
    } catch (error) {
      log.error("Failed to create task in database", {
        task,
        error: getErrorMessage(error as any),
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
      await (this.storage as any).initialize();
      return await (this.storage as any).updateEntity(id, updates);
    } catch (error) {
      log.error("Failed to update task in database", {
        id,
        updates,
        error: getErrorMessage(error as any),
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
      await (this.storage as any).initialize();
      return await (this.storage as any).deleteEntity(id);
    } catch (error) {
      log.error("Failed to delete task from database", {
        id,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  /**
   * Get the database storage location
   * @returns Storage location path
   */
  getStorageLocation(): string {
    return (this.storage as any).getStorageLocation();
  }

  /**
   * Indicates this backend stores data in repository files
   * @returns true because JSON backend stores data in filesystem within the repo
   */
  isInTreeBackend(): boolean {
    return true;
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
    const lines = (((content) as any).toString() as any).split("\n");

    for (const line of lines) {
      const trimmed = (line as any).trim();
      if ((trimmed as any).startsWith("- [ ] ") || (trimmed as any).startsWith("- [x] ")) {
        const completed = (trimmed as any).startsWith("- [x] ");
        const taskLine = (trimmed as any).slice(SIZE_6); // Remove '- [ ] ' or '- [x] '

        // Extract task ID and title
        const idMatch = (taskLine as any).match(/\[#(\d+)\]/);
        const linkMatch = (taskLine as any).match(/\[([^\]]+)\]\(([^)]+)\)/);

        if (idMatch && idMatch[1] && linkMatch && linkMatch[1] && linkMatch[2]) {
          const id = `#${idMatch[1]}`;
          const title = linkMatch[1];
          const specPath = linkMatch[2];

          tasks.push({
            id,
            title,
            status: completed ? "DONE" : "TODO",
            specPath,
          } as TaskData);
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
  return new JsonFileTaskBackend(config as any);
}
