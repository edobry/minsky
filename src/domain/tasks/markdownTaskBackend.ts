/**
 * Markdown Task Backend Implementation
 * Uses functional patterns with clear separation of concerns
 */

import { join } from "path";
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
import { filterTasksByStatus } from "./task-filters";

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
  getTaskSpecRelativePath,
} from "./taskIO";

import { readdir } from "fs/promises";
import { findTaskIndexById } from "./markdown-backend-task-matching";
import { withGitStashCommitPush } from "./markdown-backend-git-ops";
import {
  buildTaskFromObject,
  buildTaskFromSpecPath,
  taskDataToTask,
  toQualifiedId,
  generateTaskSpecification,
} from "./markdown-backend-create-helpers";

/**
 * MarkdownTaskBackend implementation
 * Uses functional patterns to separate concerns
 */
export class MarkdownTaskBackend implements TaskBackend {
  name = "markdown";
  prefix = "md";
  private readonly workspacePath: string;
  private readonly tasksFilePath: string;
  private readonly tasksDirectory: string;
  private gitService: GitServiceInterface;

  constructor(config: TaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.tasksFilePath = getTasksFilePath(this.workspacePath);
    this.tasksDirectory = join(this.workspacePath, "process", "tasks");
    this.gitService = (config as any).gitService || createGitService();
  }

  // ---- Capability Discovery ----

  getCapabilities(): BackendCapabilities {
    return {
      supportsTaskCreation: true,
      supportsTaskUpdate: true,
      supportsTaskDeletion: true,
      supportsStatus: true,
      supportsSubtasks: false,
      supportsDependencies: false,
      supportsOriginalRequirements: false,
      supportsAiEnhancementTracking: false,
      supportsMetadataQuery: false,
      supportsFullTextSearch: true,
      supportsTransactions: false,
      supportsRealTimeSync: false,
    };
  }

