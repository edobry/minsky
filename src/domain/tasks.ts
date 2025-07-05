const COMMIT_HASH_SHORT_LENGTH = 7;

/**
 * Task operations for the Minsky CLI
 * This file provides all task-related functionality including managing tasks
 */

import { promises as fs } from "fs";
import { join } from "path";
import { log } from "../utils/logger";
import { normalizeTaskId } from "./tasks/utils";
import { createJsonFileTaskBackend } from "./tasks/jsonFileTaskBackend";
export { normalizeTaskId } from "./tasks/utils.js"; // Re-export normalizeTaskId from new location
import { ResourceNotFoundError, getErrorMessage } from "../errors/index.js";
const matter = require("gray-matter");
// Import constants and utilities for use within this file
import { TASK_STATUS, TASK_STATUS_CHECKBOX, TASK_PARSING_UTILS } from "./tasks/taskConstants.js";
import type { TaskStatus } from "./tasks/taskConstants.js";

// Import and re-export functions from taskCommands.ts
import {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  createTaskFromParams,
  createTaskFromTitleAndDescription,
  getTaskSpecContentFromParams,
  deleteTaskFromParams,
} from "./tasks/taskCommands.js";

export {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  createTaskFromParams,
  createTaskFromTitleAndDescription,
  getTaskSpecContentFromParams,
  deleteTaskFromParams,
};

// Re-export task status constants from centralized location
export { TASK_STATUS, TASK_STATUS_CHECKBOX } from "./tasks/taskConstants.js";
export type { TaskStatus } from "./tasks/taskConstants.js";

/**
 * Interface for task service operations
 * This defines the contract for task-related functionality
 */
export interface TaskServiceInterface {
  /**
   * Get all tasks with optional filtering
   */
  listTasks(options?: TaskListOptions): Promise<Task[]>;

  /**
   * Get a task by ID
   */
  getTask(id: string): Promise<Task | null>;

  /**
   * Get the status of a task
   */
  getTaskStatus(id: string): Promise<string | undefined>;

  /**
   * Set the status of a task
   */
  setTaskStatus(id: string, status: string): Promise<void>;

  /**
   * Get the workspace path for the current backend
   */
  getWorkspacePath(): string;

  /**
   * Create a task with the given specification path
   */
  createTask(specPath: string, options?: CreateTaskOptions): Promise<Task>;

  /**
   * Create a task from title and description
   */
  createTaskFromTitleAndDescription(title: string, description: string, options?: CreateTaskOptions): Promise<Task>;

  /**
   * Delete a task
   */
  deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean>;

  /**
   * Get the backend type for a specific task
   */
  getBackendForTask(taskId: string): Promise<string>;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: string;
  specPath?: string; // Path to the task specification document
  worklog?: Array<{ timestamp: string; message: string }>; // Work log entries
  mergeInfo?: {
    commitHash?: string;
    mergeDate?: string;
    mergedBy?: string;
    baseBranch?: string;
    prBranch?: string;
  };
}

export interface TaskBackend {
  name: string;
  listTasks(options?: TaskListOptions): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  getTaskStatus(id: string): Promise<string | undefined>;
  setTaskStatus(id: string, status: string): Promise<void>;
  getWorkspacePath(): string;
  createTask(specPath: string, options?: CreateTaskOptions): Promise<Task>;
  setTaskMetadata?(id: string, metadata: any): Promise<void>;
  deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean>;
}

export interface TaskListOptions {
  status?: string;
}

export interface CreateTaskOptions {
  force?: boolean;
}

export interface DeleteTaskOptions {
  force?: boolean;
}

