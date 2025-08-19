/**
 * Markdown Task Backend Implementation
 * Uses functional patterns with clear separation of concerns
 */

import { join, dirname } from "path";
import { promises as fs } from "fs";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
// @ts-ignore - matter is a third-party library
import matter from "gray-matter";
import { createGitService, type GitServiceInterface } from "../git";

import type {
  TaskBackend,
  Task,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
} from "../tasks";
import { getTaskById } from "./taskFunctions";
import type { BackendCapabilities } from "./types";
import type {
  TaskData,
  TaskSpecData,
  TaskBackendConfig,
  TaskReadOperationResult,
  TaskWriteOperationResult,
} from "../../types/tasks/taskData";
import { TaskStatus, TASK_STATUS } from "./taskConstants";

import {
  parseTasksFromMarkdown,
  formatTasksToMarkdown,
  parseTaskSpecFromMarkdown,
  formatTaskSpecToMarkdown,
} from "./taskFunctions";

import {
  readTasksFile,
  writeTasksFile,
  readTaskSpecFile,
  writeTaskSpecFile,
  fileExists as checkFileExists,
  getTasksFilePath,
  getTaskSpecFilePath,
  getTaskSpecRelativePath,
} from "./taskIO";

import {
  normalizeTaskIdForStorage,
  formatTaskIdForDisplay,
  getTaskIdNumber,
} from "./task-id-utils";

// Helper import to avoid promise conversion issues
import { readdir } from "fs/promises";

/**
 * MarkdownTaskBackend implementation
 * Uses functional patterns to separate concerns
 */
export class MarkdownTaskBackend implements TaskBackend {
  name = "markdown";
  private readonly workspacePath: string;
  private readonly filePath: string;

  constructor(config: TaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.filePath = path.join(this.workspacePath, "process", "tasks.md");
  }

  // ---- User-Facing Operations ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const tasks = await this.parseTasks();

    // Apply filters
    let filtered = tasks;
    if (options?.status && options.status !== "all") {
      filtered = filtered.filter((task) => task.status === options.status);
    }
    if (options?.backend) {
      filtered = filtered.filter((task) => task.backend === options.backend);
    }

