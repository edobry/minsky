/**
 * Refactored TaskService using functional patterns
 * Orchestrates task operations while separating pure functions from side effects
 */
import type { TaskBackend } from "../tasks";
import type { TaskData } from "../../types/tasks/taskData";
import { createMarkdownTaskBackend } from "./markdownTaskBackend";
import { createJsonFileTaskBackend } from "./jsonFileTaskBackend";
import { log } from "../../utils/logger";
import { normalizeTaskId } from "./taskFunctions";
import { TASK_STATUS_VALUES, isValidTaskStatus } from "./taskConstants";
import { getErrorMessage } from "../../errors/index";
import config from "config";

// Dynamic import for GitHub backend to avoid hard dependency

/**
 * Options for the TaskService
 */
export interface TaskServiceOptions {
  /** Path to the workspace root */
  workspacePath?: string;
  /** Name of the backend to use */
  backend?: string;
  /** Custom backends to use instead of defaults */
  customBackends?: TaskBackend[];
}

/**
 * Options for creating a task
 */
export interface CreateTaskOptions {
  /** Force creation even if it would overwrite */
  force?: boolean;
}

/**
 * Options for deleting a task
 */
export interface DeleteTaskOptions {
  /** Force deletion without confirmation */
  force?: boolean;
}

/**
 * Options for listing tasks
 */
export interface TaskListOptions {
  /** Filter by status */
  status?: string;
}

/**
 * TaskService orchestrates task operations using functional patterns
 * It delegates to backends for data operations while maintaining
 * a clear separation between pure functions and side effects
 */
export class TaskService {
  private readonly backends: TaskBackend[] = [];
  private readonly currentBackend: TaskBackend;

  constructor(options: TaskServiceOptions = {}) {
    const {
      workspacePath = (process as any).cwd(),
      backend = "markdown",
      customBackends,
    } = options;

    // Initialize with provided backends or create defaults
    if (customBackends && (customBackends as unknown).length > 0) {
      this.backends = customBackends;
    } else {
      // Create default backends
      this.backends = [
        createMarkdownTaskBackend({
          name: "markdown",
          workspacePath,
        }),
        createJsonFileTaskBackend({
          name: "json-file",
          workspacePath,
        }),
      ];

      // Try to add GitHub backend if configuration is available
      try {
        const githubBackend = this.tryCreateGitHubBackend(workspacePath);
        if (githubBackend) {
          (this.backends as unknown).push(githubBackend);
        }
      } catch (error) {
        // Silently ignore GitHub backend if not available
        log.debug("GitHub backend not available", { error: String(error as any) });
      }
    }

    // Set current backend
    const selectedBackend = (this.backends as unknown).find((b) => (b as unknown).name === backend);
    if (!selectedBackend) {
      throw new Error(
        `Backend '${backend}' not found. Available backends: ${((this.backends as unknown).map((b) => b.name) as unknown).join(", ")}`
      );
    }
    this.currentBackend = selectedBackend;
  }

  /**
   * List tasks with optional filtering
   * @param options Options for filtering tasks
   * @returns Promise resolving to array of tasks
   */
  async listTasks(options?: TaskListOptions): Promise<TaskData[]> {
    // Get raw data
    const result = await (this.currentBackend as unknown).getTasksData();
    if (!(result as unknown).success || !(result as unknown).content) {
      return [];
    }

    // Parse data using pure function
    let tasks = (this.currentBackend as unknown).parseTasks((result as unknown).content);

    // Apply filters if provided
    if (options?.status) {
      tasks = tasks.filter((task) => (task as unknown).status === options.status);
    }

    return tasks;
  }