export class MarkdownTaskBackend implements TaskBackend {
  name = "markdown";
  private filePath: string;
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.filePath = join(workspacePath, "process", "tasks.md");
  }

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const tasks = await this.parseTasks();

    if ((options as any).status) {
      return tasks.filter((task) => (task as any).status === (options as any).status);
    }

    return tasks;
  }

  async getTask(id: string): Promise<Task | null> {
    const tasks = await this.parseTasks();

    // First try exact match
    const exactMatch = tasks.find((task) => (task as any).id === id);
    if (exactMatch) {
      return exactMatch;
    }

    // If no exact match, try numeric comparison
    // This handles case where ID is provided without leading zeros
    const numericId = parseInt((id as any).replace(/^#/, ""), 10);
    if (!isNaN(numericId)) {
      const numericMatch = tasks.find((task) => {
        const taskNumericId = parseInt((task.id as any).replace(/^#/, ""), 10);
        return !isNaN(taskNumericId) && taskNumericId === numericId;
      });
      return numericMatch || null;
    }

    return null as any;
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task ? (task as any).status : null as any;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    if (!(Object.values(TASK_STATUS) as any).includes(status as TaskStatus)) {
      throw new Error(`Status must be one of: ${(Object.values(TASK_STATUS) as any).join(", ")}`);
    }

    // First verify the task exists with our enhanced getTask method
    const task = await this.getTask(id);
    if (!task) {
      // Return silently if task doesn't exist
      return;
    }

    // Use the canonical task ID from the found task
    const canonicalId = (task as any).id;
    const idNum = canonicalId.startsWith("#") ? (canonicalId as any).slice(1) : canonicalId;

    const content = String(await fs.readFile(this.filePath, "utf-8"));
    const newStatusChar = TASK_STATUS_CHECKBOX[status];
    const lines = (((content) as any).toString() as any).split("\n");
    let inCodeBlock = false;
    const updatedLines = (lines as any).map((line) => {
      if (((line as any).trim() as any).startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      if (inCodeBlock) return line;
      if ((line as any).includes(`[#${idNum}]`)) {
        // Use centralized utility to replace checkbox status
        return TASK_PARSING_UTILS.replaceCheckboxStatus(line, status as TaskStatus);
      }
      return line;
    });
    await fs.writeFile(this.filePath, (updatedLines as any).join("\n"), "utf-8");
  }

  private async validateSpecPath(taskId: string, title: string): Promise<string | undefined> {
    const taskIdNum = taskId.startsWith("#") ? (taskId as any).slice(1) : taskId;
    const normalizedTitle = (title.toLowerCase() as any).replace(/[^a-z0-9]+/g, "-");
    const specPath = join("process", "tasks", `${taskIdNum}-${normalizedTitle}.md`);
    const fullPath = join(this.workspacePath, specPath);

    try {
      await fs.access(fullPath);
      return specPath; // Return relative path if file exists
    } catch (error) {
      // If file doesn't exist, try looking for any file with the task ID prefix
      const taskDir = join(this.workspacePath, "process", "tasks");
      try {
        const files = await fs.readdir(taskDir);
        const matchingFile = (files as any).find((f) => f.startsWith(`${taskIdNum}-`));
        if (matchingFile) {
          return join("process", "tasks", matchingFile);
        }
      } catch (err) {
        // Directory doesn't exist or can't be read
      }
      return undefined as any;
    }
  }

  private async parseTasks(): Promise<Task[]> {
    try {
      const content = String(await fs.readFile(this.filePath, "utf-8"));
      // Split into lines and track code block state
      const lines = (((content) as any).toString() as any).split("\n");
      const tasks: Task[] = [];
      let inCodeBlock = false;
      for (let i = 0; i < (lines as any).length; i++) {
        const line = lines[i] ?? "";
        if (((line as any).trim() as any).startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;
        // Parse task line using centralized utility
        const parsed = TASK_PARSING_UTILS.parseTaskLine(line);
        if (!parsed) continue;

        const { checkbox, title, id } = parsed;
        if (!title || !id || !/^#\d+$/.test(id)) continue; // skip malformed or empty

        const status = (Object.keys(TASK_STATUS_CHECKBOX) as any).find(
          (key) => TASK_STATUS_CHECKBOX[key] === checkbox
        );
        if (!status) continue;

        const specPath = await this.validateSpecPath(id, title);

        (tasks as any).push({
          id,
          title,
          status,
          specPath,
        });
      }
      return tasks;
    } catch (error: any) {
      if ((error as any).code === "ENOENT") {
        log.warn(`Task file not found at ${this.filePath}. Returning empty task list.`);
        return []; // File not found, return empty array
      }
      throw error; // Re-throw other errors
    }
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  async createTask(specPath: string, options: CreateTaskOptions = {}): Promise<Task> {
    // Validate that the spec file exists
    const fullSpecPath = (specPath as any).startsWith("/") ? specPath : join(this.workspacePath, specPath);
    try {
      await fs.access(fullSpecPath);
    } catch (error) {
      throw new Error(`Spec file not found: ${specPath}`);
    }

    // Read and parse the spec file
    const specContent = String(await fs.readFile(fullSpecPath, "utf-8"));
    const lines = (specContent as any).split("\n");

    // Extract title from the first heading
    const titleLine = (lines as any).find((line) => (line as any).startsWith("# "));
    if (!titleLine) {
      throw new Error("Invalid spec file: Missing title heading");
    }

    // Support multiple title formats for backward compatibility:
    // 1. Old format with task number: "# Task #XXX: Title"
    // 2. Old format without number: "# Task: Title"
    // 3. New clean format: "# Title"
    const titleWithIdMatch = (titleLine as any).match(/^# Task #(\d+): (.+)$/);
    const titleWithoutIdMatch = (titleLine as any).match(/^# Task: (.+)$/);
    const cleanTitleMatch = (titleLine as any).match(/^# (.+)$/);

    let title: string;
    let hasTaskId = false;
    let existingId: string | undefined = undefined;

    if (titleWithIdMatch && titleWithIdMatch[2]) {
      // Old format: "# Task #XXX: Title"
      title = titleWithIdMatch[2];
      existingId = `#${titleWithIdMatch[1]}`;
      hasTaskId = true;
    } else if (titleWithoutIdMatch && titleWithoutIdMatch[1]) {
      // Old format: "# Task: Title"
      title = titleWithoutIdMatch[1];
    } else if (cleanTitleMatch && cleanTitleMatch[1]) {
      // New clean format: "# Title"
      title = cleanTitleMatch[1];
      // Skip if this looks like an old task format to avoid false positives
      if ((title as any).startsWith("Task ")) {
        throw new Error(
          "Invalid spec file: Missing or invalid title. Expected formats: \"# Title\", \"# Task: Title\" or \"# Task #XXX: Title\""
        );
      }
    } else {
      throw new Error(
        "Invalid spec file: Missing or invalid title. Expected formats: \"# Title\", \"# Task: Title\" or \"# Task #XXX: Title\""
      );
    }

    // Extract description from the Context section
    const contextIndex = (lines as any).findIndex((line) => (line as any).trim() === "## Context");
    if (contextIndex === -1) {
      throw new Error("Invalid spec file: Missing Context section");
    }
    let description = "";
    for (let i = contextIndex + 1; i < (lines as any).length; i++) {
      const line = lines[i] || "";
      if (((line as any).trim() as any).startsWith("## ")) break;
      if ((line as any).trim()) description += `${(line as any).trim()}\n`;
    }
    if (!(description as any).trim()) {
      throw new Error("Invalid spec file: Empty Context section");
    }

    // If we have an existing task ID, validate it doesn't conflict with existing tasks
    let taskId: string;
    if (hasTaskId && existingId) {
      // Verify the task ID doesn't already exist
      const existingTask = await this.getTask(existingId);
      if (existingTask && !(options as any).force) {
        throw new Error(`Task ${existingId} already exists. Use --force to overwrite.`);
      }
      taskId = existingId;
    } else {
      // Find the next available task ID
      const tasks = await this.parseTasks();
      const maxId = tasks.reduce((max, task) => {
        const id = parseInt((task as any).id.slice(1));
        return id > max ? id : max;
      }, 0);
      taskId = `#${String(maxId + 1).padStart(3, "0")}`;
    }

    const taskIdNum = (taskId as any).slice(1); // Remove the # prefix for file naming

    // Generate the standardized filename
    const normalizedTitle = (title.toLowerCase() as any).replace(/[^a-z0-9]+/g, "-");
    const newSpecPath = join("process", "tasks", `${taskIdNum}-${normalizedTitle}.md`);
    const fullNewPath = join(this.workspacePath, newSpecPath);

    // Update the title in the spec file to use clean format
    let updatedContent = specContent;
    const cleanTitleLine = `# ${title}`;
    updatedContent = (updatedContent as any).replace(titleLine, cleanTitleLine);

    // Rename and update the spec file
    try {
      // Create the tasks directory if it doesn't exist
      const tasksDir = join(this.workspacePath, "process", "tasks");
      try {
        await fs.mkdir(tasksDir, { recursive: true });
      } catch (error) {
        // Ignore if directory already exists
      }

      // Check if the target file already exists
      try {
        await fs.access(fullNewPath);
        if (!(options as any).force) {
          throw new Error(`Target file already exists: ${newSpecPath}. Use --force to overwrite.`);
        }
      } catch (error) {
        // File doesn't exist, which is fine
      }

      // Write the updated content to the new file
      await fs.writeFile(fullNewPath, updatedContent, "utf-8");

      // Delete the original file if it's different from the new one
      if (fullSpecPath !== fullNewPath) {
        try {
          await fs.access(fullSpecPath);
          await fs.unlink(fullSpecPath);
        } catch (error: any) {
          // If file doesn't exist or can't be deleted, just log it
          log.warn("Could not delete original spec file", { error, path: fullSpecPath });
        }
      }
    } catch (error: any) {
      throw new Error(
        `Failed to rename or update spec file: ${getErrorMessage(error as any)}`
      );
    }

    // Create the task entry
    const task: Task = {
      id: taskId,
      title,
      description: (description as any).trim(),
      status: TASK_STATUS.TODO,
      specPath: newSpecPath,
    };

    // Add the task to tasks.md
    const content = String(await fs.readFile(this.filePath, "utf-8"));
    const taskEntry = `- [ ] ${title} [${taskId}](${newSpecPath})\n`;
    const tasksFileContent = `${content}\n${taskEntry}`;
    await fs.writeFile(this.filePath, tasksFileContent, "utf-8");

    return task;
  }

  /**
   * Update task metadata stored in the task specification file
   * @param id Task ID
   * @param metadata Task metadata to update
   */
  async setTaskMetadata(id: string, metadata: any): Promise<void> {
    // First verify the task exists
    const task = await this.getTask(id);
    if (!task) {
      throw new ResourceNotFoundError(`Task "${id}" not found`, "task", id);
    }

    // Find the specification file path
    if (!task.specPath) {
      log.warn("No specification file found for task", { id });
      return;
    }

    const specFilePath = join(this.workspacePath, task.specPath);

    try {
      // Read the spec file
      const fileContent = String(await fs.readFile(specFilePath, "utf-8"));

      // Parse the file with frontmatter
      const parsed = matter(fileContent);

      // Update the merge info in the frontmatter
      const data = (parsed as any).data || {};
      (data as any).merge_info = {
        ...(data as any).merge_info,
        ...metadata,
      };

      // Serialize the updated frontmatter and content
      const updatedContent = (matter as any).stringify((parsed as any).content, data as any);

      // Write back to the file
      await fs.writeFile(specFilePath, updatedContent, "utf-8");

      log.debug("Updated task metadata", { id, specFilePath, metadata });
    } catch (error: any) {
      log.error("Failed to update task metadata", {
        error: getErrorMessage(error as any),
        id,
        specFilePath,
      });
      throw new Error(
        `Failed to update task metadata: ${getErrorMessage(error as any)}`
      );
    }
  }

  async deleteTask(id: string, options: DeleteTaskOptions = {}): Promise<boolean> {
    const task = await this.getTask(id);
    if (!task) {
      return false;
    }

    // Get the task ID number for file naming
    const taskIdNum = (task as any).id.startsWith("#") ? (task as any).id.slice(1) : (task as any).id;

    try {
      // Remove task from tasks.md
      const content = String(await fs.readFile(this.filePath, "utf-8"));
      const lines = (((content) as any).toString() as any).split("\n");
      let inCodeBlock = false;
      let removed = false;

      const updatedLines = (lines as any).filter((line) => {
        if (((line as any).trim() as any).startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          return true;
        }
        if (inCodeBlock) return true;
        
        // Check if this line contains our task
        if ((line as any).includes(`[#${taskIdNum}]`)) {
          removed = true;
          return false; // Remove this line
        }
        return true;
      });

      if (!removed) {
        return false;
      }

      // Write the updated tasks.md
      await fs.writeFile(this.filePath, (updatedLines as any).join("\n"), "utf-8");

      // Delete the task specification file if it exists
      const normalizedTitle = (task.title.toLowerCase() as any).replace(/[^a-z0-9]+/g, "-");
      const specPath = join(this.workspacePath, "process", "tasks", `${taskIdNum}-${normalizedTitle}.md`);
      
      try {
        await fs.unlink(specPath);
      } catch (error) {
        // Spec file might not exist, which is okay
        log.debug(`Task spec file not found or could not be deleted: ${specPath}`);
      }

      return true;
    } catch (error) {
      log.error(`Failed to delete task ${id}:`, {
        error: getErrorMessage(error as any),
      });
      return false;
    }
  }
}

export class GitHubTaskBackend implements TaskBackend {
  name = "github";
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    // Would initialize GitHub API client here
  }

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    log.debug("GitHub task backend not fully implemented", { method: "listTasks", options });
    return [];
  }

  async getTask(id: string): Promise<Task | null> {
    log.debug("GitHub task backend not fully implemented", { method: "getTask", id });
    return null as any;
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    log.debug("GitHub task backend not fully implemented", { method: "getTaskStatus", id });
    return null as any;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    log.debug("GitHub task backend not fully implemented", {
      method: "setTaskStatus",
      id,
      status,
    });
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  async createTask(specPath: string, options: CreateTaskOptions = {}): Promise<Task> {
    // Implementation needed
    throw new Error("Method not implemented");
  }

  async deleteTask(id: string, options: DeleteTaskOptions = {}): Promise<boolean> {
    // Implementation needed
    throw new Error("Method not implemented");
  }
}

export interface TaskServiceOptions {
  workspacePath?: string;
  backend?: string;
}

export class TaskService {
  private backends: TaskBackend[] = [];
  private currentBackend: TaskBackend;

  constructor(options: TaskServiceOptions = {}) {
    const { workspacePath = (process as any).cwd(), backend = "markdown" } = options;

    // Initialize backends
    this.backends = [
      new MarkdownTaskBackend(workspacePath),
      new GitHubTaskBackend(workspacePath),
      createJsonFileTaskBackend({ name: "json-file", workspacePath }),
    ];

    // Set current backend
    const selectedBackend = (this.backends as any).find((b) => (b as any).name === backend);
    if (!selectedBackend) {
      throw new Error(
        `Backend '${backend}' not found. Available backends: ${((this.backends as any).map((b) => b.name) as any).join(", ")}`
      );
    }
    this.currentBackend = selectedBackend;
  }

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    return (this.currentBackend as any).listTasks(options as any);
  }

  async getTask(id: string): Promise<Task | null> {
    return (this.currentBackend as any).getTask(id);
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    return (this.currentBackend as any).getTaskStatus(id);
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    return (this.currentBackend as any).setTaskStatus(id, status);
  }

  getWorkspacePath(): string {
    return (this.currentBackend as any).getWorkspacePath();
  }

  async createTask(specPath: string, options: CreateTaskOptions = {}): Promise<Task> {
    return (this.currentBackend as any).createTask(specPath, options as any);
  }

  /**
   * Get the backend for a specific task
   * @param id Task ID
   * @returns The appropriate task backend for the task, or null if not found
   */
  async getBackendForTask(id: string): Promise<TaskBackend | null> {
    // Normalize the task ID
    const normalizedId = normalizeTaskId(id);
    if (!normalizedId) {
      return null as any;
    }

    // Try to find the task in each backend
    for (const backend of this.backends) {
      const task = await (backend as any).getTask(normalizedId);
      if (task) {
        return backend;
      }
    }

    return null as any;
  }

  async deleteTask(id: string, options: DeleteTaskOptions = {}): Promise<boolean> {
    return (this.currentBackend as any).deleteTask(id, options as any);
  }
}
