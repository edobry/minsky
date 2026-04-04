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
import { TaskStatus } from "./taskConstants";
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
import { taskIdMatches, findTaskIndexById } from "./markdown-backend-task-matching";
import { withGitStashCommitPush } from "./markdown-backend-git-ops";
import {
  buildTaskFromObject,
  buildTaskFromSpecPath,
  taskDataToTask,
  toQualifiedId,
  generateTaskSpecification,
} from "./markdown-backend-create-helpers";
import { deleteTaskFromDatabase, deleteSpecFile } from "./markdown-backend-delete-helpers";

/**
 * MarkdownTaskBackend implementation
 */
export class MarkdownTaskBackend implements TaskBackend {
  name = "markdown";
  prefix = "md";
  private readonly workspacePath: string;
  private readonly tasksFilePath: string;
  private readonly tasksDirectory: string;
  // Allow tests to override this via (backend as any).gitService
  private gitService: GitServiceInterface;

  constructor(config: TaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.tasksFilePath = getTasksFilePath(this.workspacePath);
    this.tasksDirectory = join(this.workspacePath, "process", "tasks");
    this.gitService = config.gitService || createGitService();
  }

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

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const result = await this.getTasksData();
    if (!result.success || !result.content) return [];
    return filterTasksByStatus(this.parseTasks(result.content), options);
  }

  async getTask(id: string): Promise<Task | null> {
    const tasks = await this.listTasks({ all: true });
    return tasks.find((t) => taskIdMatches(t.id, id)) || null;
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    return (await this.getTask(id))?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    log.debug("markdownTaskBackend setTaskStatus called", { id, status });
    const tasks = await this.readAndParseTasks();

    const taskIndex = findTaskIndexById(tasks, id);
    if (taskIndex === -1) throw new Error(`Task with id ${id} not found`);
    const task = tasks[taskIndex]!;
    const previousStatus = task.status;

    await withGitStashCommitPush({
      gitService: this.gitService,
      workdir: this.workspacePath,
      commitMessage: `chore(${id}): update task status ${previousStatus} → ${status}`,
      action: async () => {
        task.status = status as TaskStatus;
        await this.saveTasksOrThrow(tasks);
      },
    });
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task> {
    log.debug("markdownTaskBackend updateTask called", { taskId, updates });
    if (!(await this.getTask(taskId))) throw new Error(`Task not found: ${taskId}`);

    const tasks = await this.readAndParseTasks();
    const taskIndex = findTaskIndexById(tasks, taskId);
    if (taskIndex === -1) throw new Error(`Task not found: ${taskId}`);

    const updatedTask = { ...tasks[taskIndex]!, ...updates, id: tasks[taskIndex]!.id };
    tasks[taskIndex] = updatedTask as TaskData;

    await this.saveTasksOrThrow(tasks);

    return {
      id: updatedTask.id,
      title: updatedTask.title || "",
      description: updatedTask.description || "",
      status: updatedTask.status || "",
      specPath: updatedTask.specPath || "",
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- markdown parsing returns mixed types
  async createTask(specPath: string | any, _options?: CreateTaskOptions): Promise<Task> {
    const existingTasks = await this.readExistingTasks();

    if (typeof specPath === "object" && specPath.title) {
      return this.createTaskFromObject(specPath, existingTasks);
    }
    return this.createTaskFromPath(specPath as string, existingTasks);
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
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const tempSpecPath = path.join(tempDir, `temp-task-${slug}-${Date.now()}.md`);

    try {
      await fsModule.mkdir(tempDir, { recursive: true });
    } catch (_e) {
      /* exists */
    }

    try {
      await fsModule.writeFile(tempSpecPath, taskSpecContent, "utf-8");
      const task = await this.createTask(tempSpecPath, options);
      try {
        await fsModule.unlink(tempSpecPath);
      } catch (_e) {
        /* cleanup */
      }
      return task;
    } catch (error) {
      try {
        await fsModule.unlink(tempSpecPath);
      } catch (_e) {
        /* cleanup */
      }
      throw error;
    }
  }

  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options: CreateTaskOptions = {}
  ): Promise<Task> {
    return this.createTaskFromTitleAndDescription(title, spec, options);
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

      await deleteTaskFromDatabase(id);

      const updatedTasks = tasks.filter((t) => t.id !== taskToDelete.id);
      const saveResult = await this.saveTasksData(this.formatTasks(updatedTasks));
      if (!saveResult.success) {
        log.error(`Failed to save tasks after deleting ${id}:`, {
          error: saveResult.error?.message || "Unknown error",
          filePath: this.tasksFilePath,
        });
        return false;
      }

      if (taskToDelete.specPath) {
        await deleteSpecFile(taskToDelete.specPath, this.workspacePath);
      }
      return true;
    } catch (error) {
      log.error(`Failed to delete task ${id}:`, {
        error: getErrorMessage(error),
      });
      return false;
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
    return { ...parseTaskSpecFromMarkdown(markdownContent), metadata: data || {} };
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
      return files.filter((f) => f.startsWith(`${taskId}-`));
    } catch (error) {
      log.error(`Failed to find task spec file for task #${taskId}`, {
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  isInTreeBackend(): boolean {
    return true;
  }

  // ---- Private helpers ----

  private async readAndParseTasks(): Promise<TaskData[]> {
    const result = await this.getTasksData();
    if (!result.success || !result.content) throw new Error("Failed to read tasks data");
    return this.parseTasks(result.content);
  }

  private async readExistingTasks(): Promise<TaskData[]> {
    const result = await this.getTasksData();
    if (result.success && result.content) return this.parseTasks(result.content);
    return [];
  }

  private async saveTasksOrThrow(tasks: TaskData[]): Promise<void> {
    const result = await this.saveTasksData(this.formatTasks(tasks));
    if (!result.success) throw new Error(`Failed to save tasks: ${result.error?.message}`);
  }

  private async createTaskFromObject(
    spec: { title: string; description?: string; id?: string },
    existingTasks: TaskData[]
  ): Promise<Task> {
    const newTaskData = buildTaskFromObject(spec, existingTasks);
    existingTasks.push(newTaskData);

    await withGitStashCommitPush({
      gitService: this.gitService,
      workdir: this.workspacePath,
      commitMessage: `chore(task): create ${toQualifiedId(newTaskData.id)} ${spec.title}`,
      action: () => this.saveTasksOrThrow(existingTasks),
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

    await withGitStashCommitPush({
      gitService: this.gitService,
      workdir: this.workspacePath,
      commitMessage: `chore(task): create ${newTaskData.id} ${newTaskData.title}`,
      action: () => this.saveTasksOrThrow(existingTasks),
    });

    return taskDataToTask(newTaskData);
  }
}

/**
 * Create a new MarkdownTaskBackend
 */
export function createMarkdownTaskBackend(config: TaskBackendConfig): TaskBackend {
  return new MarkdownTaskBackend(config);
}
