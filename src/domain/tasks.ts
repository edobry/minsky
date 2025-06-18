import { promises as fs } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { log } from "../utils/logger";
import { normalizeTaskId } from "./tasks/utils.js";
export { normalizeTaskId } from "./tasks/utils.js"; // Re-export normalizeTaskId from new location
import type {
  TaskListParams,
  TaskGetParams,
  TaskStatusGetParams,
  TaskStatusSetParams,
  TaskCreateParams,
} from "../schemas/tasks.js";
import { ResourceNotFoundError } from "../errors/index.js";
import matter from "gray-matter";

// Import and re-export functions from taskCommands.ts
import {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  createTaskFromParams,
  getTaskSpecContentFromParams,
  taskSpecContentParamsSchema,
  type TaskSpecContentParams,
} from "./tasks/taskCommands.js";

export {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  createTaskFromParams,
  getTaskSpecContentFromParams,
  taskSpecContentParamsSchema,
  type TaskSpecContentParams,
};

const execAsync = promisify(exec);

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
  getTaskStatus(id: string): Promise<string | null>;

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
  getTaskStatus(id: string): Promise<string | null>;
  setTaskStatus(id: string, status: string): Promise<void>;
  getWorkspacePath(): string;
  createTask(specPath: string, options?: CreateTaskOptions): Promise<Task>;
  setTaskMetadata?(id: string, metadata: any): Promise<void>;
}

export interface TaskListOptions {
  status?: string;
}

export interface CreateTaskOptions {
  force?: boolean;
}

