/**
 * Markdown Task Backend Implementation
 * Uses functional patterns with clear separation of concerns
 */

import { join } from "path";
import { log } from "../../utils/logger.js";
import { getErrorMessage } from "../../errors/index.js";
// @ts-ignore - matter is a third-party library
import matter from "gray-matter";

import type { 
  TaskBackend, 
  Task, 
  TaskListOptions, 
  CreateTaskOptions, 
  DeleteTaskOptions 
} from "../tasks.js";
import type {
  TaskData,
  TaskSpecData,
  TaskBackendConfig,
  TaskReadOperationResult,
  TaskWriteOperationResult,
} from "../../types/tasks/taskData.js";
import { TaskStatus } from "./taskConstants.js";

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

  // ---- Required TaskBackend Interface Methods ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const result = await this.getTasksData();
    if (!result.success || !result.content) {
      return [];
    }
    
    const tasks = this.parseTasks(result.content);
    
    if (options?.status) {
      return tasks.filter(task => task.status === options.status);
    }
    
    return tasks;
  }

  async getTask(id: string): Promise<Task | null> {
    const tasks = await this.listTasks();
    return tasks.find(task => task.id === id) || null;
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    const result = await this.getTasksData();
    if (!result.success || !result.content) {
      throw new Error("Failed to read tasks data");
    }
    
    const tasks = this.parseTasks(result.content);
    const taskIndex = tasks.findIndex(task => task.id === id);
    
    if (taskIndex === -1) {
      throw new Error(`Task with id ${id} not found`);
    }

    // Add type guard to ensure task exists
    const task = tasks[taskIndex];
    if (!task) {
      throw new Error(`Task with id ${id} not found`);
    }

    // Convert string status to TaskStatus type
    task.status = status as TaskStatus;

    const updatedContent = this.formatTasks(tasks);
    
    const saveResult = await this.saveTasksData(updatedContent);
    if (!saveResult.success) {
      throw new Error(`Failed to save tasks: ${saveResult.error?.message}`);
    }
  }

  async createTask(specPath: string, options?: CreateTaskOptions): Promise<Task> {
    // Read and parse the spec file
    const specResult = await this.getTaskSpecData(specPath);
    if (!specResult.success || !specResult.content) {
      throw new Error(`Failed to read spec file: ${specPath}`);
    }
    
    const spec = this.parseTaskSpec(specResult.content);
    
    // Get existing tasks to determine new ID
    const existingTasksResult = await this.getTasksData();
    if (!existingTasksResult.success || !existingTasksResult.content) {
      throw new Error("Failed to read existing tasks");
    }
    
    const existingTasks = this.parseTasks(existingTasksResult.content);
    const maxId = existingTasks.reduce((max, task) => {
      const id = parseInt(task.id.slice(1), 10);
      return id > max ? id : max;
    }, 0);
    
    const newId = `#${maxId + 1}`;
    
    const newTaskData: TaskData = {
      id: newId,
      title: spec.title,
      description: spec.description,
      status: "TODO" as TaskStatus,
      specPath
    };
    
    // Add the new task to the list
    existingTasks.push(newTaskData);
    const updatedContent = this.formatTasks(existingTasks);
    
    const saveResult = await this.saveTasksData(updatedContent);
    if (!saveResult.success) {
      throw new Error(`Failed to save tasks: ${saveResult.error?.message}`);
    }
    
    // Convert TaskData to Task for return
    const newTask: Task = {
      id: newTaskData.id,
      title: newTaskData.title,
      description: newTaskData.description,
      status: newTaskData.status,
      specPath: newTaskData.specPath
    };
    
    return newTask;
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
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
    if (spec.metadata && Object.keys(spec.metadata).length > 0) {
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
  return new MarkdownTaskBackend(config);
}
