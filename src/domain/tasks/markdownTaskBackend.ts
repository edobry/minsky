/**
 * Markdown Task Backend Implementation
 * Uses functional patterns with clear separation of concerns
 */

import { join } from "path";
import { log } from "../../utils/logger.js";
// @ts-ignore - matter is a third-party library
import matter from "gray-matter";

import type { TaskBackend } from "./taskBackend.js";
import type {TaskSpecData,
  TaskBackendConfig,
  TaskReadOperationResult,
  TaskWriteOperationResult,
} from "../../types/tasks/taskData.js";

import {
  parseTasksFromMarkdown,
  formatTasksToMarkdown,
  parseTaskSpecFromMarkdown,
  formatTaskSpecToMarkdown,
} from "./taskFunctions.js";

import {
  readTasksFile,
  writeTasksFile,
  readTaskSpecFile,
  writeTaskSpecFile,
  fileExists as checkFileExists,
  getTasksFilePath,
  getTaskSpecFilePath,
} from "./taskIO.js";

// Helper import to avoid promise conversion issues
import { readdir } from "fs/promises";

/**
 * MarkdownTaskBackend implementation
 * Uses functional patterns to separate concerns
 */
export class MarkdownTaskBackend implements TaskBackend {
  name = "markdown";
  private readonly workspacePath: string;
  private readonly tasksFilePath: string;
  private readonly tasksDirectory: string;

  constructor(__config: TaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.tasksFilePath = getTasksFilePath(this._workspacePath);
    this.tasksDirectory = join(this._workspacePath, "process", "tasks");
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    return readTasksFile(this.tasksFilePath);
  }

  async getTaskSpecData(__specPath: string): Promise<TaskReadOperationResult> {
    const fullPath = specPath.startsWith("/") ? specPath : join(this._workspacePath, _specPath);
    return readTaskSpecFile(fullPath);
  }

  // ---- Pure Operations ----

  parseTasks(__content: string): TaskData[] {
    const _tasks = parseTasksFromMarkdown(_content);

    // Process tasks to ensure they have spec paths if available
    // This is done synchronously to match the interface
    for (const task of tasks) {
      if (!task.specPath) {
        // Use a default spec path pattern
        const id = task.id.startsWith("#") ? task.id.slice(1) : task.id;
        const normalizedTitle = task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        task.specPath = join("process", "tasks", `${id}-${normalizedTitle}.md`);
      }
    }

    return tasks;
  }

  formatTasks(__tasks: TaskData[]): string {
    return formatTasksToMarkdown(_tasks);
  }

  parseTaskSpec(__content: string): TaskSpecData {
    // First use matter to extract frontmatter
    const { data, _content: markdownContent } = matter(_content);

    // Then parse the markdown content
    const _spec = parseTaskSpecFromMarkdown(markdownContent);

    // Combine with any metadata from frontmatter
    return {
      ...spec,
      _metadata: data || {},
    };
  }

  formatTaskSpec(__spec: TaskSpecData): string {
    // First format the markdown content
    const markdownContent = formatTaskSpecToMarkdown(_spec);

    // Then add any metadata as frontmatter
    if (spec.metadata && Object.keys(spec._metadata).length > 0) {
      return matter.stringify(_markdownContent, spec._metadata);
    }

    return markdownContent;
  }

  // ---- Side Effects ----

  async saveTasksData(__content: string): Promise<TaskWriteOperationResult> {
    return writeTasksFile(this.tasksFilePath, _content);
  }

  async saveTaskSpecData(__specPath: string, _content: string): Promise<TaskWriteOperationResult> {
    const fullPath = specPath.startsWith("/") ? specPath : join(this._workspacePath, _specPath);
    return writeTaskSpecFile(_fullPath, _content);
  }

  // ---- Helper Methods ----

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getTaskSpecPath(__taskId: string, _title: string): string {
    return getTaskSpecFilePath(__taskId, _title, this._workspacePath);
  }

  async fileExists(__path: string): Promise<boolean> {
    return checkFileExists(path);
  }

  // ---- Additional Helper Methods ----

  /**
   * Find task specification files for a given task ID
   * @param taskId Task ID (without # prefix)
   * @returns Promise resolving to array of matching file names
   */
  async findTaskSpecFiles(__taskId: string): Promise<string[]> {
    try {
      const files = await readdir(this.tasksDirectory);
      return files.filter((file) => file.startsWith(`${taskId}-`));
    } catch (_error) {
      log.error(`Failed to find task spec file for task #${taskId}`, {
        error: error instanceof Error ? error : String(error),
      });
      return [];
    }
  }
}

/**
 * Create a new MarkdownTaskBackend
 * @param config Backend configuration
 * @returns MarkdownTaskBackend instance
 */
export function createMarkdownTaskBackend(__config: TaskBackendConfig): TaskBackend {
  return new MarkdownTaskBackend(_config);
}