// Task status constants and checkbox mapping
export const TASK_STATUS = {
  TODO: "TODO",
  DONE: "DONE",
  IN_PROGRESS: "IN-PROGRESS",
  IN_REVIEW: "IN-REVIEW",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export const TASK_STATUS_CHECKBOX: Record<string, string> = {
  [TASK_STATUS.TODO]: " ",
  [TASK_STATUS.DONE]: "x",
  [TASK_STATUS.IN_PROGRESS]: "-",
  [TASK_STATUS.IN_REVIEW]: "+",
};

export const CHECKBOX_TO_STATUS: Record<string, TaskStatus> = {
  " ": TASK_STATUS.TODO,
  x: TASK_STATUS.DONE,
  "-": TASK_STATUS.IN_PROGRESS,
  "+": TASK_STATUS.IN_REVIEW,
};

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

    if (options?.status) {
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

  async getTaskStatus(id: string): Promise<string | null> {
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

    const content = await fs.readFile(this.filePath, "utf-8");
    const newStatusChar = TASK_STATUS_CHECKBOX[status];
    const lines = content.split("\n");
    let inCodeBlock = false;
    const updatedLines = lines.map((line) => {
      if (line.trim().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      if (inCodeBlock) return line;
      if (line.includes(`[#${idNum}]`)) {
        // Replace only the first checkbox in the line
        return line.replace(/^(\s*- \[)( |x|\-|\+)(\])/, `$1${newStatusChar}$3`);
      }
      return line;
    });
    await fs.writeFile(this.filePath, updatedLines.join("\n"), "utf-8");
  }

  private async validateSpecPath(taskId: string, title: string): Promise<string | undefined> {
    const taskIdNum = taskId.startsWith("#") ? taskId.slice(1) : taskId;
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const specPath = join("process", "tasks", `${taskIdNum}-${normalizedTitle}.md`);
    const fullPath = join(this.workspacePath, specPath);

    try {
      await fs.access(fullPath);
      return specPath; // Return relative path if file exists
    } catch {
      // If file doesn't exist, try looking for any file with the task ID prefix
      const taskDir = join(this.workspacePath, "process", "tasks");
      try {
        const files = await fs.readdir(taskDir);
        const matchingFile = files.find((f) => f.startsWith(`${taskIdNum}-`));
        if (matchingFile) {
          return join("process", "tasks", matchingFile);
        }
      } catch {
        // Directory doesn't exist or can't be read
      }
      return undefined;
    }
  }

  private async parseTasks(): Promise<Task[]> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      // Split into lines and track code block state
      const lines = content.split("\n");
      const tasks: Task[] = [];
      let inCodeBlock = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line.trim().startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;
        // Match top-level tasks: - [ ] Title [#123](...)
        const match = /^- \[( |x|\-|\+)\] (.+?) \[#(\d+)\]\([^)]+\)/.exec(line);
        if (!match) continue;
        const checkbox = match[1];
        const title = match[2]?.trim() ?? "";
        const id = `#${match[3] ?? ""}`;
        if (!title || !id || !/^#\d+$/.test(id)) continue; // skip malformed or empty
        const status =
          CHECKBOX_TO_STATUS[checkbox as keyof typeof CHECKBOX_TO_STATUS] || TASK_STATUS.TODO;
        // Aggregate indented lines as description
        let description = "";
        for (let j = i + 1; j < lines.length; j++) {
          const subline = lines[j] ?? "";
          if (subline.trim().startsWith("```")) break;
          if (/^- \[.\]/.test(subline)) break; // next top-level task
          if (/^\s+- /.test(subline)) {
            description += `${subline.trim().replace(/^- /, "") ?? ""}\n`;
          } else if ((subline.trim() ?? "") === "") {
            continue;
          } else {
            break;
          }
        }

        // Use the new validateSpecPath function to get the correct path
        const specPath = await this.validateSpecPath(id, title);

        tasks.push({
          id,
          title,
          status,
          description: description.trim(),
          specPath,
        });
      }
      return tasks;
    } catch (error) {
      log.error("Error reading tasks file", { error, filePath: this.filePath });
      return [];
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
    const specContent = await fs.readFile(fullSpecPath, "utf-8");
    const lines = specContent.split("\n");

    // Extract title from the first heading
    const titleLine = lines.find((line) => line.startsWith("# "));
    if (!titleLine) {
      throw new Error("Invalid spec file: Missing title heading");
    }

    // Support both "# Task: Title" and "# Task #XXX: Title" formats
    // Improved regex patterns for more robust matching
    const titleWithIdMatch = titleLine.match(/^# Task #(\d+): (.+)$/);
    const titleWithoutIdMatch = titleLine.match(/^# Task: (.+)$/);

    let title: string;
    let hasTaskId = false;
    let existingId: string | null = null;

    if (titleWithIdMatch && titleWithIdMatch[2]) {
      title = titleWithIdMatch[2];
      existingId = `#${titleWithIdMatch[1]}`;
      hasTaskId = true;
    } else if (titleWithoutIdMatch && titleWithoutIdMatch[1]) {
      title = titleWithoutIdMatch[1];
    } else {
      throw new Error(
        "Invalid spec file: Missing or invalid title. Expected formats: \"# Task: Title\" or \"# Task #XXX: Title\""
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
    const newSpecPath = join("process", "tasks", `${taskIdNum}-${normalizedTitle}.md`);
    const fullNewPath = join(this.workspacePath, newSpecPath);

    // Update the title in the spec file to include the task number if needed
    let updatedContent = specContent;
    if (!hasTaskId) {
      const updatedTitleLine = `# Task ${taskId}: ${title}`;
      updatedContent = updatedContent.replace(titleLine, updatedTitleLine);
    }

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
        } catch (error) {
          // If file doesn't exist or can't be deleted, just log it
          log.warn("Could not delete original spec file", { error, path: fullSpecPath });
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to rename or update spec file: ${error instanceof Error ? error.message : String(error)}`
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
    const content = await fs.readFile(this.filePath, "utf-8");
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
      const fileContent = await fs.readFile(specFilePath, "utf8");

      // Parse the file with frontmatter
      const parsed = matter(fileContent);

      // Update the merge info in the frontmatter
      const data = parsed.data || {};
      data.merge_info = {
        ...data.merge_info,
        ...metadata,
      };

      // Serialize the updated frontmatter and content
      const updatedContent = matter.stringify(parsed.content, data);

      // Write back to the file
      await fs.writeFile(specFilePath, updatedContent, "utf8");

      log.debug("Updated task metadata", { id, specFilePath, metadata });
    } catch (error) {
      log.error("Failed to update task metadata", {
        error: error instanceof Error ? error.message : String(error),
        id,
        specFilePath,
      });
      throw new Error(
        `Failed to update task metadata: ${error instanceof Error ? error.message : String(error)}`
      );
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

  async getTaskStatus(id: string): Promise<string | null> {
    log.debug("GitHub task backend not fully implemented", { method: "getTaskStatus", id });
    return null;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    log.debug("GitHub task backend not fully implemented", { method: "setTaskStatus", id, status });
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  async createTask(specPath: string, options: CreateTaskOptions = {}): Promise<Task> {
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
    const { workspacePath = process.cwd(), backend = "markdown" } = options;

    // Initialize backends
    this.backends = [new MarkdownTaskBackend(workspacePath), new GitHubTaskBackend(workspacePath)];

    // Set current backend
    const selectedBackend = this.backends.find((b) => b.name === backend);
    if (!selectedBackend) {
      throw new Error(
        `Backend '${backend}' not found. Available backends: ${this.backends.map((b) => b.name).join(", ")}`
      );
    }
    this.currentBackend = selectedBackend;
  }

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    return this.currentBackend.listTasks(options);
  }

  async getTask(id: string): Promise<Task | null> {
    return this.currentBackend.getTask(id);
  }

  async getTaskStatus(id: string): Promise<string | null> {
    return this.currentBackend.getTaskStatus(id);
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    return this.currentBackend.setTaskStatus(id, status);
  }

  getWorkspacePath(): string {
    return this.currentBackend.getWorkspacePath();
  }

  async createTask(specPath: string, options: CreateTaskOptions = {}): Promise<Task> {
    return this.currentBackend.createTask(specPath, options);
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
}
