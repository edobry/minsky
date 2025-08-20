import { promises as fs } from "fs";
import type {
  Task,
  TaskBackend,
  TaskBackendConfig,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
  TaskMetadata,
} from "./types";
import type { TaskData } from "../types/tasks/taskData";
import { createMarkdownTaskBackend } from "./markdownTaskBackend";
import { createJsonFileTaskBackend } from "./jsonFileTaskBackend";
import { createMinskyTaskBackend } from "./minskyTaskBackend";
import { log } from "../../utils/logger";
// normalizeTaskId removed: strict qualified IDs expected upstream
import { TASK_STATUS, TASK_STATUS_VALUES, isValidTaskStatus } from "./taskConstants";
import { getErrorMessage } from "../../errors/index";
import { get } from "../configuration/index";
import { validateQualifiedTaskId } from "./task-id-utils";
import { getGitHubBackendConfig } from "./githubBackendConfig";
import { createGitHubIssuesTaskBackend } from "./githubIssuesTaskBackend";
import { detectRepositoryBackendType } from "../session/repository-backend-detection";
import { validateTaskBackendCompatibility } from "./taskBackendCompatibility";
import type { RepositoryBackend } from "../repository/index";
import { createRepositoryBackend, RepositoryBackendType } from "../repository/index";
import { filterTasksByStatus } from "./task-filters";

export interface TaskServiceOptions {
  workspacePath: string;
  backend?: string;
}

export class TaskService {
  private readonly backends: TaskBackend[] = [];
  private currentBackend!: TaskBackend;
  private readonly workspacePath: string;

  constructor(options: TaskServiceOptions) {
    this.workspacePath = options.workspacePath;
    this.backends = [
      createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: options.workspacePath,
      }),
      createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: options.workspacePath,
      }),
      createMinskyTaskBackend({
        name: "minsky",
        workspacePath: options.workspacePath,
      }),
    ];

    // Set current backend
    const backendName = options.backend || "markdown";
    const backend = this.backends.find((b) => b.name === backendName);
    if (!backend) {
      throw new Error(`Backend not found: ${backendName}`);
    }
    this.currentBackend = backend;
  }

  // ---- Core Task Operations ----

  async getAllTasks(): Promise<TaskData[]> {
    const tasks = await this.currentBackend.listTasks();
    return tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      specPath: task.specPath,
      backend: task.backend,
    }));
  }

  async listTasks(options?: TaskListOptions): Promise<TaskData[]> {
    const tasks = await this.currentBackend.listTasks(options);
    return tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      specPath: task.specPath,
      backend: task.backend,
    }));
  }

  async getTask(id: string): Promise<TaskData | null> {
    const task = await this.currentBackend.getTask(id);
    if (!task) return null;

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      specPath: task.specPath,
      backend: task.backend,
    };
  }

  async createTask(title: string, options?: CreateTaskOptions): Promise<TaskData> {
    // This method creates a task with basic info
    const spec =
      options?.spec ||
      `# ${title}\n\n## Context\n\n(Context to be added)\n\n## Requirements\n\n(Requirements to be added)\n\n## Implementation\n\n(Implementation to be added)`;

    const task = await this.currentBackend.createTaskFromTitleAndSpec(title, spec, options);

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      specPath: task.specPath,
      backend: task.backend,
    };
  }

  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<TaskData> {
    const task = await this.currentBackend.createTaskFromTitleAndSpec(title, spec, options);

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      specPath: task.specPath,
      backend: task.backend,
    };
  }

  async updateTask(id: string, updates: Partial<TaskData>): Promise<TaskData> {
    // Update task status if provided
    if (updates.status) {
      await this.currentBackend.setTaskStatus(id, updates.status);
    }

    // Update task metadata if backend supports it
    if (this.currentBackend.setTaskMetadata && (updates.title || (updates as any).spec)) {
      const metadata: TaskMetadata = {
        id,
        title: updates.title || "",
        spec: (updates as any).spec || "",
        status: updates.status || "TODO",
        backend: this.currentBackend.name,
      };
      await this.currentBackend.setTaskMetadata(id, metadata);
    }

    // Return updated task
    const updatedTask = await this.getTask(id);
    if (!updatedTask) {
      throw new Error(`Task ${id} not found after update`);
    }
    return updatedTask;
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    return await this.currentBackend.deleteTask(id, options);
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    return await this.currentBackend.getTaskStatus(id);
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    await this.currentBackend.setTaskStatus(id, status);
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  // ---- Spec Content Operations ----

  async getTaskSpecContent(id: string): Promise<{ content: string; specPath: string; task: any }> {
    const task = await this.currentBackend.getTask(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }

    if (task.specPath) {
      try {
        const content = await fs.readFile(task.specPath, "utf-8");
        return { content, specPath: task.specPath, task };
      } catch (error) {
        throw new Error(`Failed to read spec file for task ${id}: ${error}`);
      }
    } else {
      // For database backend, get spec content from metadata
      if (this.currentBackend.getTaskMetadata) {
        const metadata = await this.currentBackend.getTaskMetadata(id);
        return {
          content: metadata?.spec || "",
          specPath: "(database)",
          task,
        };
      } else {
        throw new Error(`Task ${id} has no spec content available`);
      }
    }
  }

  // ---- Backend Management ----

  async getBackendForTask(id: string): Promise<TaskBackend | null> {
    const task = await this.currentBackend.getTask(id);
    if (!task) return null;

    return this.currentBackend;
  }

  // ---- Metadata Operations ----

  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    if (!this.currentBackend.setTaskMetadata) {
      throw new Error(`Backend ${this.currentBackend.name} does not support metadata operations`);
    }
    await this.currentBackend.setTaskMetadata(id, metadata);
  }

  async getTaskMetadata(id: string): Promise<TaskMetadata | null> {
    if (!this.currentBackend.getTaskMetadata) {
      return null;
    }
    return await this.currentBackend.getTaskMetadata(id);
  }

  // ---- Factory Methods ----

  static async createWithRepositoryBackend(
    workspacePath: string,
    repoConfig?: any
  ): Promise<TaskService> {
    const effectiveBackend = repoConfig?.backend || "markdown";

    let taskBackend: TaskBackend;
    if (effectiveBackend === "markdown") {
      taskBackend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath,
      });
    } else if (effectiveBackend === "json-file") {
      taskBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath,
      });
    } else if (effectiveBackend === "minsky") {
      taskBackend = createMinskyTaskBackend({
        name: "minsky",
        workspacePath,
      });
    } else {
      throw new Error(`Unsupported backend type: ${effectiveBackend}`);
    }

    const service = new TaskService({
      workspacePath,
      backend: effectiveBackend,
    });

    if (taskBackend) {
      service.currentBackend = taskBackend;
    }

    return service;
  }
}

// ---- Factory Functions ----

export function createTaskService(options: TaskServiceOptions): TaskService {
  return new TaskService(options);
}

export function createConfiguredTaskService(workspacePath: string, backend?: string): TaskService {
  return new TaskService({ workspacePath, backend });
}

// ---- Type Exports ----

export type { TaskServiceOptions };
