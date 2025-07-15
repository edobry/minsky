/**
 * Task Service
 * 
 * Central service for task management operations.
 * Extracted from tasks.ts to improve modularity and maintainability.
 */

import { normalizeTaskId } from "./utils";
import { createJsonFileTaskBackend } from "./jsonFileTaskBackend";
import { MarkdownTaskBackend } from "./markdown-task-backend";
import { GitHubTaskBackend } from "./github-task-backend";
import type { 
  TaskBackend, 
  Task, 
  TaskListOptions, 
  CreateTaskOptions, 
  DeleteTaskOptions,
  TaskServiceOptions 
} from "./types";

export class TaskService {
  private backends: TaskBackend[] = [];
  private currentBackend: TaskBackend;

  constructor(options: TaskServiceOptions = {}) {
    const { workspacePath = (process as any).cwd(), backend = "markdown" } = options;

    // Initialize backends
    this.backends = [
      new MarkdownTaskBackend(workspacePath),
      new GitHubTaskBackend(workspacePath),
      createJsonFileTaskBackend({ name: "json-file", workspacePath }),
    ];

    // Set current backend
    const selectedBackend = this.backends.find((b) => b.name === backend);
    if (!selectedBackend) {
      throw new Error(
        `Backend '${backend}' not found. Available backends: ${this.backends.map((b) => b.name).join(", ")}`
      );
    }
    this.currentBackend = selectedBackend;
  }

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    return this.currentBackend.listTasks(options);
  }

  async getTask(id: string): Promise<Task | null> {
    return this.currentBackend.getTask(id);
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    return this.currentBackend.getTaskStatus(id);
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    return this.currentBackend.setTaskStatus(id, status);
  }

  getWorkspacePath(): string {
    return this.currentBackend.getWorkspacePath();
  }

  async createTask(specPath: string, options: CreateTaskOptions = {}): Promise<Task> {
    return this.currentBackend.createTask(specPath, options);
  }

  /**
   * Get the backend for a specific task
   * @param id Task ID
   * @returns The appropriate task backend for the task, or null if not found
   */
  async getBackendForTask(id: string): Promise<TaskBackend | null> {
    // Normalize the task ID
    const normalizedId = normalizeTaskId(id);
    if (!normalizedId) {
      return null;
    }

    // Try to find the task in each backend
    for (const backend of this.backends) {
      const task = await backend.getTask(normalizedId);
      if (task) {
        return backend;
      }
    }

    return null;
  }

  async deleteTask(id: string, options: DeleteTaskOptions = {}): Promise<boolean> {
    return this.currentBackend.deleteTask(id, options);
  }
} 
