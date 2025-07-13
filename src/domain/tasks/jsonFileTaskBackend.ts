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
import type {
  TaskBackend,
  Task,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
} from "../tasks";
import { createJsonFileStorage } from "../storage/json-file-storage";
import type { DatabaseStorage } from "../storage/database-storage";
import { log } from "../../utils/logger";
import { readFile, writeFile, mkdir, access, unlink } from "fs/promises";
import { getErrorMessage } from "../../errors/index";
import { TASK_STATUS, TaskStatus } from "./taskConstants";
import { getTaskSpecRelativePath } from "./taskIO";

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
    this.workspacePath = (options as unknown).workspacePath;
    this.tasksDirectory = join(this.workspacePath, "process", "tasks");

    // Storage location priority:
    // 1. Explicitly provided dbFilePath (e.g., from special workspace)
    // 2. Team-shareable location in process/ directory
    // 3. Local fallback in .minsky directory
    let dbFilePath: string;

    if ((options as unknown).dbFilePath) {
      // Use provided path (likely from special workspace or team configuration)
      dbFilePath = (options as unknown).dbFilePath;
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
        lastUpdated: (new Date() as unknown).toISOString(),
        metadata: {
          storageLocation: dbFilePath,
          backendType: "json-file",
          createdAt: (new Date() as unknown).toISOString(),
        },
      }),
      prettyPrint: true,
    });
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    try {
      const result = await (this.storage as unknown).readState();
      if (!(result as unknown).success) {
        return {
          success: false,
          error: (result as unknown).error,
          filePath: (this.storage as unknown).getStorageLocation(),
        } as unknown;
      }

      // Convert state to a tasks.md-like format for compatibility
      const tasks = (result.data as unknown).tasks || [];
      const content = this.formatTasks(tasks);

      return {
        success: true,
        content,
        filePath: (this.storage as unknown).getStorageLocation(),
      };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        error: typedError,
        filePath: (this.storage as unknown).getStorageLocation(),
      };
    }
  }

  async getTaskSpecData(specPath: string): Promise<TaskReadOperationResult> {
    try {
      const fullPath = (specPath as unknown).startsWith("/")
        ? specPath
        : join(this.workspacePath, specPath);

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
      const data = JSON.parse(content) as unknown;
      if ((data as unknown).tasks && Array.isArray((data as unknown).tasks)) {
        return (data as unknown).tasks as unknown;
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
      lastUpdated: (new Date() as unknown).toISOString(),
      metadata: {
        storageLocation: (this.storage as unknown).getStorageLocation(),
        backendType: (this as unknown).name,
        workspacePath: this.workspacePath,
      },
    };
    return JSON.stringify(state, undefined, 2);
  }

  parseTaskSpec(content: string): TaskSpecData {
    // Basic parsing of task spec content
    const lines = ((content as unknown).toString() as unknown).split("\n");
    let title = "";
    let description = "";
    let id = "";
    let inDescription = false;

    for (const line of lines) {
      const trimmed = (line as unknown).trim();
      if ((trimmed as unknown).startsWith("# ")) {
        const headerText = (trimmed as unknown).slice(2);

        // Try to extract task ID and title from header like "Task #TEST_VALUE: Title"
        const taskMatch = (headerText as unknown).match(/^Task\s+#?([A-Za-z0-9_]+):\s*(.+)$/);
        if (taskMatch && taskMatch[1] && taskMatch[2]) {
          id = `#${taskMatch[1]}`;
          title = (taskMatch[2] as unknown).trim();
        } else {
          // Fallback: use entire header as title
          title = (headerText as unknown).trim();
        }
      } else if (trimmed === "## Context" || trimmed === "## Description") {
        inDescription = true;
      } else if ((trimmed as unknown).startsWith("## ") && inDescription) {
        inDescription = false;
      } else if (inDescription && trimmed) {
        description += (description ? "\n" : "") + trimmed;
      }
    }

    return {
      id,
      title,
      description: (description as unknown).trim(),
      metadata: {},
    };
  }

  formatTaskSpec(spec: TaskSpecData): string {
    // Create markdown content
    return `# ${(spec as unknown).title}\n\n## Context\n\n${(spec as unknown).description}\n`;
  }

  // ---- Public API ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const tasks = await this.getAllTasks();

    if (options?.status) {
      return tasks.filter((task) => task.status === options?.status);
    }

    return tasks;
  }

  async getTask(id: string): Promise<Task | null> {
    return this.getTaskById(id);
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTaskById(id);
    return task?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    await this.updateTaskData(id, { status: status as TaskStatus });
  }

  async createTask(specPath: string, options?: CreateTaskOptions): Promise<Task> {
    // Read and parse the task specification
    const specDataResult = await this.getTaskSpecData(specPath);
    if (!specDataResult.success) {
      throw new Error(
        `Failed to read task spec from ${specPath}: ${specDataResult.error?.message}`
      );
    }
    const spec = this.parseTaskSpec(specDataResult.content || "");

    // Get all existing tasks to determine the new task's ID
    const tasks = await this.getAllTasks();
    const newId = `#${tasks.length + 1}`;

    // Create the new task data
    const newTask: TaskData = {
      id: newId,
      title: spec.title,
      description: spec.description,
      status: TASK_STATUS.TODO,
      specPath: specPath,
    };

    // Add the new task to the database
    const createdTask = await this.createTaskData(newTask);

    return createdTask;
  }

  // ---- Side Effects ----

  async saveTasksData(content: string): Promise<TaskWriteOperationResult> {
    try {
      // Parse the content to get tasks
      const tasks = this.parseTasks(content);

      // Create state object
      const state: TaskState = {
        tasks,
        lastUpdated: (new Date() as unknown).toISOString(),
        metadata: {
          storageLocation: (this.storage as unknown).getStorageLocation(),
          backendType: (this as unknown).name,
          workspacePath: this.workspacePath,
        },
      };

      // Initialize storage if needed
      await (this.storage as unknown).initialize();

      // Write to storage
      const result = await (this.storage as unknown).writeState(state);

      return {
        success: (result as unknown).success,
        error: (result as unknown).error,
        bytesWritten: (result as unknown).bytesWritten,
        filePath: (this.storage as unknown).getStorageLocation(),
      } as unknown;
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        error: typedError,
        filePath: (this.storage as unknown).getStorageLocation(),
      };
    }
  }

  async saveTaskSpecData(specPath: string, content: string): Promise<TaskWriteOperationResult> {
    try {
      const fullPath = (specPath as unknown).startsWith("/")
        ? specPath
        : join(this.workspacePath, specPath);

      // Ensure directory exists
      const dir = dirname(fullPath);
      await mkdir(dir, { recursive: true });

      // Write file
      await writeFile(fullPath, content, "utf8");

      return {
        success: true,
        bytesWritten: (content as unknown).length,
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

      if (deleted && (existingTask as unknown).specPath) {
        // Delete the spec file if it exists
        try {
          const fullSpecPath = (existingTask.specPath as unknown).startsWith("/")
            ? (existingTask as unknown).specPath
            : join(this.workspacePath, (existingTask as unknown).specPath);
          await unlink(fullSpecPath);
        } catch (error) {
          // Spec file might not exist, log but don't fail the operation
          log.debug(`Spec file could not be deleted: ${(existingTask as unknown).specPath}`, {
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
    return getTaskSpecRelativePath(taskId, title, this.workspacePath);
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
      await (this.storage as unknown).initialize();
      return await (this.storage as unknown).getEntities();
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
      await (this.storage as unknown).initialize();
      return await (this.storage as unknown).getEntity(id);
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
      await (this.storage as unknown).initialize();
      return await (this.storage as unknown).createEntity(task);
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
      await (this.storage as unknown).initialize();
      return await (this.storage as unknown).updateEntity(id, updates);
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
      await (this.storage as unknown).initialize();
      return await (this.storage as unknown).deleteEntity(id);
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
    return (this.storage as unknown).getStorageLocation();
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
    const lines = ((content as unknown).toString() as unknown).split("\n");

    for (const line of lines) {
      const trimmed = (line as unknown).trim();
      if ((trimmed as unknown).startsWith("- [ ] ") || (trimmed as unknown).startsWith("- [x] ")) {
        const completed = (trimmed as unknown).startsWith("- [x] ");
        const taskLine = (trimmed as unknown).slice(SIZE_6); // Remove '- [ ] ' or '- [x] '

        // Extract task ID and title
        const idMatch = (taskLine as unknown).match(/\[#(\d+)\]/);
        const linkMatch = (taskLine as unknown).match(/\[([^\]]+)\]\(([^)]+)\)/);

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
  // Simply return the instance since JsonFileTaskBackend already implements TaskBackend
  return new JsonFileTaskBackend(config as unknown);
}
