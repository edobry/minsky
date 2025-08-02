const SIZE_6 = 6;
const _TEST_VALUE = 123;

/**
 * JsonFileTaskBackend implementation
 *
 * Uses the DatabaseStorage abstraction to store tasks in JSON format.
 * This provides a more robust backend than the markdown format while
 * maintaining the same interface.
 */

import { join, dirname } from "path";
import { existsSync } from "fs";
import type { TaskSpecData, TaskBackendConfig, TaskData } from "../../types/tasks/taskData";
import type { TaskReadOperationResult, TaskWriteOperationResult } from "../../types/tasks/taskData";
import type {
  TaskBackend,
  Task,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
} from "../tasks";
import type { BackendCapabilities } from "./types";
import { createJsonFileStorage } from "../storage/json-file-storage";
import type { DatabaseStorage } from "../storage/database-storage";
import { validateTaskState, type TaskState } from "../../schemas/storage";
import type { TaskSpec } from "./taskIO";
import { log } from "../../utils/logger";
import { readFile, writeFile, mkdir, access, unlink } from "fs/promises";
import { getErrorMessage } from "../../errors/index";
import { TASK_STATUS, TaskStatus } from "./taskConstants";
import { getTaskSpecRelativePath } from "./taskIO";
import { normalizeTaskIdForStorage } from "./task-id-utils";
import { getNextTaskId } from "./taskFunctions";

