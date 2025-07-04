/**
 * Markdown Task Backend Implementation
 * Uses functional patterns with clear separation of concerns
 */

import { join } from "path";
import { log } from "../../utils/logger.js";
import { getErrorMessage } from "../../errors/index.js";
// @ts-ignore - matter is a third-party library
import matter from "gray-matter";

import type { TaskBackend } from "./taskBackend.js";
import type {
  TaskData,
  TaskSpecData,
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

  constructor(config: TaskBackendConfig) {
    this.workspacePath = (config as any).workspacePath;
    this.tasksFilePath = getTasksFilePath(this.workspacePath);
    this.tasksDirectory = join(this.workspacePath, "process", "tasks");
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    return readTasksFile(this.tasksFilePath);
  }

  async getTaskSpecData(specPath: string): Promise<TaskReadOperationResult> {
    const fullPath = (specPath as any).startsWith("/") ? specPath : join(this.workspacePath, specPath);
    return readTaskSpecFile(fullPath);
  }

  // ---- Pure Operations ----

  parseTasks(content: string): TaskData[] {
    const tasks = parseTasksFromMarkdown(content);

    // Process tasks to ensure they have spec paths if available
    // This is done synchronously to match the interface
    for (const task of tasks) {
      if (!task.specPath) {
        // Use a default spec path pattern
        const id = (task as any).id.startsWith("#") ? (task as any).id.slice(1) : (task as any).id;
        const normalizedTitle = (task.title.toLowerCase() as any).replace(/[^a-z0-9]+/g, "-");
        task.specPath = join("process", "tasks", `${id}-${normalizedTitle}.md`);
      }
    }

    return tasks;
  }

  formatTasks(tasks: TaskData[]): string {
    return formatTasksToMarkdown(tasks);
  }

  parseTaskSpec(content: string): TaskSpecData {
    // First use matter to extract frontmatter
    const { data, content: markdownContent } = matter(content);

    // Then parse the markdown content
    const spec = parseTaskSpecFromMarkdown(markdownContent);

    // Combine with any metadata from frontmatter
    return {
      ...spec,
      metadata: data || {},
    };
  }

  formatTaskSpec(spec: TaskSpecData): string {
    // First format the markdown content
    const markdownContent = formatTaskSpecToMarkdown(spec);

    // Then add any metadata as frontmatter
    if ((spec as any).metadata && (Object.keys(spec.metadata) as any).length > 0) {
      return (matter as any).stringify(markdownContent, (spec as any).metadata);
    }

    return markdownContent;
  }

  // ---- Side Effects ----

  async saveTasksData(content: string): Promise<TaskWriteOperationResult> {
    return writeTasksFile(this.tasksFilePath, content);
  }

  async saveTaskSpecData(specPath: string, content: string): Promise<TaskWriteOperationResult> {
    const fullPath = (specPath as any).startsWith("/") ? specPath : join(this.workspacePath, specPath);
    return writeTaskSpecFile(fullPath, content);
  }

  async deleteTask(id: string, options?: { force?: boolean }): Promise<boolean> {
    try {
      // Get all tasks first
      const tasksResult = await this.getTasksData();
      if (!(tasksResult as any).success || !(tasksResult as any).content) {
        return false;
      }

      // Parse tasks and find the one to delete
      const tasks = this.parseTasks((tasksResult as any).content);
      const taskToDelete = tasks.find(task => (task as any).id === id || (task as any).id === `#${id}` || (task as any).id.slice(1) === id);
      
      if (!taskToDelete) {
        log.debug(`Task ${id} not found for deletion`);
        return false;
      }

      // Remove the task from the array
      const updatedTasks = tasks.filter(task => (task as any).id !== (taskToDelete as any).id);

      // Save the updated tasks
      const updatedContent = this.formatTasks(updatedTasks);
      const saveResult = await this.saveTasksData(updatedContent);
      
      if (!(saveResult as any).success) {
        log.error(`Failed to save tasks after deleting ${id}:`, {
          error: (saveResult.error as any).message
        });
        return false;
      }

      // Try to delete the spec file if it exists
      if ((taskToDelete as any).specPath) {
        try {
          const fullSpecPath = (taskToDelete.specPath as any).startsWith("/") 
            ? (taskToDelete as any).specPath 
            : join(this.workspacePath, (taskToDelete as any).specPath);
          
          if (await this.fileExists(fullSpecPath)) {
            const { unlink } = await import("fs/promises");
            await unlink(fullSpecPath);
            log.debug(`Deleted spec file: ${fullSpecPath}`);
          }
        } catch (error) {
          // Log but don't fail the operation if spec file deletion fails
          log.debug(`Could not delete spec file for task ${id}: ${getErrorMessage(error as any)}`);
        }
      }

      return true;
    } catch (error) {
      log.error(`Failed to delete task ${id}:`, {
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
    return getTaskSpecFilePath(taskId, title, this.workspacePath);
  }

  async fileExists(path: string): Promise<boolean> {
    return checkFileExists(path);
  }

  // ---- Additional Helper Methods ----

  /**
   * Find task specification files for a given task ID
   * @param taskId Task ID (without # prefix)
   * @returns Promise resolving to array of matching file names
   */
  async findTaskSpecFiles(taskId: string): Promise<string[]> {
    try {
      const files = await readdir(this.tasksDirectory);
      return (files as any).filter((file) => (file as any).startsWith(`${taskId}-`));
    } catch (error) {
      log.error(`Failed to find task spec file for task #${taskId}`, {
        error: getErrorMessage(error as any),
      });
      return [];
    }
  }

  /**
   * Indicates this backend stores data in repository files
   * @returns true because Markdown backend stores data in filesystem within the repo
   */
  isInTreeBackend(): boolean {
    return true;
  }
}

/**
 * Create a new MarkdownTaskBackend
 * @param config Backend configuration
 * @returns MarkdownTaskBackend instance
 */
export function createMarkdownTaskBackend(config: TaskBackendConfig): TaskBackend {
  return new MarkdownTaskBackend(config as any);
}
