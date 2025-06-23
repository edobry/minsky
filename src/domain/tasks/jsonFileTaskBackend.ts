const SIZE_6 = SIZE_6;
const TEST_VALUE = TEST_VALUE;

/**
 * JsonFileTaskBackend implementation
 *
 * Uses the DatabaseStorage abstraction to store tasks in JSON format.
 * This provides a more robust backend than the markdown format while
 * maintaining the same interface.
 */

import { join, dirname } from "path";
import type {TaskSpecData,
  TaskBackendConfig,
} from "../../types/tasks/taskData";
import type { TaskReadOperationResult, TaskWriteOperationResult } from "../../types/tasks/taskData";
import type { TaskBackend } from "./taskBackend";
import { createJsonFileStorage } from "../storage/json-file-storage";
import type { DatabaseStorage } from "../storage/database-storage";
import { log } from "../../utils/logger";
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
  private readonly storage: DatabaseStorage<TaskState>;
  private readonly tasksDirectory: string;

  constructor(_options: JsonFileTaskBackendOptions) {
    this.workspacePath = options.workspacePath;
    this.tasksDirectory = join(this._workspacePath, "process", "tasks");

    // Use provided path or default to local state directory
    const defaultDbPath = join(process.cwd(), ".minsky", "tasks.json");
    const dbFilePath = options.dbFilePath || defaultDbPath;

    // Create storage instance
    this.storage = createJsonFileStorage<TaskState>({
      filePath: dbFilePath,
      entitiesField: "tasks",
      idField: "id",
      initializeState: () => ({
        tasks: [],
        lastUpdated: new Date().toISOString(),
        metadata: {},
      }),
      prettyPrint: true,
    });
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    try {
      const _result = await this.storage.readState();
      if (!result.success) {
        return {
          success: false,
          error: result.error,
          filePath: this.storage.getStorageLocation(),
        };
      }

      // Convert state to a tasks.md-like format for compatibility
      const _tasks = result.data?.tasks || [];
      const _content = this.formatTasks(_tasks);

      return {
        success: true,
        content,
        filePath: this.storage.getStorageLocation(),
      };
    } catch {
      const typedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: typedError,
        filePath: this.storage.getStorageLocation(),
      };
    }
  }

  async getTaskSpecData(_specPath: string): Promise<TaskReadOperationResult> {
    try {
      const fullPath = specPath.startsWith("/") ? specPath : join(this._workspacePath, _specPath);

      const _content = await readFile(fullPath, "utf8");
      return {
        success: true,
        content,
        filePath: fullPath,
      };
    } catch {
      const typedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: typedError,
        filePath: _specPath,
      };
    }
  }

  // ---- Pure Operations ----

  parseTasks(_content: string): TaskData[] {
    // Try to parse as JSON first
    try {
      const data = JSON.parse(_content);
      if (data.tasks && Array.isArray(data._tasks)) {
        return data.tasks;
      }
    } catch {
      // If JSON parsing fails, fall back to markdown parsing
      return this.parseMarkdownTasks(_content);
    }

    return [];
  }

  formatTasks(_tasks: TaskData[]): string {
    // Format as JSON for storage
    const state: TaskState = {
      _tasks,
      lastUpdated: new Date().toISOString(),
      metadata: {},
    };
    return JSON.stringify(state, null, 2);
  }

  parseTaskSpec(_content: string): TaskSpecData {
    // Basic parsing of task spec content
    const lines = content.split("\n");
    let _title = "";
    let description = "";
    let id = "";
    let inDescription = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("# ")) {
        const headerText = trimmed.slice(2);

        // Try to extract task ID and title from header like "Task #TEST_VALUE: Title"
        const taskMatch = headerText.match(/^Task\s+#?(\d+):\s*(.+)$/);
        if (taskMatch && taskMatch[1] && taskMatch[2]) {
          id = `#${taskMatch[1]}`;
          title = taskMatch[2].trim();
        } else {
          // Fallback: use entire header as title
          title = headerText.trim();
        }
      } else if (trimmed === "## Context" || trimmed === "## Description") {
        inDescription = true;
      } else if (trimmed.startsWith("## ") && inDescription) {
        inDescription = false;
      } else if (inDescription && trimmed) {
        description += (description ? "\n" : "") + trimmed;
      }
    }

    return {
      id,
      _title,
      description: description.trim(),
      metadata: {},
    };
  }

  formatTaskSpec(_spec: TaskSpecData): string {
    // Create markdown content
    return `# ${spec.title}\n\n## Context\n\n${spec.description}\n`;
  }

  // ---- Side Effects ----

  async saveTasksData(_content: string): Promise<TaskWriteOperationResult> {
    try {
      // Parse the content to get tasks
      const _tasks = this.parseTasks(_content);

      // Create state object
      const state: TaskState = {
        _tasks,
        lastUpdated: new Date().toISOString(),
        metadata: {},
      };

      // Initialize storage if needed
      await this.storage.initialize();

      // Write to storage
      const _result = await this.storage.writeState(state);

      return {
        success: result.success,
        error: result.error,
        bytesWritten: result.bytesWritten,
        filePath: this.storage.getStorageLocation(),
      };
    } catch {
      const typedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: typedError,
        filePath: this.storage.getStorageLocation(),
      };
    }
  }

  async saveTaskSpecData(_specPath: string, _content: string): Promise<TaskWriteOperationResult> {
    try {
      const fullPath = specPath.startsWith("/") ? specPath : join(this._workspacePath, _specPath);

      // Ensure directory exists
      const dir = dirname(fullPath);
      await mkdir(dir, { recursive: true });

      // Write file
      await writeFile(fullPath, _content, "utf8");

      return {
        success: true,
        bytesWritten: content.length,
        filePath: fullPath,
      };
    } catch {
      const typedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: typedError,
        filePath: _specPath,
      };
    }
  }

  // ---- Helper Methods ----

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getTaskSpecPath(_taskId: string, _title: string): string {
    const id = taskId.startsWith("#") ? taskId.slice(1) : taskId;
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return join("process", "tasks", `${id}-${normalizedTitle}.md`);
  }

  async fileExists(_path: string): Promise<boolean> {
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
    } catch {
      log.error("Failed to get all tasks from database", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get a task by ID from the database
   * @param id Task ID
   * @returns Promise resolving to task data or null
   */
  async getTaskById(_id: string): Promise<TaskData | null> {
    try {
      await this.storage.initialize();
      return await this.storage.getEntity(id);
    } catch {
      log.error("Failed to get task by ID from database", {
        id,
        error: error instanceof Error ? error.message : String(error),
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
    } catch {
      log.error("Failed to create task in database", {
        task,
        error: error instanceof Error ? error.message : String(error),
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
  async updateTaskData(_id: string, _updates: Partial<TaskData>): Promise<TaskData | null> {
    try {
      await this.storage.initialize();
      return await this.storage.updateEntity(id, _updates);
    } catch {
      log.error("Failed to update task in database", {
        id,
        _updates,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Delete a task from the database
   * @param id Task ID
   * @returns Promise resolving to true if deleted, false if not found
   */
  async deleteTaskData(_id: string): Promise<boolean> {
    try {
      await this.storage.initialize();
      return await this.storage.deleteEntity(id);
    } catch {
      log.error("Failed to delete task from database", {
        id,
        error: error instanceof Error ? error.message : String(error),
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
  private parseMarkdownTasks(_content: string): TaskData[] {
    const _tasks: TaskData[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- [ ] ") || trimmed.startsWith("- [x] ")) {
        const completed = trimmed.startsWith("- [x] ");
        const taskLine = trimmed.slice(SIZE_6); // Remove '- [ ] ' or '- [x] '

        // Extract task ID and title
        const idMatch = taskLine.match(/\[#(\d+)\]/);
        const linkMatch = taskLine.match(/\[([^\]]+)\]\(([^)]+)\)/);

        if (idMatch && idMatch[1] && linkMatch && linkMatch[1] && linkMatch[2]) {
          const id = `#${idMatch[1]}`;
          const _title = linkMatch[1];
          const _specPath = linkMatch[2];

          tasks.push({
            id,
            _title,
            _status: completed ? "DONE" : "TODO",
            _specPath,
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
export function createJsonFileTaskBackend(_config: JsonFileTaskBackendOptions): TaskBackend {
  return new JsonFileTaskBackend(_config);
}