// TaskState is now imported from schemas/storage

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

    // Storage location priority:
    // 1. Explicitly provided dbFilePath
    // 2. Team-shareable location in process/ directory
    // 3. Local fallback in .minsky directory
    let dbFilePath: string;

    if (options.dbFilePath) {
      // Use provided path from configuration
      dbFilePath = options.dbFilePath;
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
        lastUpdated: new Date().toISOString(),
        metadata: {
          storageLocation: dbFilePath,
          backendType: "json-file",
          createdAt: new Date().toISOString(),
        },
      }),
      prettyPrint: true,
    });
  }

  // ---- Capability Discovery ----

  getCapabilities(): BackendCapabilities {
    return {
      // Core operations - JSON backend supports full CRUD with structured data
      supportsTaskCreation: true,
      supportsTaskUpdate: true,
      supportsTaskDeletion: true,

      // Essential metadata support - excellent with JSON format
      supportsStatus: true, // Stored in structured JSON format

      // Structural metadata - JSON format makes this natural
      supportsSubtasks: true, // Can store arrays of task IDs
      supportsDependencies: true, // Can store complex dependency relationships

      // Provenance metadata - JSON format ideal for structured metadata
      supportsOriginalRequirements: true, // Can store as JSON field
      supportsAiEnhancementTracking: true, // Can track enhancement history

      // Query capabilities - JSON enables powerful querying
      supportsMetadataQuery: true, // Can query JSON structure efficiently
      supportsFullTextSearch: true, // Can search through JSON content

      // Update mechanism - direct database operations
      supportsTransactions: true, // JSON file operations can be atomic
      supportsRealTimeSync: false, // File-based, but more efficient than markdown
    };
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    try {
      const result = await this.storage.readState();
      if (!result.success) {
        return {
          success: false,
          error: result.error,
          filePath: this.storage.getStorageLocation(),
        };
      }

      // Convert state to a tasks.md-like format for compatibility
      const tasks = result.data.tasks || [];
      const content = this.formatTasks(tasks);

      return {
        success: true,
        content,
        filePath: this.storage.getStorageLocation(),
      };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        error: typedError,
        filePath: this.storage.getStorageLocation(),
      };
    }
  }

  async getTaskSpecData(specPath: string): Promise<TaskReadOperationResult> {
    try {
      const fullPath = specPath.startsWith("/") ? specPath : join(this.workspacePath, specPath);

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
      const rawData = JSON.parse(content);
      const validatedData = validateTaskState(rawData);
      return validatedData.tasks;
    } catch (error) {
      // If JSON parsing or validation fails, fall back to markdown parsing
      return this.parseMarkdownTasks(content);
    }
  }

  formatTasks(tasks: TaskData[]): string {
    // Format as JSON for storage
    const state: TaskState = {
      tasks: tasks,
      lastUpdated: new Date().toISOString(),
      metadata: {
        storageLocation: this.storage.getStorageLocation(),
        backendType: this.name,
        workspacePath: this.workspacePath,
      },
    };
    return JSON.stringify(state, undefined, 2);
  }

  parseTaskSpec(content: string): TaskSpecData {
    // Basic parsing of task spec content
    const lines = content.toString().split("\n");
    let title = "";
    let description = "";
    let id = "";
    let inDescription = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("# ")) {
        const headerText = trimmed.slice(2);

        // Try to extract task ID and title from header like "Task #TEST_VALUE: Title"
        const taskMatch = headerText.match(/^Task\s+#?([A-Za-z0-9_]+):\s*(.+)$/);
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
      title,
      description: description.trim(),
      metadata: {},
    };
  }

  formatTaskSpec(spec: TaskSpecData): string {
    // Create markdown content
    return `# ${spec.title}\n\n## Context\n\n${spec.description}\n`;
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
    // Try exact ID first
    let task = await this.getTaskById(id);
    if (task) return task;

    // If not found and ID is qualified (md#123), try plain format (123)
    if (id.includes("#")) {
      const plainId = id.split("#")[1];
      task = await this.getTaskById(plainId);
      if (task) return task;
    }

    // If not found and ID is plain (123), try qualified format (md#123)
    if (!id.includes("#") && /^\d+$/.test(id)) {
      const qualifiedId = `md#${id}`;
      task = await this.getTaskById(qualifiedId);
      if (task) return task;
    }

    return null;
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTaskById(id);
    return task?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    await this.updateTaskData(id, { status: status as TaskStatus });
  }

  async createTask(specPath: string, options: CreateTaskOptions = {}): Promise<Task> {
    // Delegate to the existing createTaskFromSpecFile method
    return this.createTaskFromSpecFile(specPath, options);
  }

  /**
   * Create a task from title and description
   * @param title Title of the task
   * @param description Description of the task
   * @param options Options for creating the task
   * @returns Promise resolving to the created task
   */
  async createTaskFromTitleAndDescription(
    title: string,
    description: string,
    options: CreateTaskOptions = {}
  ): Promise<Task> {
    // Generate a task specification file content
    const taskSpecContent = this.generateTaskSpecification(title, description);

    // Create a temporary file path for the spec
    const fs = await import("fs/promises");
    const path = await import("path");
    const os = await import("os");

    const tempDir = os.tmpdir();
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const tempSpecPath = path.join(tempDir, `temp-task-${normalizedTitle}-${Date.now()}.md`);

    try {
      // Write the spec content to the temporary file
      await fs.writeFile(tempSpecPath, taskSpecContent, "utf-8");

      // Use the existing createTask method
      const task = await this.createTask(tempSpecPath, options);

      // Clean up the temporary file
      try {
        await fs.unlink(tempSpecPath);
      } catch (error) {
        // Ignore cleanup errors
      }

      return task;
    } catch (error) {
      // Clean up the temporary file on error
      try {
        await fs.unlink(tempSpecPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Generate a task specification file content from title and description
   * @param title Title of the task
   * @param description Description of the task
   * @returns The generated task specification content
   */
  private generateTaskSpecification(title: string, description: string): string {
    return `# ${title}

## Status

BACKLOG

## Priority

MEDIUM

## Description

${description}

## Requirements

[To be filled in]

## Success Criteria

[To be defined]
`;
  }

  /**
   * Creates a new task from a markdown specification file
   * Spec parser is provided as parameter to allow for dependency injection
   */
  async createTaskFromSpecFile(
    specPath: string,
    specParser: (content: string) => TaskSpec
  ): Promise<TaskData> {
    // Validate the input
    if (!specPath || !specParser) {
      throw new Error("Spec path and parser are required");
    }

    const specDataResult = await this.getTaskSpecData(specPath);
    if (!specDataResult.success) {
      throw new Error(`Failed to load spec file: ${specDataResult.error}`);
    }
    const spec = this.parseTaskSpec(specDataResult.content || "");

    // Use the spec ID if available, otherwise generate a sequential ID
    let taskId: string;
    if (spec.id && spec.id.trim()) {
      // TASK 283: Normalize spec ID to plain storage format
      taskId = normalizeTaskIdForStorage(spec.id) || spec.id;
    } else {
      // Get all existing tasks to determine the new task's ID
      const tasks = await this.getAllTasks();

      // TASK 283: Generate plain ID format for storage using proper max ID logic
      taskId = getNextTaskId(tasks); // Uses max existing ID + 1, returns plain format
    }

    // Create the new task data
    const newTask: TaskData = {
      id: taskId, // Store in plain format
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
        lastUpdated: new Date().toISOString(),
        metadata: {
          storageLocation: this.storage.getStorageLocation(),
          backendType: this.name,
          workspacePath: this.workspacePath,
        },
      };

      // Initialize storage if needed
      await this.storage.initialize();

      // Write to storage
      const result = await this.storage.writeState(state);

      return {
        success: result.success,
        error: result.error,
        bytesWritten: result.bytesWritten,
        filePath: this.storage.getStorageLocation(),
      };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        error: typedError,
        filePath: this.storage.getStorageLocation(),
      };
    }
  }

  async saveTaskSpecData(specPath: string, content: string): Promise<TaskWriteOperationResult> {
    try {
      const fullPath = specPath.startsWith("/") ? specPath : join(this.workspacePath, specPath);

      // Ensure directory exists
      const dir = dirname(fullPath);
      await mkdir(dir, { recursive: true });

      // Write file
      await writeFile(fullPath, content, "utf8");

      return {
        success: true,
        bytesWritten: content.length,
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

  async deleteTask(id: string, _options: DeleteTaskOptions = {}): Promise<boolean> {
    // Use the ID directly without normalization to match storage format
    try {
      // Check if the task exists first
      const existingTask = await this.getTaskById(id);
      if (!existingTask) {
        log.debug(`Task ${id} not found for deletion`);
        return false;
      }

      // Delete from database
      const deleted = await this.deleteTaskData(id);

      if (deleted && existingTask.specPath) {
        // Try to delete spec file if it exists
        try {
          const fullPath = join(this.workspacePath, existingTask.specPath);
          if (await this.fileExists(fullPath)) {
            await unlink(fullPath);
            log.debug(`Deleted spec file: ${fullPath}`);
          }
        } catch (error) {
          // Log but don't fail the operation if spec file deletion fails
          log.debug(`Could not delete spec file for task ${id}: ${getErrorMessage(error as any)}`);
        }
      }

      return deleted;
    } catch (error) {
      log.error(`Failed to delete task ${id}`, {
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
      await this.storage.initialize();
      return await this.storage.getEntities();
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
      await this.storage.initialize();
      return await this.storage.getEntity(id);
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
      await this.storage.initialize();
      return await this.storage.createEntity(task);
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
      await this.storage.initialize();
      return await this.storage.updateEntity(id, updates);
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
      await this.storage.initialize();
      return await this.storage.deleteEntity(id);
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
    return this.storage.getStorageLocation();
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
    const lines = content.toString().split("\n");

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
  return new JsonFileTaskBackend(config);
}

/**
 * Configure workspace and database file path for JSON backend
 */
function configureJsonBackendWorkspace(config: any): JsonFileTaskBackendOptions {
  // 1. Use explicitly provided workspace path
  if (config.workspacePath) {
    const dbFilePath = config.dbFilePath || join(config.workspacePath, "process", "tasks.json");
    return {
      ...config,
      workspacePath: config.workspacePath,
      dbFilePath,
    };
  }

  // 2. Use current working directory as default
  const currentDir = (process as any).cwd();
  const dbFilePath = config.dbFilePath || join(currentDir, "process", "tasks.json");

  return {
    ...config,
    workspacePath: currentDir,
    dbFilePath,
  };
}

/**
 * Create a JSON backend with workspace and storage configuration
 */
export function createJsonBackendWithConfig(config: any): TaskBackend {
  const backendConfig = configureJsonBackendWorkspace(config);

  log.debug("JSON backend configured", {
    workspacePath: backendConfig.workspacePath,
    dbFilePath: backendConfig.dbFilePath,
  });

  return new JsonFileTaskBackend(backendConfig);
}
