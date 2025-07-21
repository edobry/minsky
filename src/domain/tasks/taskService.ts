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
import { get } from "../configuration/index";
import { normalizeTaskIdForStorage } from "./task-id-utils";

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
    if (customBackends && customBackends.length > 0) {
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
          this.backends.push(githubBackend);
        }
      } catch (error) {
        // Silently ignore GitHub backend if not available
        log.debug("GitHub backend not available", { error: String(error as any) });
      }
    }

    // Set current backend
    const selectedBackend = this.backends.find((b) => b.name === backend);
    if (!selectedBackend) {
      throw new Error(
        `Backend '${backend}' not found. Available backends: ${this.backends.map((b) => b.name).join(", ")}`
      );
    }
    this.currentBackend = selectedBackend;
  }

  /**
   * Get all tasks
   * @returns Promise resolving to an array of tasks
   */
  async getAllTasks(): Promise<TaskData[]> {
    const result = await this.currentBackend.getTasksData();
    if (!result.success) {
      throw new Error(`Failed to get tasks: ${result.error?.message}`);
    }

    let tasks = this.currentBackend.parseTasks(result.content);

    // Ensure all tasks have required properties
    tasks = tasks.map((task) => ({
      id: task.id,
      title: task.title || "",
      description: task.description || "",
      status: task.status || "TODO",
      specPath: task.specPath || "",
    }));

    return tasks;
  }

  /**
   * Get a specific task by ID
   * @param id Task ID
   * @returns Promise resolving to the task or null if not found
   */
  async getTask(id: string): Promise<TaskData | null> {
    const tasks = await this.getAllTasks();
    const normalizedId = normalizeTaskId(id) || id;
    return tasks.find((task) => {
      const taskNormalizedId = normalizeTaskId(task.id) || task.id;
      return taskNormalizedId === normalizedId || task.id === id;
    }) || null;
  }

  /**
   * Update a task
   * @param id Task ID
   * @param updates Task updates
   * @returns Promise resolving to the updated task
   */
  async updateTask(id: string, updates: Partial<TaskData>): Promise<TaskData> {
    const tasks = await this.getAllTasks();

    // Use proper task ID normalization from systematic architecture
    // This handles the transition period where storage might be in either format
    const storageId = normalizeTaskIdForStorage(id);
    if (!storageId) {
      throw new Error(`Invalid task ID format: ${id}`);
    }

    // Try both storage format and legacy display format during transition
    const taskIndex = tasks.findIndex((task) =>
      task.id === storageId || task.id === `#${storageId}`
    );

    if (taskIndex === -1) {
      throw new Error(`Task with ID ${id} not found`);
    }

    // Apply updates
    const updatedTask = { ...tasks[taskIndex], ...updates };
    tasks[taskIndex] = updatedTask;

    // Save the updated tasks
    const updatedContent = this.currentBackend.formatTasks(tasks);
    const saveResult = await this.currentBackend.saveTasksData(updatedContent);

    if (!saveResult.success) {
      throw new Error(`Failed to save tasks: ${saveResult.error?.message}`);
    }

    return updatedTask;
  }

  /**
   * List tasks with optional filtering
   * @param options List options
   * @returns Promise resolving to an array of tasks
   */
  async listTasks(options?: TaskListOptions): Promise<TaskData[]> {
    const result = await this.currentBackend.getTasksData();
    if (!result.success) {
      return []; // Return empty array on failure as expected by tests
    }

    const tasks = this.currentBackend.parseTasks(result.content);

    if (options?.status) {
      return tasks.filter((task) => task.status === options.status);
    }

    return tasks;
  }

  /**
   * Update task status
   * @param id Task ID
   * @param status New status
   * @returns Promise resolving to the updated task
   */
  async updateTaskStatus(id: string, status: string): Promise<TaskData> {
    // Validate status first
    if (!isValidTaskStatus(status)) {
      throw new Error(`Status must be one of: ${TASK_STATUS_VALUES.join(", ")}`);
    }

    const tasks = await this.getAllTasks();

    // Use proper task ID normalization from systematic architecture
    // This handles the transition period where storage might be in either format
    const storageId = normalizeTaskIdForStorage(id);
    if (!storageId) {
      throw new Error(`Invalid task ID format: ${id}`);
    }

    // Try both storage format and legacy display format during transition
    const taskIndex = tasks.findIndex((task) =>
      task.id === storageId || task.id === `#${storageId}`
    );

    if (taskIndex === -1) {
      throw new Error(`Task with ID ${id} not found`);
    }

    // Update the task status
    tasks[taskIndex].status = status;

    // Save the updated tasks
    const updatedContent = this.currentBackend.formatTasks(tasks);
    const saveResult = await this.currentBackend.saveTasksData(updatedContent);

    if (!saveResult.success) {
      throw new Error(`Failed to save tasks: ${saveResult.error?.message}`);
    }

    return tasks[taskIndex];
  }

  /**
   * Get task status
   * @param id Task ID
   * @returns Promise resolving to the task status or null if not found
   */
  async getTaskStatus(id: string): Promise<string | null> {
    const task = await this.getTask(id);
    return task ? task.status : null;
  }

  /**
   * Set task status (alias for updateTaskStatus for backward compatibility)
   * @param id Task ID
   * @param status New status
   * @returns Promise resolving to void
   */
  async setTaskStatus(id: string, status: string): Promise<void> {
    // Validate status first
    if (!isValidTaskStatus(status)) {
      throw new Error(`Status must be one of: ${TASK_STATUS_VALUES.join(", ")}`);
    }

    await this.updateTaskStatus(id, status);
  }

  /**
   * Get the workspace path
   * @returns Workspace path
   */
  getWorkspacePath(): string {
    return this.currentBackend.getWorkspacePath();
  }

  /**
   * Get task specification data
   * @param specPath Task specification path
   * @returns Promise resolving to task specification data
   */
  async getTaskSpecData(specPath: string): Promise<any> { // Assuming TaskSpecData is a type defined elsewhere or not needed here
    const specResult = await this.currentBackend.getTaskSpecData(specPath);
    if (!specResult.success) {
      throw new Error(`Failed to get task spec: ${specResult.error?.message}`);
    }

    const spec = this.currentBackend.parseTaskSpec(specResult.content);
    return spec;
  }

  /**
   * Create a new task
   * @param specPath Task specification path
   * @param options Create options
   * @returns Promise resolving to the created task
   */
  async createTask(specPath: string, options?: CreateTaskOptions): Promise<TaskData> {
    // Read and parse the task specification
    const specResult = await this.currentBackend.getTaskSpecData(specPath);
    if (!specResult.success) {
      throw new Error(`Failed to read spec file: ${specResult.error?.message}`);
    }

    const spec = this.currentBackend.parseTaskSpec(specResult.content);

    // Get existing tasks
    const tasksResult = await this.currentBackend.getTasksData();
    if (!tasksResult.success) {
      throw new Error(`Failed to get tasks: ${tasksResult.error?.message}`);
    }

    let tasks = this.currentBackend.parseTasks(tasksResult.content);

    // Add the new task with default values
    const newTask: TaskData = {
      id: spec.id || "#001",
      title: spec.title || "",
      description: spec.description || "",
      status: "TODO",
      specPath,
    };

    tasks.push(newTask);

    // Format and save updated tasks
    const formattedContent = this.currentBackend.formatTasks(tasks);
    const saveResult = await this.currentBackend.saveTasksData(formattedContent, tasksResult.filePath);

    if (!saveResult.success) {
      throw new Error(`Failed to save tasks: ${saveResult.error?.message}`);
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
      return null;
    }

    // Try to find the task in each backend
    for (const backend of this.backends) {
      // Get raw data
      const result = await backend.getTasksData();
      if (!result.success || !result.content) {
        continue;
      }

      // Parse tasks
      const tasks = backend.parseTasks(result.content);

      // Check if task exists in this backend
      const taskExists = tasks.some((task) => task.id === normalizedId);
      if (taskExists) {
        return backend;
      }
    }

    return null;
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
    const specResult = await this.currentBackend.getTaskSpecData(task.specPath);
    if (!specResult.success || !specResult.content) {
      throw new Error(`Failed to read spec file: ${specResult.error.message}`);
    }

    // Parse the spec
    const spec = this.currentBackend.parseTaskSpec(specResult.content);

    // Update the metadata
    spec.metadata = {
      ...spec.metadata,
      ...metadata,
    };

    // Format and save the updated spec
    const updatedSpecContent = this.currentBackend.formatTaskSpec(spec);
    const saveSpecResult = await this.currentBackend.saveTaskSpecData(
      task.specPath,
      updatedSpecContent
    );
    if (!saveSpecResult.success) {
      throw new Error(`Failed to save updated spec file: ${saveSpecResult.error.message}`);
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
    return await this.currentBackend.deleteTask(id, options);
  }

  /**
   * Create a task from title and description
   * @param title Task title
   * @param description Task description
   * @param options Create options
   * @returns Promise resolving to the created task
   */
  async createTaskFromTitleAndDescription(
    title: string,
    description: string,
    options: CreateTaskOptions = {}
  ): Promise<TaskData> {
    // Delegate to the current backend
    const task = await this.currentBackend.createTaskFromTitleAndDescription(title, description, options);

    // Convert the backend Task to TaskData format for consistency
    return {
      id: task.id,
      title: task.title,
      description: task.description || "",
      status: task.status || "TODO",
      specPath: task.specPath || "",
    };
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
    const specResult = await this.currentBackend.getTaskSpecData(task.specPath);
    if (!specResult.success || !specResult.content) {
      throw new Error(`Failed to read spec file: ${specResult.error.message}`);
    }

    return {
      content: specResult.content,
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
    return this.currentBackend.getTaskSpecPath(id, task.title);
  }

  /**
   * Try to create GitHub backend using dynamic imports
   * @param workspacePath Workspace path
   * @returns GitHub TaskBackend instance or null if not available
   */
  private async tryCreateGitHubBackend(workspacePath: string): Promise<TaskBackend | null> {
    try {
      // Dynamic import to avoid hard dependency on GitHub modules
      const [{ getGitHubBackendConfig }, { createGitHubIssuesTaskBackend }] = await Promise.all([import("./githubBackendConfig"), import("./githubIssuesTaskBackend")]);

      const config = getGitHubBackendConfig(workspacePath);
      if (!config) {
        return null;
      }

      return createGitHubIssuesTaskBackend({
        name: "github-issues",
        workspacePath,
        ...config,
      });
    } catch (error) {
      // Return null if GitHub modules are not available
      return null;
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

  /**
   * Create TaskService with workspace-resolving backend configuration
   * This eliminates the need for external workspace resolution
   */
  static async createWithWorkspaceResolvingBackend(options: {
    backend: "markdown" | "json-file";
    backendConfig?: any;
    customBackends?: TaskBackend[];
  }): Promise<TaskService> {
    const { backend, backendConfig, customBackends } = options;

    log.debug("Creating TaskService with workspace-resolving backend", {
      backend,
      hasConfig: !!backendConfig,
      hasCustomBackends: !!customBackends
    });

    // If custom backends provided, use traditional pattern
    if (customBackends) {
      return new TaskService({
        customBackends,
        backend
      });
    }

    // Create workspace-resolving backend based on type
    let resolvedBackend: any;

    switch (backend) {
    case "markdown": {
      if (!backendConfig) {
        throw new Error("Backend configuration required for markdown backend");
      }

      const { createWorkspaceResolvingMarkdownBackend } = await import("./workspace-resolving-markdown-backend");
      resolvedBackend = await createWorkspaceResolvingMarkdownBackend(backendConfig);
      break;
    }

    case "json-file": {
      if (!backendConfig) {
        throw new Error("Backend configuration required for json-file backend");
      }

      const { createWorkspaceResolvingJsonBackend } = await import("./workspace-resolving-json-backend");
      resolvedBackend = await createWorkspaceResolvingJsonBackend(backendConfig);
      break;
    }

    default: {
      throw new Error(`Workspace-resolving backend not available for type: ${backend}`);
    }
    }

    // Create TaskService with the resolved backend
    return new TaskService({
      workspacePath: resolvedBackend.getWorkspacePath(),
      backend,
      customBackends: [resolvedBackend]
    });
  }

  /**
   * Convenience method for markdown backends with repo URLs
   */
  static async createMarkdownWithRepo(config: {
    repoUrl: string;
    forceSpecialWorkspace?: boolean;
  }): Promise<TaskService> {
    return TaskService.createWithWorkspaceResolvingBackend({
      backend: "markdown",
      backendConfig: {
        name: "markdown",
        repoUrl: config.repoUrl,
        forceSpecialWorkspace: config.forceSpecialWorkspace
      }
    });
  }

  /**
   * Convenience method for markdown backends with explicit workspace paths
   */
  static async createMarkdownWithWorkspace(config: {
    workspacePath: string;
  }): Promise<TaskService> {
    return TaskService.createWithWorkspaceResolvingBackend({
      backend: "markdown",
      backendConfig: {
        name: "markdown",
        workspacePath: config.workspacePath
      }
    });
  }

  /**
   * Convenience method for current directory workspace detection
   */
  static async createMarkdownWithAutoDetection(): Promise<TaskService> {
    return TaskService.createWithWorkspaceResolvingBackend({
      backend: "markdown",
      backendConfig: {
        name: "markdown"
        // No explicit config - will auto-detect workspace
      }
    });
  }

  /**
   * Convenience method for JSON backends with repo URLs
   */
  static async createJsonWithRepo(config: {
    repoUrl: string;
    dbFilePath?: string;
  }): Promise<TaskService> {
    return TaskService.createWithWorkspaceResolvingBackend({
      backend: "json-file",
      backendConfig: {
        name: "json-file",
        repoUrl: config.repoUrl,
        dbFilePath: config.dbFilePath
      }
    });
  }

  /**
   * Convenience method for JSON backends with explicit workspace paths
   */
  static async createJsonWithWorkspace(config: {
    workspacePath: string;
    dbFilePath?: string;
  }): Promise<TaskService> {
    return TaskService.createWithWorkspaceResolvingBackend({
      backend: "json-file",
      backendConfig: {
        name: "json-file",
        workspacePath: config.workspacePath,
        dbFilePath: config.dbFilePath
      }
    });
  }

  /**
   * Convenience method for JSON backend with auto-detection
   */
  static async createJsonWithAutoDetection(config?: {
    dbFilePath?: string;
  }): Promise<TaskService> {
    return TaskService.createWithWorkspaceResolvingBackend({
      backend: "json-file",
      backendConfig: {
        name: "json-file",
        dbFilePath: config?.dbFilePath
        // No explicit workspace config - will auto-detect workspace
      }
    });
  }

  /**
   * Convenience method for markdown backends with repo URLs
   */
  static async createMarkdownWithRepo(config: {
    repoUrl: string;
    forceSpecialWorkspace?: boolean;
  }): Promise<TaskService> {
    return TaskService.createWithWorkspaceResolvingBackend({
      backend: "markdown",
      backendConfig: {
        name: "markdown",
        repoUrl: config.repoUrl,
        forceSpecialWorkspace: config.forceSpecialWorkspace
      }
    });
  }

  /**
   * Convenience method for markdown backends with explicit workspace paths
   */
  static async createMarkdownWithWorkspace(config: {
    workspacePath: string;
  }): Promise<TaskService> {
    return TaskService.createWithWorkspaceResolvingBackend({
      backend: "markdown",
      backendConfig: {
        name: "markdown",
        workspacePath: config.workspacePath
      }
    });
  }

  /**
   * Convenience method for current directory workspace detection
   */
  static async createMarkdownWithAutoDetection(): Promise<TaskService> {
    return TaskService.createWithWorkspaceResolvingBackend({
      backend: "markdown",
      backendConfig: {
        name: "markdown"
        // No explicit config - will auto-detect workspace
      }
    });
  }
}

/**
 * Create a TaskService instance with default options
 * @param options Options for creating the TaskService
 * @returns TaskService instance
 */
export function createTaskService(options: TaskServiceOptions = {}): TaskService {
  return new TaskService(options);
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
    return createTaskService(options);
  }

  try {
    // Use node-config to get the resolved backend
    const resolvedBackend = get("backend") || "json-file";

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
