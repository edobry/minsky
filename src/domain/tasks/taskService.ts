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
import type { TaskServiceInterface } from "../tasks";
import { createMarkdownTaskBackend } from "./markdownTaskBackend";
import { createJsonFileTaskBackend } from "./jsonFileTaskBackend";
import { createMinskyTaskBackend, type MinskyTaskBackendConfig } from "./minskyTaskBackend";
import {
  createMultiBackendTaskService,
  type MultiBackendTaskService,
} from "./multi-backend-service";
import { createDatabaseConnection } from "../database/connection-manager";
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

  constructor(options: TaskServiceOptions & { backends?: TaskBackend[] }) {
    this.workspacePath = options.workspacePath;
    this.backends = options.backends || [
      createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: options.workspacePath,
      }),
      createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: options.workspacePath,
      }),
      // Minsky backend will be added by factory function with proper DB connection
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

  async createTask(specPath: string, options?: CreateTaskOptions): Promise<TaskData> {
    // Legacy createTask expects a path to a spec file for markdown backend.
    const backendAny = this.currentBackend as any;
    let task: any;
    if (typeof backendAny.createTaskFromTitleAndSpec === "function") {
      const content = await fs.readFile(specPath, "utf-8");
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : "New Task";
      task = await backendAny.createTaskFromTitleAndSpec(title, content, options);
    } else if (typeof backendAny.createTask === "function") {
      task = await backendAny.createTask(specPath, options);
    } else {
      throw new Error("Current backend does not support task creation");
    }

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
      // Handle different backends without specPath
      if (this.currentBackend.name === "markdown") {
        // For markdown backend, construct the spec file path
        const { getTaskSpecFilePath } = await import("./taskIO");
        const specPath = getTaskSpecFilePath(id, task.title, this.workspacePath);

        try {
          const content = await fs.readFile(specPath, "utf-8");
          return { content, specPath, task };
        } catch (error) {
          // If the generated path doesn't work, try to find the actual file with glob pattern
          const { join } = await import("path");
          const { glob } = await import("glob");
          const tasksDir = join(this.workspacePath, "process", "tasks");
          const pattern = `${id}-*.md`;

          try {
            const matches = await glob(pattern, { cwd: tasksDir });
            if (matches.length > 0) {
              const actualPath = join(tasksDir, matches[0]);
              const content = await fs.readFile(actualPath, "utf-8");
              return { content, specPath: actualPath, task };
            }
          } catch (globError) {
            // Fall through to original error
          }

          throw new Error(
            `Failed to read spec file for task ${id}. Tried: ${specPath} and pattern ${pattern} in ${tasksDir}: ${error}`
          );
        }
      } else if (this.currentBackend.getTaskMetadata) {
        // For database backend, get spec content from metadata
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
}

// ---- Factory Functions ----

export async function createConfiguredTaskService(options: {
  workspacePath: string;
  backend?: string;
}): Promise<TaskServiceInterface> {
  // Create multi-backend service - this is now the default!
  const service = createMultiBackendTaskService({ workspacePath: options.workspacePath });

  // Register all available backends with their prefixes
  try {
    const markdownBackend = createMarkdownTaskBackend({
      name: "markdown",
      workspacePath: options.workspacePath,
    });
    // Add prefix property for multi-backend routing
    (markdownBackend as any).prefix = "md";
    service.registerBackend(markdownBackend);

    const jsonBackend = createJsonFileTaskBackend({
      name: "json-file",
      workspacePath: options.workspacePath,
    });
    (jsonBackend as any).prefix = "json";
    service.registerBackend(jsonBackend);

    // Add minsky backend (mt# prefix) - requires database connection
    try {
      // Direct database connection bypassing config system
      const { drizzle } = await import("drizzle-orm/postgres-js");
      const postgres = (await import("postgres")).default;

      const sql = postgres(
        "postgresql://postgres.prncxnvwabtrqrwvrvki:9o1hHdmKmsfCbltp@aws-0-us-east-2.pooler.supabase.com:6543/postgres",
        {
          prepare: false,
          onnotice: () => {},
        }
      );
      const db = drizzle(sql);

      const minskyBackend = createMinskyTaskBackend({
        name: "minsky",
        workspacePath: "/Users/edobry/Projects/minsky", // Use absolute path to main workspace
        db,
      });
      (minskyBackend as any).prefix = "mt";
      service.registerBackend(minskyBackend);
      log.debug("Minsky backend registered successfully");
    } catch (error) {
      log.debug("Minsky backend not available", { error: getErrorMessage(error as any) });
    }
  } catch (error) {
    log.warn("Failed to register some backends", { error: getErrorMessage(error as any) });
  }

  return service;
}

// ---- Utility functions used by tests (GitHub URL parsing) ----
export function extractGitHubInfoFromRepoUrl(url: string): { owner: string; repo: string } | null {
  try {
    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/^git@github.com:([^/]+)\/(.+?)(\.git)?$/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }
    // HTTPS: https://github.com/owner/repo(.git)?
    const httpsMatch = url.match(/^https?:\/\/github.com\/([^/]+)\/(.+?)(\.git)?$/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseGitHubRepoString(input: string): { owner: string; repo: string } | null {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

// ---- Type Exports ----

export type { TaskServiceOptions };
