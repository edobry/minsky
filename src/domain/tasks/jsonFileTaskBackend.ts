import { promises as fs } from "fs";
import { join, dirname } from "path";
import type {
  Task,
  TaskBackend,
  TaskBackendConfig,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
  BackendCapabilities,
  TaskMetadata,
} from "./types";
import type { TaskData } from "../../types/tasks/taskData";

import { createJsonFileStorage } from "../storage/json-file-storage";
import type { DatabaseStorage } from "../storage/database-storage";
import { validateTaskState, type TaskState } from "../../schemas/storage";
import type { TaskSpec } from "./taskIO";
import { log } from "../../utils/logger";
import { readFile, writeFile, mkdir, access, unlink } from "fs/promises";
import { getErrorMessage } from "../../errors/index";
import { TASK_STATUS, TaskStatus } from "./taskConstants";
import { getTaskSpecRelativePath } from "./taskIO";
import { validateQualifiedTaskId } from "./task-id-utils";
import { getNextTaskId } from "./taskFunctions";
import { get as getConfig, has as hasConfig } from "../configuration";
import type { PersistenceProvider } from "../persistence/types";

// TaskState is now imported from schemas/storage

/**
 * JsonFileTaskBackend implementation using simple JSON file storage
 */
export class JsonFileTaskBackend implements TaskBackend {
  name = "json-file";
  private workspacePath: string;
  private tasksFilePath: string;
  private persistenceProvider?: PersistenceProvider;

  constructor(config: TaskBackendConfig & { persistenceProvider?: PersistenceProvider }) {
    this.workspacePath = config.workspacePath;
    this.tasksFilePath = join(this.workspacePath, "process", "tasks", "tasks.json");
    this.persistenceProvider = config.persistenceProvider;
  }

  // ---- User-Facing Operations ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const tasks = await this.getAllTasks();

    let filtered = tasks;

    // Apply status filtering (includes default exclusion of DONE/CLOSED)
    if (options?.status && options.status !== "all") {
      filtered = filtered.filter((task) => task.status === options.status);
    } else if (!options?.all) {
      // Default: exclude DONE and CLOSED tasks unless --all is specified
      filtered = filtered.filter((task) => task.status !== "DONE" && task.status !== "CLOSED");
    }

    if (options?.backend) {
      filtered = filtered.filter((task) => task.backend === options.backend);
    }

