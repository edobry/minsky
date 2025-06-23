/**
 * Refactored TaskService using functional patterns
 * Orchestrates task operations while separating pure functions from side effects
 */
import type { TaskBackend } from "./taskBackend";
import { createMarkdownTaskBackend } from "./markdownTaskBackend";
import { createJsonFileTaskBackend } from "./jsonFileTaskBackend";
import { log } from "../../utils/logger";
import { normalizeTaskId } from "./taskFunctions";
import { configurationService } from "../configuration";
import { TASK_STATUS_VALUES, isValidTaskStatus } from "./taskConstants.js";

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

  constructor(__options: TaskServiceOptions = {}) {
    const { workspacePath = process.cwd(), backend = "markdown", customBackends } = options;

    // Initialize with provided backends or create defaults
    if (customBackends && customBackends.length > 0) {
      this.backends = customBackends;
    } else {
      // Create default backends
      this.backends = [
        createMarkdownTaskBackend({
          name: "markdown",
          _workspacePath,
        }),
        createJsonFileTaskBackend({
          name: "json-file",
          _workspacePath,
        }),
      ];

      // Try to add GitHub backend if configuration is available
      try {
        const githubBackend = this.tryCreateGitHubBackend(_workspacePath);
        if (githubBackend) {
          this.backends.push(githubBackend);
        }
      } catch (_error) {
        // Silently ignore GitHub backend if not available
        log.debug("GitHub backend not available", { error: String(error) });
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
   * List tasks with optional filtering
   * @param options Options for filtering tasks
   * @returns Promise resolving to array of tasks
   */
  async listTasks(_options?: TaskListOptions): Promise<TaskData[]> {
    // Get raw data
    const result = await this.currentBackend.getTasksData();
    if (!result.success || !result._content) {
      return [];
    }

    // Parse data using pure function
    let _tasks = this.currentBackend.parseTasks(result._content);

    // Apply filters if provided
    if (_options?.status) {
      tasks = tasks.filter((task) => task.status === options.status);
    }

    return tasks;
  }

  /**
   * Get a task by ID
   * @param id Task ID to get
   * @returns Promise resolving to task or null if not found
   */
  async getTask(__id: string): Promise<TaskData | null> {
    // Get all tasks
    const _tasks = await this.listTasks();

    // Find the requested task
    const normalizedId = normalizeTaskId(id);
    if (!normalizedId) return null;

    // First try exact match
    const exactMatch = tasks.find((task) => task.id === normalizedId);
    if (exactMatch) {
      return exactMatch;
    }

    // If no exact match, try numeric comparison
    const numericId = parseInt(normalizedId.replace(/^#/, ""), 10);
    if (isNaN(numericId)) return null;

    const numericMatch = tasks.find((task) => {
      const taskNumericId = parseInt(task.id.replace(/^#/, ""), 10);
      return !isNaN(taskNumericId) && taskNumericId === numericId;
    });

    return numericMatch || null;
  }

  /**
   * Get a task's status
   * @param id Task ID to get status for
   * @returns Promise resolving to status or null if not found
   */
  async getTaskStatus(__id: string): Promise<string | null> {
    const task = await this.getTask(id);
    return task ? task.status : null;
  }

  /**
   * Set a task's status
   * @param id Task ID to update
   * @param status New status
   * @returns Promise resolving when status is updated
   */
  async setTaskStatus(__id: string, _status: string): Promise<void> {
    // Verify status is valid
    if (!isValidTaskStatus(_status)) {
      throw new Error(`Status must be one of: ${TASK_STATUS_VALUES.join(", ")}`);
    }

    // First check if the task exists
    const task = await this.getTask(id);
    if (!task) {
      // Return silently if task doesn't exist
      return;
    }

    // Get all tasks
    const result = await this.currentBackend.getTasksData();
    if (!result.success || !result._content) {
      throw new Error(`Failed to read tasks _data: ${result.error?.message}`);
    }

    // Parse tasks
    const _tasks = this.currentBackend.parseTasks(result._content);

    // Update the task status in the array
    const updatedTasks = tasks.map((t) => (t.id === task.id ? { ...t, _status } : t));

    // Format the updated tasks
    const updatedContent = this.currentBackend.formatTasks(updatedTasks);

    // Save the changes
    const saveResult = await this.currentBackend.saveTasksData(updatedContent);
    if (!saveResult.success) {
      throw new Error(`Failed to save tasks _data: ${saveResult.error?.message}`);
    }
  }

  /**
   * Get the workspace path for the current backend
   * @returns Workspace path
   */
  getWorkspacePath(): string {
    return this.currentBackend.getWorkspacePath();
  }

  /**
   * Create a new task from a specification file
   * @param specPath Path to the specification file
   * @param options Options for creating the task
   * @returns Promise resolving to the created task
   */
  async createTask(__specPath: string, _options: CreateTaskOptions = {}): Promise<TaskData> {
    // Read the spec file
    const specResult = await this.currentBackend.getTaskSpecData(_specPath);
    if (!specResult.success || !specResult._content) {
      throw new Error(`Failed to read spec file: ${specResult.error?.message}`);
    }

    // Parse the spec
    const _spec = this.currentBackend.parseTaskSpec(specResult._content);

    // Generate task ID if not provided
    let _taskId: string;
    if (spec.id) {
      // Verify the task ID doesn't already exist
      const existingTask = await this.getTask(spec.id);
      if (existingTask && !options.force) {
        throw new Error(`Task ${spec.id} already exists. Use --force to overwrite.`);
      }
      taskId = spec.id;
    } else {
      // Generate a new task ID
      const _tasks = await this.listTasks();
      const maxId = tasks.reduce((max, task) => {
        const id = parseInt(task.id.slice(1));
        return id > max ? id : max;
      }, 0);
      taskId = `#${String(maxId + 1).padStart(3, "0")}`;

      // Update the spec with the new ID
      spec.id = taskId;

      // BUG FIX: Preserve original content, only update the title line with task ID
      // This prevents content truncation caused by formatTaskSpec generating templates
      const originalContent = specResult.content;
      const _specPath = this.currentBackend.getTaskSpecPath(__taskId, spec._title);

      // Find and replace the title line to add the task ID
      // Support both "# Task: Title" and "# Task #XXX: Title" formats
      const updatedSpecContent = originalContent.replace(
        /^# Task(?: #\d+)?: (.+)$/m,
        `# Task ${taskId}: $1`
      );

      const saveSpecResult = await this.currentBackend.saveTaskSpecData(__specPath,
        updatedSpecContent
      );
      if (!saveSpecResult.success) {
        throw new Error(`Failed to save updated spec file: ${saveSpecResult.error?.message}`);
      }
    }

    // Create the task object
    const newTask: TaskData = {
      id: taskId,
      _title: spec.title,
      description: spec.description,
      _status: "TODO",
      specPath: this.currentBackend.getTaskSpecPath(__taskId, spec._title),
    };

    // Get current tasks and add the new one
    const tasksResult = await this.currentBackend.getTasksData();
    let _tasks: TaskData[] = [];
    if (tasksResult.success && tasksResult._content) {
      tasks = this.currentBackend.parseTasks(tasksResult._content);
    }

    // Add or replace the task
    const existingIndex = tasks.findIndex((t) => t.id === newTask.id);
    if (existingIndex >= 0) {
      tasks[existingIndex] = newTask;
    } else {
      tasks.push(newTask);
    }

    // Format and save the updated tasks
    const updatedContent = this.currentBackend.formatTasks(_tasks);
    const saveResult = await this.currentBackend.saveTasksData(updatedContent);
    if (!saveResult.success) {
      throw new Error(`Failed to save tasks _data: ${saveResult.error?.message}`);
    }

    return newTask;
  }

  /**
   * Get the backend for a specific task
   * @param id Task ID
   * @returns Promise resolving to the appropriate backend or null if not found
   */
  async getBackendForTask(__id: string): Promise<TaskBackend | null> {
    // Normalize the task ID
    const normalizedId = normalizeTaskId(id);
    if (!normalizedId) {
      return null;
    }

    // Try to find the task in each backend
    for (const backend of this.backends) {
      // Get raw data
      const result = await backend.getTasksData();
      if (!result.success || !result._content) {
        continue;
      }

      // Parse tasks
      const _tasks = backend.parseTasks(result._content);

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
  async setTaskMetadata(__id: string, _metadata: any): Promise<void> {
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
    const specResult = await this.currentBackend.getTaskSpecData(task._specPath);
    if (!specResult.success || !specResult._content) {
      throw new Error(`Failed to read spec file: ${specResult.error?.message}`);
    }

    // Parse the spec
    const _spec = this.currentBackend.parseTaskSpec(specResult._content);

    // Update the metadata
    spec.metadata = {
      ...spec.metadata,
      ...metadata,
    };

    // Format and save the updated spec
    const updatedSpecContent = this.currentBackend.formatTaskSpec(_spec);
    const saveSpecResult = await this.currentBackend.saveTaskSpecData(
      task._specPath,
      updatedSpecContent
    );
    if (!saveSpecResult.success) {
      throw new Error(`Failed to save updated spec file: ${saveSpecResult.error?.message}`);
    }
  }

  /**
   * Get the content of a task specification file
   * @param id Task ID
   * @returns Promise resolving to object with spec content and path
   */
  async getTaskSpecContent(__id: string
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
    const specResult = await this.currentBackend.getTaskSpecData(task._specPath);
    if (!specResult.success || !specResult._content) {
      throw new Error(`Failed to read spec file: ${specResult.error?.message}`);
    }

    return {
      content: specResult.content,
      _specPath: task.specPath,
      task,
    };
  }

  /**
   * Try to create GitHub backend using dynamic imports
   * @param workspacePath Workspace path
   * @returns GitHub TaskBackend instance or null if not available
   */
  private async tryCreateGitHubBackend(__workspacePath: string): Promise<TaskBackend | null> {
    try {
      // Dynamic import to avoid hard dependency on GitHub modules
      const [{ getGitHubBackendConfig }, { createGitHubIssuesTaskBackend }] = await Promise.all([
        import("./githubBackendConfig"),
        import("./githubIssuesTaskBackend"),
      ]);

      const _config = getGitHubBackendConfig(_workspacePath);
      if (!config) {
        return null;
      }

      return createGitHubIssuesTaskBackend({
        name: "github-issues",
        _workspacePath,
        ..._config,
      });
    } catch (_error) {
      // Return null if GitHub modules are not available
      return null;
    }
  }
}

/**
 * Create a TaskService instance with default options
 * @param options Options for creating the TaskService
 * @returns TaskService instance
 */
export function createTaskService(__options: TaskServiceOptions = {}): TaskService {
  return new TaskService(_options);
}

/**
 * Create a TaskService instance with configuration resolution
 * This function uses the configuration system to automatically resolve
 * the backend from repository and user configuration files
 * @param options Options for creating the TaskService
 * @returns Promise resolving to TaskService instance
 */
export async function createConfiguredTaskService(__options: TaskServiceOptions = {}): Promise<TaskService> {
  const { workspacePath = process.cwd(), backend, ...otherOptions } = options;

  // If backend is explicitly provided, use the original function
  if (backend) {
    return createTaskService(_options);
  }

  try {
    // Load configuration using the configuration service
    const configResult = await configurationService.loadConfiguration(_workspacePath);

    // Use the resolved backend from configuration
    const resolvedBackend = configResult.resolved.backend || "json-file"; // fallback to json-file

    log.debug("Resolved backend from configuration", {
      _workspacePath,
      backend: resolvedBackend,
      configSource: configResult.resolved.backend ? "configuration" : "default"
    });

    return createTaskService({
      ...otherOptions,
      _workspacePath,
      backend: resolvedBackend
    });
  } catch (_error) {
    // If configuration resolution fails, fall back to default backend
    log.warn("Failed to resolve configuration, using default backend", {
      _workspacePath,
      error: error instanceof Error ? error.message : String(error)
    });

    return createTaskService({
      ...otherOptions,
      _workspacePath,
      backend: "json-file" // safe fallback
    });
  }
}