  // ---- Required TaskBackend Interface Methods ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const result = await this.getTasksData();
    if (!result.success || !result.content) return [];
    const tasks = this.parseTasks(result.content);
    return filterTasksByStatus(tasks, options);
  }

  async getTask(id: string): Promise<Task | null> {
    const tasks = await this.listTasks({ all: true });
    return (
      tasks.find((task) => {
        if (task.id === id) return true;
        const taskLocal = task.id.includes("#") ? task.id.split("#").pop() : task.id;
        const searchLocal = id.includes("#") ? id.split("#").pop() : id;
        if (taskLocal === searchLocal) return true;
        if (!/^#/.test(id) && task.id === `#${id}`) return true;
        if (id.startsWith("#") && task.id === id.substring(1)) return true;
        return false;
      }) || null
    );
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

    const taskIndex = findTaskIndexById(tasks, id);
    log.debug("findIndex result", { searchId: id, taskIndex, found: taskIndex !== -1 });

    if (taskIndex === -1) throw new Error(`Task with id ${id} not found`);
    const task = tasks[taskIndex];
    if (!task) throw new Error(`Task with id ${id} not found`);

    const previousStatus = task.status;

    await withGitStashCommitPush({
      gitService: this.gitService,
      workdir: this.workspacePath,
      commitMessage: `chore(${id}): update task status ${previousStatus} → ${status}`,
      action: async () => {
        task.status = status as TaskStatus;
        const updatedContent = this.formatTasks(tasks);
        const saveResult = await this.saveTasksData(updatedContent);
        if (!saveResult.success) {
          throw new Error(`Failed to save tasks: ${saveResult.error?.message}`);
        }
      },
    });
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task> {
    log.debug("markdownTaskBackend updateTask called", { taskId, updates });

    const currentTask = await this.getTask(taskId);
    if (!currentTask) throw new Error(`Task not found: ${taskId}`);

    const result = await this.getTasksData();
    if (!result.success || !result.content) {
      throw new Error("Failed to read tasks data");
    }

    const tasks = this.parseTasks(result.content);
    const taskIndex = findTaskIndexById(tasks, taskId);
    if (taskIndex === -1) throw new Error(`Task not found: ${taskId}`);

    const updatedTask = {
      ...tasks[taskIndex]!,
      ...updates,
      id: tasks[taskIndex]!.id,
    };
    tasks[taskIndex] = updatedTask as any;

    const formattedContent = this.formatTasks(tasks);
    const writeResult = await this.saveTasksData(formattedContent);
    if (!writeResult.success) {
      throw new Error(`Failed to save tasks: ${writeResult.error?.message}`);
    }

    return {
      id: updatedTask.id,
      title: updatedTask.title || "",
      description: updatedTask.description || "",
      status: updatedTask.status || "",
      specPath: updatedTask.specPath || "",
    } as any;
  }

  async createTask(specPath: string | any, _options?: CreateTaskOptions): Promise<Task> {
    const existingTasksResult = await this.getTasksData();
    let existingTasks: TaskData[] = [];
    if (existingTasksResult.success && existingTasksResult.content) {
      existingTasks = this.parseTasks(existingTasksResult.content);
    }

    if (typeof specPath === "object" && specPath.title) {
      return this.createTaskFromObject(specPath, existingTasks);
    }

    return this.createTaskFromPath(specPath as string, existingTasks);
  }

  private async createTaskFromObject(
    spec: { title: string; description?: string; id?: string },
    existingTasks: TaskData[]
  ): Promise<Task> {
    const newTaskData = buildTaskFromObject(spec, existingTasks);
    existingTasks.push(newTaskData);

    const qualifiedId = toQualifiedId(newTaskData.id);
    const commitMsg = `chore(task): create ${qualifiedId} ${spec.title}`;

    await withGitStashCommitPush({
      gitService: this.gitService,
      workdir: this.workspacePath,
      commitMessage: commitMsg,
      action: async () => {
        const formattedContent = this.formatTasks(existingTasks);
        const writeResult = await this.saveTasksData(formattedContent);
        if (!writeResult.success) {
          throw new Error(`Failed to save tasks: ${writeResult.error?.message}`);
        }
      },
    });

    return taskDataToTask(newTaskData);
  }

  private async createTaskFromPath(specPath: string, existingTasks: TaskData[]): Promise<Task> {
    const newTaskData = await buildTaskFromSpecPath(
      specPath,
      existingTasks,
      this.workspacePath,
      (content) => this.parseTaskSpec(content),
      (path) => this.getTaskSpecData(path)
    );

    existingTasks.push(newTaskData);
    const commitMsg = `chore(task): create ${newTaskData.id} ${newTaskData.title}`;

    await withGitStashCommitPush({
      gitService: this.gitService,
      workdir: this.workspacePath,
      commitMessage: commitMsg,
      action: async () => {
        const updatedContent = this.formatTasks(existingTasks);
        const saveResult = await this.saveTasksData(updatedContent);
        if (!saveResult.success) {
          throw new Error(`Failed to save tasks: ${saveResult.error?.message}`);
        }
      },
    });

    return taskDataToTask(newTaskData);
  }

  async createTaskFromTitleAndDescription(
    title: string,
    description: string,
    options: CreateTaskOptions = {}
  ): Promise<Task> {
    const taskSpecContent = generateTaskSpecification(title, description);
    const fsModule = await import("fs/promises");
    const path = await import("path");

    const tempDir = path.join(this.workspacePath, ".tmp");
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const tempSpecPath = path.join(tempDir, `temp-task-${normalizedTitle}-${Date.now()}.md`);

    try {
      await fsModule.mkdir(tempDir, { recursive: true });
    } catch (_error) {
      // Directory already exists
    }

    try {
      await fsModule.writeFile(tempSpecPath, taskSpecContent, "utf-8");
      const task = await this.createTask(tempSpecPath, options);
      try {
        await fsModule.unlink(tempSpecPath);
      } catch (_error) {
        // Ignore cleanup errors
      }
      return task;
    } catch (error) {
      try {
        await fsModule.unlink(tempSpecPath);
      } catch (_cleanupError) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options: CreateTaskOptions = {}
  ): Promise<Task> {
    return await this.createTaskFromTitleAndDescription(title, spec, options);
  }

  async deleteTask(id: string, _options?: DeleteTaskOptions): Promise<boolean> {
    try {
      const tasksResult = await this.getTasksData();
      if (!tasksResult.success || !tasksResult.content) return false;

      const tasks = this.parseTasks(tasksResult.content);
      const taskToDelete = getTaskById(tasks, id);
      if (!taskToDelete) {
        log.debug(`Task ${id} not found for deletion`);
        return false;
      }

      // Delete from PostgreSQL tasks table (source of truth)
      await this.deleteTaskFromDatabase(id);

      const updatedTasks = tasks.filter((task) => task.id !== taskToDelete.id);
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
        await this.deleteSpecFile(taskToDelete.specPath);
      }

      return true;
    } catch (error) {
      log.error(`Failed to delete task ${id}:`, {
        error: getErrorMessage(error as any),
      });
      return false;
    }
  }

  private async deleteTaskFromDatabase(id: string): Promise<void> {
    try {
      const { PersistenceService } = await import("../persistence/service");
      const provider = PersistenceService.getProvider();
      if (provider.capabilities.sql) {
        const db = await provider.getDatabaseConnection?.();
        if (db) {
          const { tasksTable } = await import("../storage/schemas/task-embeddings");
          const { eq } = await import("drizzle-orm");
          const result = await db.delete(tasksTable).where(eq(tasksTable.id, id));
          log.debug(`Deleted task ${id} from database`, {
            rowCount: (result as any).rowCount,
          });
        }
      }
    } catch (dbError) {
      log.debug(`Could not delete task ${id} from database: ${getErrorMessage(dbError as any)}`);
    }
  }

  private async deleteSpecFile(specPath: string): Promise<void> {
    try {
      const fullSpecPath = specPath.startsWith("/") ? specPath : join(this.workspacePath, specPath);
      if (await this.fileExists(fullSpecPath)) {
        const { unlink } = await import("fs/promises");
        await unlink(fullSpecPath);
        log.debug(`Deleted spec file: ${fullSpecPath}`);
      }
    } catch (error) {
      log.debug(`Could not delete spec file: ${getErrorMessage(error as any)}`);
    }
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    return readTasksFile(this.tasksFilePath);
  }

  async getTaskSpecData(specPath: string): Promise<TaskReadOperationResult> {
    const pathStr = String(specPath || "");
    const fullPath = pathStr.startsWith("/") ? pathStr : join(this.workspacePath, pathStr);
    return readTaskSpecFile(fullPath);
  }

  // ---- Pure Operations ----

  parseTasks(content: string): TaskData[] {
    const tasks = parseTasksFromMarkdown(content);
    for (const task of tasks) {
      if (!task.specPath) {
        task.specPath = getTaskSpecRelativePath(task.id, task.title, this.workspacePath);
      }
    }
    return tasks;
  }

  formatTasks(tasks: TaskData[]): string {
    return formatTasksToMarkdown(tasks);
  }

  parseTaskSpec(content: string): TaskSpecData {
    const { data, content: markdownContent } = matter(content);
    const spec = parseTaskSpecFromMarkdown(markdownContent);
    return { ...spec, metadata: data || {} };
  }

  formatTaskSpec(spec: TaskSpecData): string {
    const markdownContent = formatTaskSpecToMarkdown(spec);
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

  isInTreeBackend(): boolean {
    return true;
  }
}

/**
 * Create a new MarkdownTaskBackend
 */
export function createMarkdownTaskBackend(config: TaskBackendConfig): TaskBackend {
  return new MarkdownTaskBackend(config);
}
