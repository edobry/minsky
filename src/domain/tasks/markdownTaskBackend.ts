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
import { TaskStatus } from "./taskConstants";

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
  prefix = "md"; // Backend prefix for qualified IDs
  private readonly workspacePath: string;
  private readonly tasksFilePath: string;
  private readonly tasksDirectory: string;

  constructor(config: TaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.tasksFilePath = getTasksFilePath(this.workspacePath);
    this.tasksDirectory = join(this.workspacePath, "process", "tasks");
  }

  // ---- Capability Discovery ----

  getCapabilities(): BackendCapabilities {
    return {
      // Core operations - markdown backend supports basic CRUD
      supportsTaskCreation: true,
      supportsTaskUpdate: true,
      supportsTaskDeletion: true,

      // Essential metadata support
      supportsStatus: true, // Stored in tasks.md with checkboxes

      // Structural metadata - not yet implemented but possible
      supportsSubtasks: false, // TODO: Future enhancement for Task #238
      supportsDependencies: false, // TODO: Future enhancement for Task #239

      // Provenance metadata - not yet implemented
      supportsOriginalRequirements: false, // TODO: Could store in frontmatter
      supportsAiEnhancementTracking: false, // TODO: Could store in frontmatter

      // Query capabilities - limited in markdown format
      supportsMetadataQuery: false, // Would require parsing all files
      supportsFullTextSearch: true, // Can grep through markdown files

      // Update mechanism
      supportsTransactions: false, // File-based, no transaction support
      supportsRealTimeSync: false, // Manual file operations
    };
  }

  // ---- Required TaskBackend Interface Methods ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const result = await this.getTasksData();
    if (!result.success || !result.content) {
      return [];
    }

    const tasks = this.parseTasks(result.content);

    if (options?.status) {
      return tasks.filter((task) => task.status === options?.status);
    }

    return tasks;
  }

  async getTask(id: string): Promise<Task | null> {
    const tasks = await this.listTasks();
    return tasks.find((task) => task.id === id) || null;
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    log.debug("markdownTaskBackend setTaskStatus called", { id, status });

    const result = await this.getTasksData();
    if (!result.success || !result.content) {
      throw new Error("Failed to read tasks data");
    }

    const tasks = this.parseTasks(result.content);
    log.debug("stored task IDs", { taskIds: tasks.map((t) => t.id).slice(0, 5) });

    // Use the same sophisticated ID matching logic as getTask would use
    let taskIndex = -1;
    const localId = id.replace(/^md#/, "");

    // First try exact match with qualified ID
    taskIndex = tasks.findIndex((t) => t.id === id || t.id === `md#${localId}`);

    // If not found, try legacy format matching
    if (taskIndex === -1) {
      const numericId = parseInt(localId.replace(/^#/, ""), 10);
      if (!isNaN(numericId)) {
        taskIndex = tasks.findIndex((t) => {
          const taskNumericId = parseInt(t.id.replace(/^(md#|#)/, ""), 10);
          return !isNaN(taskNumericId) && taskNumericId === numericId;
        });
      }
    }

    log.debug("findIndex result", { searchId: id, taskIndex, found: taskIndex !== -1 });

    if (taskIndex === -1) {
      throw new Error(`Task with id ${id} not found`);
    }

    // Add type guard to ensure task exists
    const task = tasks[taskIndex];
    if (!task) {
      throw new Error(`Task with id ${id} not found`);
    }

    // Store previous status for commit message
    const previousStatus = task.status;

    // Set up git operations for stash/commit/push flow
    const gitService = createGitService();
    let hasStashedChanges = false;

    try {
      // Check for uncommitted changes and stash them
      const workdir = this.getWorkspacePath();
      const hasUncommittedChanges = await gitService.hasUncommittedChanges(workdir);
      if (hasUncommittedChanges) {
        log.cli("📦 Stashing uncommitted changes...");
        log.debug("Stashing uncommitted changes for task status update", { workdir });

        const stashResult = await gitService.stashChanges(workdir);
        hasStashedChanges = stashResult.stashed;

        if (hasStashedChanges) {
          log.cli("✅ Changes stashed successfully");
        }
        log.debug("Changes stashed", { stashed: hasStashedChanges });
      }
    } catch (statusError) {
      log.debug("Could not check/stash git status before task status update", {
        error: statusError,
      });
    }

    try {
      // Convert string status to TaskStatus type
      task.status = status as TaskStatus;

      const updatedContent = this.formatTasks(tasks);

      const saveResult = await this.saveTasksData(updatedContent);
      if (!saveResult.success) {
        throw new Error(`Failed to save tasks: ${saveResult.error?.message}`);
      }

      // Commit and push the changes
      try {
        const workdir = this.getWorkspacePath();

        // Check if there are changes to commit
        const hasChangesToCommit = await gitService.hasUncommittedChanges(workdir);
        if (hasChangesToCommit) {
          log.cli("💾 Committing task status change...");

          // Stage all changes
          await gitService.execInRepository(workdir, "git add -A");

          // Commit with conventional commit message
          const commitMessage = `chore(${id}): update task status ${previousStatus} → ${status}`;
          await gitService.execInRepository(workdir, `git commit -m "${commitMessage}"`);

          log.cli("📤 Pushing changes...");

          // Push changes
          await gitService.execInRepository(workdir, "git push");

          log.cli("✅ Changes committed and pushed successfully");
          log.debug("Task status change committed and pushed", { taskId: id, status });
        }
      } catch (commitError) {
        log.warn("Failed to commit task status change", {
          taskId: id,
          error: commitError,
        });
        log.cli(`⚠️ Warning: Failed to commit changes: ${commitError}`);
      }
    } finally {
      // Restore stashed changes if we stashed them
      if (hasStashedChanges) {
        try {
          log.cli("📂 Restoring stashed changes...");
          log.debug("Restoring stashed changes after task status update");

          const workdir = this.getWorkspacePath();
          await gitService.popStash(workdir);

          log.cli("✅ Stashed changes restored successfully");
          log.debug("Stashed changes restored");
        } catch (popError) {
          log.warn("Failed to restore stashed changes", {
            error: popError,
          });
          log.cli(`⚠️ Warning: Failed to restore stashed changes: ${popError}`);
        }
      }
    }
  }

  async createTask(specPath: string, _options?: CreateTaskOptions): Promise<Task> {
    // Read and parse the spec file
    const specResult = await this.getTaskSpecData(specPath);
    if (!specResult.success || !specResult.content) {
      throw new Error(`Failed to read spec file: ${specPath}`);
    }

    const spec = this.parseTaskSpec(specResult.content);

    // Get existing tasks from central file to determine new ID
    const existingTasksResult = await this.getTasksData();

    // Handle empty or missing central tasks file gracefully
    let existingTasks: TaskData[] = [];
    if (existingTasksResult.success && existingTasksResult.content) {
      existingTasks = this.parseTasks(existingTasksResult.content);
    }
    const maxId = existingTasks.reduce((max, task) => {
      // Use the new utility to extract numeric value from any format
      const id = getTaskIdNumber(task.id);
      return id !== null && id > max ? id : max;
    }, 0);

    // Generate qualified backend ID for multi-backend storage (e.g., "md#285")
    const newId = `md#${maxId + 1}`; // Qualified format for storage

    // Generate proper spec path and move the temporary file
    // Use display format for spec path generation since filenames use display format
    const displayId = formatTaskIdForDisplay(newId);
    const properSpecPath = getTaskSpecRelativePath(displayId, spec.title, this.workspacePath);
    const fullProperPath = join(this.workspacePath, properSpecPath);

    // Ensure the tasks directory exists
    const tasksDir = dirname(fullProperPath);
    try {
      await fs.mkdir(tasksDir, { recursive: true });
    } catch (error) {
      // Directory already exists, continue
    }

    // Move the temporary file to the proper location
    try {
      // Read the spec file content
      const specContent = await fs.readFile(specPath, "utf-8");
      // Write to the proper location
      await fs.writeFile(fullProperPath, specContent, "utf-8");
      // Delete the temporary file
      try {
        await fs.unlink(specPath);
      } catch (error) {
        // Ignore cleanup errors
      }
    } catch (error) {
      throw new Error(
        `Failed to move spec file from ${specPath} to ${properSpecPath}: ${getErrorMessage(error)}`
      );
    }

    const newTaskData: TaskData = {
      id: newId,
      title: spec.title,
      description: spec.description,
      status: "TODO" as TaskStatus,
      specPath: properSpecPath,
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
      specPath: newTaskData.specPath,
    };

    return newTask;
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
  ): Promise<Task> {
    // Generate a task specification file content
    const taskSpecContent = this.generateTaskSpecification(title, description);

    // Create a temporary file path for the spec
    const fs = await import("fs/promises");
    const path = await import("path");
    const os = await import("os");

    const tempDir = os.tmpdir();
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const tempSpecPath = path.join(tempDir, `temp-task-${normalizedTitle}-${Date.now()}.md`);

    try {
      // Write the spec content to the temporary file
      await fs.writeFile(tempSpecPath, taskSpecContent, "utf-8");

      // Use the existing createTask method
      const task = await this.createTask(tempSpecPath, options);

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

## Context

${description}

## Requirements

## Solution

## Notes
`;
  }

  async deleteTask(id: string, _options?: DeleteTaskOptions): Promise<boolean> {
    try {
      // Get all tasks first
      const tasksResult = await this.getTasksData();
      if (!tasksResult.success || !tasksResult.content) {
        return false;
      }

            // Parse tasks and find the one to delete using existing utility
      const tasks = this.parseTasks(tasksResult.content);
      const taskToDelete = getTaskById(tasks, id);

      if (!taskToDelete) {
        log.debug(`Task ${id} not found for deletion`);
        return false;
      }

      // Remove the task from the array
      const updatedTasks = tasks.filter((task) => task.id !== taskToDelete.id);

      // Save the updated tasks
      const updatedContent = this.formatTasks(updatedTasks);
      const saveResult = await this.saveTasksData(updatedContent);

      if (!saveResult.success) {
        log.error(`Failed to save tasks after deleting ${id}:`, {
          error: saveResult.error?.message || "Unknown error",
          filePath: this.tasksFilePath,
        });
        return false;
      }

      // Try to delete the spec file if it exists
      if (taskToDelete.specPath) {
        try {
          const fullSpecPath = taskToDelete.specPath.startsWith("/")
            ? taskToDelete.specPath
            : join(this.workspacePath, taskToDelete.specPath);

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
    // Ensure specPath is a string
    const pathStr = String(specPath || "");
    const fullPath = pathStr.startsWith("/") ? pathStr : join(this.workspacePath, pathStr);
    return readTaskSpecFile(fullPath);
  }

  // ---- Pure Operations ----

  parseTasks(content: string): TaskData[] {
    const tasks = parseTasksFromMarkdown(content);

    // Process tasks to ensure they have spec paths if available
    // This is done synchronously to match the interface
    for (const task of tasks) {
      if (!task.specPath) {
        // Use the context-aware spec path function
        task.specPath = getTaskSpecRelativePath(task.id, task.title, this.workspacePath);
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
      return matter.stringify(markdownContent, spec.metadata);
    }

    return markdownContent;
  }

  // ---- Side Effects ----

  async saveTasksData(content: string): Promise<TaskWriteOperationResult> {
    return writeTasksFile(this.tasksFilePath, content);
  }

  async saveTaskSpecData(specPath: string, content: string): Promise<TaskWriteOperationResult> {
    const fullPath = specPath.startsWith("/") ? specPath : join(this.workspacePath, specPath);
    return writeTaskSpecFile(fullPath, content);
  }

  // ---- Helper Methods ----

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getTaskSpecPath(taskId: string, title: string): string {
    return getTaskSpecRelativePath(taskId, title, this.workspacePath);
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
      return files.filter((file) => file.startsWith(`${taskId}-`));
    } catch (error) {
      log.error(`Failed to find task spec file for task #${taskId}`, {
        error: getErrorMessage(error as any),
      });
      return [];
    }
  }

  /**
   * Get backend capabilities
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