    return filtered;
  }

  async getTask(id: string): Promise<Task | null> {
    const tasks = await this.getAllTasks();
    return tasks.find((task) => task.id === id) || null;
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    const tasks = await this.getAllTasks();
    const taskIndex = tasks.findIndex((task) => task.id === id);

    if (taskIndex === -1) {
      throw new Error(`Task ${id} not found`);
    }

    tasks[taskIndex].status = status;
    await this.saveAllTasks(tasks);
  }

  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    // Generate new ID
    const tasks = await this.getAllTasks();
    const maxId = tasks.reduce((max, task) => {
      const match = task.id.match(/^json-file#(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);

    const newId = `json-file#${maxId + 1}`;

    // Create spec file
    const specPath = this.getTaskSpecPath(newId, title);
    // Write the spec content directly instead of generating a template
    await fs.mkdir(dirname(specPath), { recursive: true });
    await fs.writeFile(specPath, spec);

    // Create task data
    const newTask: Task = {
      id: newId,
      title,
      specPath,
      status: TASK_STATUS.TODO,
      backend: this.name,
    };

    // Add to tasks list
    const existingTasks = await this.getAllTasks();
    await this.saveAllTasks([...existingTasks, newTask]);

    return newTask;
  }

  /**
   * Generate a task specification file content from title and description
   * @param title Title of the task
   * @param description Description of the task
   * @returns The generated task specification content
   */
  private generateTaskSpecification(title: string, description: string): string {
    return `# ${title}

## Status

BACKLOG

## Priority

MEDIUM

## Description

${description}

## Requirements

[To be filled in]

## Success Criteria

[To be defined]
`;
  }

  /**
   * Creates a new task from a markdown specification file
   * Spec parser is provided as parameter to allow for dependency injection
   */
  async createTaskFromSpecFile(
    specPath: string,
    specParser: (content: string) => TaskSpec
  ): Promise<TaskData> {
    // Validate the input
    if (!specPath || !specParser) {
      throw new Error("Spec path and parser are required");
    }

    const specDataResult = await this.getTaskSpecData(specPath);
    if (!specDataResult.success) {
      throw new Error(`Failed to load spec file: ${specDataResult.error}`);
    }
    const spec = this.parseTaskSpec(specDataResult.content || "");

    // Use the spec ID if available, otherwise generate a sequential ID
    let taskId: string;
    if (spec.id && spec.id.trim()) {
      // TASK 283: Normalize spec ID to plain storage format
      taskId = validateQualifiedTaskId(spec.id) || spec.id;
    } else {
      // Get all existing tasks to determine the new task's ID
      const tasks = await this.getAllTasks();

      // TASK 283: Generate plain ID format for storage using proper max ID logic
      taskId = getNextTaskId(tasks); // Uses max existing ID + 1, returns plain format
    }

    // Create the new task data
    const newTask: TaskData = {
      id: taskId, // Store in plain format
      title: spec.title,
      description: spec.description,
      status: TASK_STATUS.TODO,
      backend: this.name,
    };

    // Save task data
    await this.saveAllTasks([...tasks, newTask]);

    return newTask;
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    const task = await this.getTask(id);
    if (!task) {
      return false;
    }

    // Delete from PostgreSQL tasks table (source of truth)
    try {
      // Use injected provider or fall back to singleton access (legacy compatibility)
      let provider = this.persistenceProvider;
      if (!provider) {
        const { PersistenceService } = await import("../persistence/service");
        provider = PersistenceService.getProvider();
      }

      if (provider.capabilities.sql) {
        const db = await provider.getDatabaseConnection?.();

        if (db) {
          const { tasksTable } = await import("../storage/schemas/task-embeddings");
          const { eq } = await import("drizzle-orm");

          // Delete from tasks table (this will cascade delete from tasks_embeddings due to FK constraint)
          const result = await db.delete(tasksTable).where(eq(tasksTable.id, id));
          log.debug(`Deleted task ${id} from database`, { rowCount: (result as any).rowCount });
        } else {
          log.debug(`No database connection available for task ${id} deletion`);
        }
      } else {
        log.debug(`Database provider does not support SQL for task ${id} deletion`);
      }
    } catch (dbError) {
      // Log but don't fail the operation if database deletion fails
      log.debug(`Could not delete task ${id} from database: ${getErrorMessage(dbError as any)}`);
    }

    // Delete spec file if it exists
    if (task.specPath && (await this.fileExists(task.specPath))) {
      await fs.unlink(task.specPath);
    }

    const tasks = await this.getAllTasks();
    const filteredTasks = tasks.filter((t) => t.id !== id);
    await this.saveAllTasks(filteredTasks);

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
        backend: task.backend || this.name,
        createdAt: undefined,
        updatedAt: undefined,
      };
    } catch {
      return null;
    }
  }

  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    const tasks = await this.getAllTasks();
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

    await this.saveAllTasks(tasks);
  }

  // ---- Internal Methods ----

  private async getAllTasks(): Promise<Task[]> {
    try {
      if (!(await this.fileExists(this.tasksFilePath))) {
        return [];
      }

      const content = await fs.readFile(this.tasksFilePath, "utf-8");
      const data = JSON.parse(content);
      return Array.isArray(data) ? data : [];
    } catch (error) {
      log.warn("Failed to read tasks file", { error: getErrorMessage(error as any) });
      return [];
    }
  }

  private async saveAllTasks(tasks: Task[]): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(dirname(this.tasksFilePath), { recursive: true });

      // Write tasks to file
      await fs.writeFile(this.tasksFilePath, JSON.stringify(tasks, null, 2));
    } catch (error) {
      throw new Error(`Failed to save tasks: ${error}`);
    }
  }

  private getTaskSpecPath(taskId: string, title: string): string {
    const cleanId = taskId.replace(/^(json-file)?#/, "");
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .substring(0, 50);

    return join(this.workspacePath, "process", "tasks", `${cleanId}-${slug}.md`);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

// Factory function with optional dependency injection
export function createJsonFileTaskBackend(
  config: TaskBackendConfig & { persistenceProvider?: PersistenceProvider }
): JsonFileTaskBackend {
  return new JsonFileTaskBackend(config);
}
