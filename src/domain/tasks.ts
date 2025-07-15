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
export { normalizeTaskId } from "./tasks/utils"; // Re-export normalizeTaskId from new location
import { ResourceNotFoundError, getErrorMessage } from "../errors/index";
const matter = require("gray-matter");
// Import constants and utilities for use within this file
import { TASK_STATUS, TASK_STATUS_CHECKBOX, TASK_PARSING_UTILS } from "./tasks/taskConstants";
import type { TaskStatus } from "./tasks/taskConstants";
import { getTaskSpecRelativePath } from "./tasks/taskIO";

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
} from "./tasks/taskCommands";

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
export { TASK_STATUS, TASK_STATUS_CHECKBOX } from "./tasks/taskConstants";
export type { TaskStatus } from "./tasks/taskConstants";

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

    if (options && options.status) {
      return tasks.filter((task) => task.status === options.status);
    }

    return tasks;
  }

  async getTask(id: string): Promise<Task | null> {
    const tasks = await this.parseTasks();

    // First try exact match
    const exactMatch = tasks.find((task) => task.id === id);
    if (exactMatch) {
      return exactMatch;
    }

    // If no exact match, try numeric comparison
    // This handles case where ID is provided without leading zeros
    const numericId = parseInt(id.replace(/^#/, ""), 10);
    if (!isNaN(numericId)) {
      const numericMatch = tasks.find((task) => {
        const taskNumericId = parseInt(task.id.replace(/^#/, ""), 10);
        return !isNaN(taskNumericId) && taskNumericId === numericId;
      });
      return numericMatch || null;
    }

    return null;
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task ? task.status : null;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    if (!Object.values(TASK_STATUS).includes(status as TaskStatus)) {
      throw new Error(`Status must be one of: ${Object.values(TASK_STATUS).join(", ")}`);
    }

    // First verify the task exists with our enhanced getTask method
    const task = await this.getTask(id);
    if (!task) {
      // Return silently if task doesn't exist
      return;
    }

    // Use the canonical task ID from the found task
    const canonicalId = task.id;
    const idNum = canonicalId.startsWith("#") ? canonicalId.slice(1) : canonicalId;

    const content = String(await fs.readFile(this.filePath, "utf-8"));
    const newStatusChar = TASK_STATUS_CHECKBOX[status];
    const lines = content.toString().split("\n");
    let inCodeBlock = false;
    const updatedLines = lines.map((line) => {
      if (line.trim().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      if (inCodeBlock) return line;
      if (line.includes(`[#${idNum}]`)) {
        // Use centralized utility to replace checkbox status
        return TASK_PARSING_UTILS.replaceCheckboxStatus(line, status as TaskStatus);
      }
      return line;
    });
    await fs.writeFile(this.filePath, updatedLines.join("\n"), "utf-8");
  }

  private async validateSpecPath(taskId: string, title: string): Promise<string | undefined> {
    const taskIdNum = taskId.startsWith("#") ? taskId.slice(1) : taskId;
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const specPath = getTaskSpecRelativePath(taskId, title, this.workspacePath);
    const fullPath = join(this.workspacePath, specPath);

    try {
      await fs.access(fullPath);
      return specPath; // Return relative path if file exists
    } catch (error) {
      // If file doesn't exist, try looking for any file with the task ID prefix
      const taskDir = join(this.workspacePath, "process", "tasks");
      try {
        const files = await fs.readdir(taskDir);
        const matchingFile = files.find((f) => f.startsWith(`${taskIdNum}-`));
        if (matchingFile) {
          return getTaskSpecRelativePath(taskId, matchingFile.replace(`${taskIdNum}-`, "").replace(".md", ""), this.workspacePath);
        }
      } catch (err) {
        // Directory doesn't exist or can't be read
      }
      return undefined;
    }
  }

  private async parseTasks(): Promise<Task[]> {
    try {
      const content = String(await fs.readFile(this.filePath, "utf-8"));
      // Split into lines and track code block state
      const lines = content.toString().split("\n");
      const tasks: Task[] = [];
      let inCodeBlock = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line.trim().startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;
        // Parse task line using centralized utility
        const parsed = TASK_PARSING_UTILS.parseTaskLine(line);
        if (!parsed) continue;

        const { checkbox, title, id } = parsed;
        if (!title || !id || !/^#\d+$/.test(id)) continue; // skip malformed or empty

        const status = Object.keys(TASK_STATUS_CHECKBOX).find(
          (key) => TASK_STATUS_CHECKBOX[key] === checkbox
        );
        if (!status) continue;

        const specPath = await this.validateSpecPath(id, title);

        // Collect description from indented lines following this task
        let description: string | undefined = undefined;
        const descriptionLines: string[] = [];

        // Look at the next lines to see if they contain indented description content
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j] ?? "";

          // Stop if we hit a code block marker
          if (nextLine.trim().startsWith("```")) {
            break;
          }

          // Stop if we hit another task line (not indented)
          if (TASK_PARSING_UTILS.parseTaskLine(nextLine)) {
            break;
          }

          // Stop if we hit an empty line
          if (nextLine.trim() === "") {
            break;
          }

          // Check if this is an indented description line (starts with spaces/tabs and has content)
          if (nextLine.match(/^\s+- (.+)/) || nextLine.match(/^\s+(.+)/)) {
            const trimmedLine = nextLine.trim();
            if (trimmedLine.startsWith("- ")) {
              // Remove the bullet point from description lines
              descriptionLines.push(trimmedLine.substring(2));
            } else {
              descriptionLines.push(trimmedLine);
            }
          } else {
            // Non-indented line that's not a task - stop collecting
            break;
          }
        }

        if (descriptionLines.length > 0) {
          description = descriptionLines.join(" ");
        }

        tasks.push({
          id,
          title,
          status,
          specPath,
          description,
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
    const fullSpecPath = specPath.startsWith("/") ? specPath : join(this.workspacePath, specPath);
    try {
      await fs.access(fullSpecPath);
    } catch (error) {
      throw new Error(`Spec file not found: ${specPath}`);
    }

    // Read and parse the spec file
    const specContent = String(await fs.readFile(fullSpecPath, "utf-8"));
    const lines = specContent.split("\n");

    // Extract title from the first heading
    const titleLine = lines.find((line) => line.startsWith("# "));
    if (!titleLine) {
      throw new Error("Invalid spec file: Missing title heading");
    }

    // Support multiple title formats for backward compatibility:
    // 1. Old format with task number: "# Task #XXX: Title"
    // 2. Old format without number: "# Task: Title"
    // 3. New clean format: "# Title"
    const titleWithIdMatch = titleLine.match(/^# Task #(\d+): (.+)$/);
    const titleWithoutIdMatch = titleLine.match(/^# Task: (.+)$/);
    const cleanTitleMatch = titleLine.match(/^# (.+)$/);

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
      if (title.startsWith("Task ")) {
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
    const contextIndex = lines.findIndex((line) => line.trim() === "## Context");
    if (contextIndex === -1) {
      throw new Error("Invalid spec file: Missing Context section");
    }
    let description = "";
    for (let i = contextIndex + 1; i < lines.length; i++) {
      const line = lines[i] || "";
      if (line.trim().startsWith("## ")) break;
      if (line.trim()) description += `${line.trim()}\n`;
    }
    if (!description.trim()) {
      throw new Error("Invalid spec file: Empty Context section");
    }

    // If we have an existing task ID, validate it doesn't conflict with existing tasks
    let taskId: string;
    if (hasTaskId && existingId) {
      // Verify the task ID doesn't already exist
      const existingTask = await this.getTask(existingId);
      if (existingTask && !options.force) {
        throw new Error(`Task ${existingId} already exists. Use --force to overwrite.`);
      }
      taskId = existingId;
    } else {
      // Find the next available task ID
      const tasks = await this.parseTasks();
      const maxId = tasks.reduce((max, task) => {
        const id = parseInt(task.id.slice(1));
        return id > max ? id : max;
      }, 0);
      taskId = `#${String(maxId + 1).padStart(3, "0")}`;
    }

    const taskIdNum = taskId.slice(1); // Remove the # prefix for file naming

    // Generate the standardized filename
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const newSpecPath = getTaskSpecRelativePath(taskId, title, this.workspacePath);
    const fullNewPath = join(this.workspacePath, newSpecPath);

    // Update the title in the spec file to use clean format
    let updatedContent = specContent;
    const cleanTitleLine = `# ${title}`;
    updatedContent = updatedContent.replace(titleLine, cleanTitleLine);

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
        if (!options.force) {
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
      description: description.trim(),
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
      const data = parsed.data || {};
      data.merge_info = {
        ...data.merge_info,
        ...metadata,
      };

      // Serialize the updated frontmatter and content
      const updatedContent = matter.stringify(parsed.content, data as unknown);

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
    const taskIdNum = task.id.startsWith("#") ? task.id.slice(1) : task.id;

    try {
      // Remove task from tasks.md
      const content = String(await fs.readFile(this.filePath, "utf-8"));
      const lines = content.toString().split("\n");
      let inCodeBlock = false;
      let removed = false;

      const updatedLines = lines.filter((line) => {
        if (line.trim().startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          return true;
        }
        if (inCodeBlock) return true;

        // Check if this line contains our task
        if (line.includes(`[#${taskIdNum}]`)) {
          removed = true;
          return false; // Remove this line
        }
        return true;
      });

      if (!removed) {
        return false;
      }

      // Write the updated tasks.md
      await fs.writeFile(this.filePath, updatedLines.join("\n"), "utf-8");

      // Delete the task specification file if it exists
      const specPath = join(this.workspacePath, getTaskSpecRelativePath(task.id, task.title, this.workspacePath));

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
    return null;
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    log.debug("GitHub task backend not fully implemented", { method: "getTaskStatus", id });
    return null;
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
    const selectedBackend = this.backends.find((b) => b.name === backend);
    if (!selectedBackend) {
      throw new Error(
        `Backend '${backend}' not found. Available backends: ${(this.backends.map((b) => b.name) as unknown).join(", ")}`
      );
    }
    this.currentBackend = selectedBackend;
  }

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    return (this.currentBackend as unknown).listTasks(options as unknown);
  }

  async getTask(id: string): Promise<Task | null> {
    return (this.currentBackend as unknown).getTask(id);
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    return (this.currentBackend as unknown).getTaskStatus(id);
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    return (this.currentBackend as unknown).setTaskStatus(id, status);
  }

  getWorkspacePath(): string {
    return (this.currentBackend as unknown).getWorkspacePath();
  }

  async createTask(specPath: string, options: CreateTaskOptions = {}): Promise<Task> {
    return (this.currentBackend as unknown).createTask(specPath, options as unknown);
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
      return null;
    }

    // Try to find the task in each backend
    for (const backend of this.backends) {
      const task = await backend.getTask(normalizedId);
      if (task) {
        return backend;
      }
    }

    return null;
  }

  async deleteTask(id: string, options: DeleteTaskOptions = {}): Promise<boolean> {
    return (this.currentBackend as unknown).deleteTask(id, options as unknown);
  }
}