    return filtered;
  }

  async getTask(id: string): Promise<Task | null> {
    const tasks = await this.parseTasks();
    return tasks.find((task) => task.id === id) || null;
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    const tasks = await this.parseTasks();
    const taskIndex = tasks.findIndex((task) => task.id === id);

    if (taskIndex === -1) {
      throw new Error(`Task ${id} not found`);
    }

    tasks[taskIndex].status = status;
    await this.saveTasks(tasks);
  }

  async createTaskFromTitleAndDescription(
    title: string,
    description: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    const tasks = await this.parseTasks();

    // Generate next ID
    const maxId = tasks.reduce((max, task) => {
      const numId = parseInt(task.id.replace(/^(md)?#/, ""), 10);
      return numId > max ? numId : max;
    }, 0);

    const newId = `md#${maxId + 1}`;

    // Create spec file
    const specPath = this.getTaskSpecPath(newId, title);
    const specContent = this.generateTaskSpecContent(title, description);

    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.writeFile(specPath, specContent);

    // Create task entry
    const newTask: Task = {
      id: newId,
      title,
      description,
      status: "TODO",
      specPath,
      backend: "markdown",
    };

    tasks.push(newTask);
    await this.saveTasks(tasks);

    return newTask;
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    const tasks = await this.parseTasks();
    const taskIndex = tasks.findIndex((task) => task.id === id);

    if (taskIndex === -1) {
      return false;
    }

    const task = tasks[taskIndex];
    tasks.splice(taskIndex, 1);

    // Delete spec file if it exists
    if (task.specPath && (await this.fileExists(task.specPath))) {
      await fs.unlink(task.specPath);
    }

    await this.saveTasks(tasks);
    return true;
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getCapabilities(): BackendCapabilities {
    return {
      canCreate: true,
      canUpdate: true,
      canDelete: true,
      canList: true,
      supportsMetadata: false,
      supportsSearch: false,
    };
  }

  // ---- Optional Metadata Methods ----

  async getTaskMetadata(id: string): Promise<TaskMetadata | null> {
    const task = await this.getTask(id);
    if (!task || !task.specPath) {
      return null;
    }

    try {
      const content = await fs.readFile(task.specPath, "utf-8");
      return {
        id: task.id,
        title: task.title,
        spec: content,
        status: task.status,
        backend: task.backend,
        createdAt: undefined, // Not available in markdown format
        updatedAt: undefined,
      };
    } catch {
      return null;
    }
  }

  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    // Update task entry
    const tasks = await this.parseTasks();
    const taskIndex = tasks.findIndex((task) => task.id === id);

    if (taskIndex === -1) {
      throw new Error(`Task ${id} not found`);
    }

    tasks[taskIndex].title = metadata.title;
    tasks[taskIndex].status = metadata.status;

    // Update spec file
    if (metadata.spec && tasks[taskIndex].specPath) {
      await fs.writeFile(tasks[taskIndex].specPath, metadata.spec);
    }

    await this.saveTasks(tasks);
  }

  // ---- Internal Methods ----

  private async parseTasks(): Promise<Task[]> {
    try {
      const content = String(await fs.readFile(this.filePath, "utf-8"));
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

        const parsed = TASK_PARSING_UTILS.parseTaskLine(line);
        if (!parsed) continue;

        const { checkbox, title, id } = parsed;
        if (!title || !id || !/^(#\d+|[a-z-]+#\d+)$/.test(id)) continue;

        const status = Object.keys(TASK_STATUS_CHECKBOX).find(
          (key) => TASK_STATUS_CHECKBOX[key] === checkbox
        );
        if (!status) continue;

        const specPath = await this.validateSpecPath(id, title);

        // Collect description from indented lines
        let description: string | undefined = undefined;
        const descriptionLines: string[] = [];

        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j] ?? "";
          if (nextLine.trim() === "") {
            if (descriptionLines.length > 0) break;
            continue;
          }
          if (!nextLine.startsWith("  ") && !nextLine.startsWith("\t")) break;

          const content = nextLine.replace(/^[\s\t]+/, "");
          if (content.trim()) {
            descriptionLines.push(content);
          }
        }

        if (descriptionLines.length > 0) {
          description = descriptionLines.join(" ").trim();
        }

        tasks.push({
          id,
          title,
          description: description || "",
          status,
          specPath,
          backend: "markdown",
        });
      }

      return tasks;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async saveTasks(tasks: Task[]): Promise<void> {
    const content = this.formatTasks(tasks);
    await fs.writeFile(this.filePath, content);
  }

  private formatTasks(tasks: Task[]): string {
    if (tasks.length === 0) {
      return "# Tasks\n\n(No tasks yet)\n";
    }

    const lines = ["# Tasks", ""];

    for (const task of tasks) {
      const checkbox = TASK_STATUS_CHECKBOX[task.status] || "☐";
      lines.push(`${checkbox} ${task.title} ${task.id}`);

      if (task.description) {
        const descLines = task.description.split("\n");
        for (const descLine of descLines) {
          if (descLine.trim()) {
            lines.push(`  ${descLine.trim()}`);
          }
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private async validateSpecPath(taskId: string, title: string): Promise<string | undefined> {
    const specPath = this.getTaskSpecPath(taskId, title);
    if (await this.fileExists(specPath)) {
      return specPath;
    }
    return undefined;
  }

  private getTaskSpecPath(taskId: string, title: string): string {
    const cleanId = taskId.replace(/^(md)?#/, "");
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .substring(0, 50);

    return path.join(this.workspacePath, "process", "tasks", `${cleanId}-${slug}.md`);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private generateTaskSpecContent(title: string, description: string): string {
    return `# ${title}

## Context

${description}

## Requirements

(Requirements to be added)

## Implementation

(Implementation details to be added)
`;
  }
}

/**
 * Create a new MarkdownTaskBackend
 * @param config Backend configuration
 * @returns MarkdownTaskBackend instance
 */
export function createMarkdownTaskBackend(config: TaskBackendConfig): TaskBackend {
  return new MarkdownTaskBackend(config);
}