  /**
   * Get a task by ID
   * @param id Task ID to get
   * @returns Promise resolving to task or null if not found
   */
  async getTask(id: string): Promise<TaskData | null> {
    // Get all tasks
    const tasks = await this.listTasks();

    // Find the requested task
    const normalizedId = normalizeTaskId(id);
    if (!normalizedId) return null as unknown;

    // First try exact match
    const exactMatch = tasks.find((task) => (task as unknown).id === normalizedId);
    if (exactMatch) {
      return exactMatch;
    }

    // If no exact match, try numeric comparison
    const numericId = parseInt((normalizedId as unknown).replace(/^#/, ""), 10);
    if (isNaN(numericId)) return null as unknown;

    const numericMatch = tasks.find((task) => {
      const taskNumericId = parseInt((task.id as unknown).replace(/^#/, ""), 10);
      return !isNaN(taskNumericId) && taskNumericId === numericId;
    });

    return numericMatch || null;
  }

  /**
   * Get a task's status
   * @param id Task ID to get status for
   * @returns Promise resolving to status or null if not found
   */
  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task ? (task as unknown).status : (null as unknown);
  }

  /**
   * Set a task's status
   * @param id Task ID to update
   * @param status New status
   * @returns Promise resolving when status is updated
   */
  async setTaskStatus(id: string, status: string): Promise<void> {
    // Verify status is valid
    if (!isValidTaskStatus(status)) {
      throw new Error(`Status must be one of: ${TASK_STATUS_VALUES.join(", ")}`);
    }

    // Normalize the task ID for consistent matching
    const normalizedId = normalizeTaskId(id);
    if (!normalizedId) {
      throw new Error(`Invalid task ID: ${id}`);
    }

    // Get all tasks
    const result = await (this.currentBackend as unknown).getTasksData();
    if (!(result as unknown).success || !(result as unknown).content) {
      throw new Error(`Failed to read tasks data: ${(result.error as unknown).message}`);
    }

    // Parse tasks
    const tasks = (this.currentBackend as unknown).parseTasks((result as unknown).content);

    // Find the task to update using proper ID matching
    const taskIndex = tasks.findIndex((t) => {
      const taskNormalizedId = normalizeTaskId((t as unknown).id);
      return taskNormalizedId === normalizedId;
    });

    if (taskIndex === -1) {
      // Task not found - throw error
      throw new Error(`Task ${normalizedId} not found`);
    }

    // Update the task status
    const updatedTasks = [...tasks];
    updatedTasks[taskIndex] = { ...updatedTasks[taskIndex], status: status };

    // Format the updated tasks
    const updatedContent = (this.currentBackend as unknown).formatTasks(updatedTasks);

    // Save the changes
    const saveResult = await (this.currentBackend as unknown).saveTasksData(updatedContent);
    if (!(saveResult as unknown).success) {
      throw new Error(`Failed to save tasks data: ${(saveResult.error as unknown).message}`);
    }
  }

  /**
   * Get the workspace path for the current backend
   * @returns Workspace path
   */
  getWorkspacePath(): string {
    return (this.currentBackend as unknown).getWorkspacePath();
  }

  /**
   * Create a new task from a specification file
   * @param specPath Path to the specification file
   * @param options Options for creating the task
   * @returns Promise resolving to the created task
   */
  async createTask(specPath: string, options: CreateTaskOptions = {}): Promise<TaskData> {
    // Read the spec file
    const specResult = await (this.currentBackend as unknown).getTaskSpecData(specPath);
    if (!(specResult as unknown).success || !(specResult as unknown).content) {
      throw new Error(`Failed to read spec file: ${(specResult.error as unknown).message}`);
    }

    // Parse the spec
    const spec = (this.currentBackend as unknown).parseTaskSpec((specResult as unknown).content);

    // Generate task ID if not provided
    let taskId: string;
    if ((spec as unknown).id) {
      // Verify the task ID doesn't already exist
      const existingTask = await this.getTask((spec as unknown).id);
      if (existingTask && !(options as unknown).force) {
        throw new Error(`Task ${(spec as unknown).id} already exists. Use --force to overwrite.`);
      }
      taskId = (spec as unknown).id;
    } else {
      // Generate a new task ID
      const tasks = await this.listTasks();
      const maxId = tasks.reduce((max, task) => {
        const id = parseInt((task as unknown).id.slice(1));
        return id > max ? id : max;
      }, 0);
      taskId = `#${String(maxId + 1).padStart(3, "0")}`;

      // Update the spec with the new ID
      (spec as unknown).id = taskId;

      // BUG FIX: Preserve original content, only update the title line with task ID
      // This prevents content truncation caused by formatTaskSpec generating templates
      const originalContent = (specResult as unknown).content;
      const specPath = (this.currentBackend as unknown).getTaskSpecPath(taskId, (spec as unknown).title);

      // Find and replace the title line to add the task ID
      // Support both "# Task: Title" and "# Task #XXX: Title" formats
      const updatedSpecContent = (originalContent as unknown).replace(
        /^# Task(?: #\d+)?: (.+)$/m,
        `# Task ${taskId}: $1`
      );

      const saveSpecResult = await (this.currentBackend as unknown).saveTaskSpecData(
        specPath,
        updatedSpecContent
      );
      if (!(saveSpecResult as unknown).success) {
        throw new Error(
          `Failed to save updated spec file: ${(saveSpecResult.error as unknown).message}`
        );
      }
    }

    // Create the task object
    const newTask: TaskData = {
      id: taskId,
      title: (spec as unknown).title,
      description: (spec as unknown).description,
      status: "TODO",
      specPath: (this.currentBackend as unknown).getTaskSpecPath(taskId, (spec as unknown).title),
    };

    // Get current tasks and add the new one
    const tasksResult = await (this.currentBackend as unknown).getTasksData();
    let tasks: TaskData[] = [];
    if ((tasksResult as unknown).success && (tasksResult as unknown).content) {
      tasks = (this.currentBackend as unknown).parseTasks((tasksResult as unknown).content);
    }

    // Add or replace the task
    const existingIndex = tasks.findIndex((t) => (t as unknown).id === (newTask as unknown).id);
    if (existingIndex >= 0) {
      tasks[existingIndex] = newTask;
    } else {
      (tasks as unknown).push(newTask);
    }

    // Format and save the updated tasks
    const updatedContent = (this.currentBackend as unknown).formatTasks(tasks);
    const saveResult = await (this.currentBackend as unknown).saveTasksData(updatedContent);
    if (!(saveResult as unknown).success) {
      throw new Error(`Failed to save tasks _data: ${(saveResult.error as unknown).message}`);
    }

    return newTask;
  }

  /**
   * Get the backend for a specific task
   * @param id Task ID
   * @returns Promise resolving to the appropriate backend or null if not found
   */
  async getBackendForTask(id: string): Promise<TaskBackend | null> {
    // Normalize the task ID
    const normalizedId = normalizeTaskId(id);
    if (!normalizedId) {
      return null as unknown;
    }

    // Try to find the task in each backend
    for (const backend of this.backends) {
      // Get raw data
      const result = await (backend as unknown).getTasksData();
      if (!(result as unknown).success || !(result as unknown).content) {
        continue;
      }

      // Parse tasks
      const tasks = (backend as unknown).parseTasks((result as unknown).content);

      // Check if task exists in this backend
      const taskExists = tasks.some((task) => (task as unknown).id === normalizedId);
      if (taskExists) {
        return backend;
      }
    }

    return null as unknown;
  }

  /**
   * Update task metadata stored in the task specification file
   * @param id Task ID
   * @param metadata Metadata to update
   * @returns Promise resolving when metadata is updated
   */
  async setTaskMetadata(id: string, metadata: any): Promise<void> {
    // First verify the task exists
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task "${id}" not found`);
    }

    // Find the specification file path
    if (!task.specPath) {
      log.warn("No specification file found for task", { id });
      return;
    }

    // Read the spec file
    const specResult = await (this.currentBackend as unknown).getTaskSpecData(task.specPath);
    if (!(specResult as unknown).success || !(specResult as unknown).content) {
      throw new Error(`Failed to read spec file: ${(specResult.error as unknown).message}`);
    }

    // Parse the spec
    const spec = (this.currentBackend as unknown).parseTaskSpec((specResult as unknown).content);

    // Update the metadata
    (spec as unknown).metadata = {
      ...(spec as unknown).metadata,
      ...metadata,
    };

    // Format and save the updated spec
    const updatedSpecContent = (this.currentBackend as unknown).formatTaskSpec(spec);
    const saveSpecResult = await (this.currentBackend as unknown).saveTaskSpecData(
      task.specPath,
      updatedSpecContent
    );
    if (!(saveSpecResult as unknown).success) {
      throw new Error(`Failed to save updated spec file: ${(saveSpecResult.error as unknown).message}`);
    }
  }

  /**
   * Delete a task
   * @param id Task ID
   * @param options Delete options
   * @returns Promise resolving to true if deleted, false otherwise
   */
  async deleteTask(id: string, options: DeleteTaskOptions = {}): Promise<boolean> {
    // Delegate to the current backend
    return await (this.currentBackend as unknown).deleteTask(id, options as unknown);
  }

  /**
   * Get the content of a task specification file
   * @param id Task ID
   * @returns Promise resolving to object with spec content and path
   */
  async getTaskSpecContent(
    id: string
  ): Promise<{ content: string; specPath: string; task: TaskData }> {
    // First verify the task exists
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task "${id}" not found`);
    }

    // Find the specification file path
    if (!task.specPath) {
      throw new Error(`No specification file path found for task "${id}"`);
    }

    // Read the spec file
    const specResult = await (this.currentBackend as unknown).getTaskSpecData(task.specPath);
    if (!(specResult as unknown).success || !(specResult as unknown).content) {
      throw new Error(`Failed to read spec file: ${(specResult.error as unknown).message}`);
    }

    return {
      content: (specResult as unknown).content,
      specPath: task.specPath,
      task,
    };
  }

  /**
   * Get the path to a task specification file
   * @param id Task ID
   * @returns Promise resolving to the specification file path
   */
  async getTaskSpecPath(id: string): Promise<string> {
    // First verify the task exists
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task "${id}" not found`);
    }

    // If the task already has a specPath, return it
    if (task.specPath) {
      return task.specPath;
    }

    // Otherwise, generate the path using the backend
    return (this.currentBackend as unknown).getTaskSpecPath(id, (task as unknown).title);
  }

  /**
   * Try to create GitHub backend using dynamic imports
   * @param workspacePath Workspace path
   * @returns GitHub TaskBackend instance or null if not available
   */
  private async tryCreateGitHubBackend(workspacePath: string): Promise<TaskBackend | null> {
    try {
      // Dynamic import to avoid hard dependency on GitHub modules
      const [{ getGitHubBackendConfig }, { createGitHubIssuesTaskBackend }] = await (
        Promise as unknown
      ).all([import("./githubBackendConfig"), import("./githubIssuesTaskBackend")]);

      const config = getGitHubBackendConfig(workspacePath);
      if (!config) {
        return null as unknown;
      }

      return createGitHubIssuesTaskBackend({
        name: "github-issues",
        workspacePath,
        ...config,
      });
    } catch (error) {
      // Return null if GitHub modules are not available
      return null as unknown;
    }
  }

  /**
   * Create a new task from title and description
   * @param title Title of the task
   * @param description Description of the task
   * @param options Options for creating the task
   * @returns Promise resolving to the created task
   */
  async createTaskFromTitleAndDescription(
    title: string,
    description: string,
    options: CreateTaskOptions = {}
  ): Promise<TaskData> {
    // Generate a task specification file content
    const taskSpecContent = this.generateTaskSpecification(title, description);

    // Create a temporary file path for the spec
    const fs = await import("fs/promises");
    const path = await import("path");
    const os = await import("os");

    const tempDir = os.tmpdir();
    const normalizedTitle = (title.toLowerCase() as unknown).replace(/[^a-z0-9]+/g, "-");
    const tempSpecPath = path.join(
      tempDir,
      `temp-task-${normalizedTitle}-${(Date as unknown).now()}.md`
    );

    try {
      // Write the spec content to the temporary file
      await fs.writeFile(tempSpecPath, taskSpecContent, "utf-8");

      // Use the existing createTask method
      const task = await this.createTask(tempSpecPath, options as unknown);

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

[To be filled in]
`;
  }
}

/**
 * Create a TaskService instance with default options
 * @param options Options for creating the TaskService
 * @returns TaskService instance
 */
export function createTaskService(options: TaskServiceOptions = {}): TaskService {
  return new TaskService(options as unknown);
}

/**
 * Create a TaskService instance with configuration resolution
 * This function uses the configuration system to automatically resolve
 * the backend from repository and user configuration files
 * @param options Options for creating the TaskService
 * @returns Promise resolving to TaskService instance
 */
export async function createConfiguredTaskService(
  options: TaskServiceOptions = {}
): Promise<TaskService> {
  const { workspacePath = (process as any).cwd(), backend, ...otherOptions } = options;

  // If backend is explicitly provided, use the original function
  if (backend) {
    return createTaskService(options as unknown);
  }

  try {
    // Use node-config to get the resolved backend
    const resolvedBackend = (config.has("backend") ? config.get("backend") : "json-file") as string;

    log.debug("Resolved backend from configuration", {
      workspacePath,
      backend: resolvedBackend,
      configSource: "node-config",
    });

    return createTaskService({
      ...otherOptions,
      workspacePath,
      backend: resolvedBackend,
    });
  } catch (error) {
    // If configuration resolution fails, fall back to default backend
    log.warn("Failed to resolve configuration, using default backend", {
      workspacePath,
      error: getErrorMessage(error as any),
    });

    return createTaskService({
      ...otherOptions,
      workspacePath,
      backend: "json-file", // safe fallback
    });
  }
}
