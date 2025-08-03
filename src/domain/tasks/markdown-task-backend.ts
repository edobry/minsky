/**
 * Markdown Task Backend
 *
 * Implementation of TaskBackend for markdown-based task storage.
 * Updated for multi-backend architecture with qualified task IDs.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { log } from "../../utils/logger";
import { normalizeTaskId } from "./utils";
import { ResourceNotFoundError, getErrorMessage } from "../../errors/index";
import { TASK_STATUS, TASK_STATUS_CHECKBOX, TASK_PARSING_UTILS } from "./taskConstants";
import type { TaskStatus } from "./taskConstants";
import { getTaskSpecRelativePath } from "./taskIO";
import type { Task } from "./types";

// Import the new multi-backend interface
import type { TaskBackend, TaskSpec, TaskFilters, TaskExportData } from "./multi-backend-service";

// @ts-ignore - matter is a third-party library
import matter from "gray-matter";

export class MarkdownTaskBackend implements TaskBackend {
  name = "markdown";
  prefix = "md"; // Backend prefix for qualified IDs
  private filePath: string;
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.filePath = join(workspacePath, "process", "tasks.md");
  }

  async createTask(spec: TaskSpec): Promise<Task> {
    // Get next available task ID
    const tasks = await this.parseTasks();
    const maxId = Math.max(0, ...tasks.map((t) => parseInt(t.id.replace(/^(md#|#)/, ""), 10) || 0));
    const nextId = maxId + 1;
    const qualifiedId = `md#${nextId}`;

    // Create task from spec
    const newTask: Task = {
      id: qualifiedId,
      title: spec.title,
      description: spec.description || "",
      status: (spec.status as TaskStatus) || TASK_STATUS.TODO,
    };

    // Add task to the list
    tasks.push(newTask);
    await this.saveTasks(tasks);

    return newTask;
  }

  async getTask(taskId: string): Promise<Task | null> {
    const tasks = await this.parseTasks();

    // Handle both qualified (md#123) and local (123) IDs
    const localId = taskId.replace(/^md#/, "");

    // First try exact match with qualified ID
    let task = tasks.find((t) => t.id === taskId || t.id === `md#${localId}`);

    // If not found, try legacy format matching
    if (!task) {
      const numericId = parseInt(localId.replace(/^#/, ""), 10);
      if (!isNaN(numericId)) {
        task = tasks.find((t) => {
          const taskNumericId = parseInt(t.id.replace(/^(md#|#)/, ""), 10);
          return !isNaN(taskNumericId) && taskNumericId === numericId;
        });
      }
    }

    // Ensure task ID is in qualified format
    if (task && !task.id.startsWith("md#")) {
      task.id = `md#${task.id.replace(/^#/, "")}`;
    }

    return task || null;
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task> {
    const tasks = await this.parseTasks();

    // Use the same sophisticated ID matching logic as getTask
    let taskIndex = -1;
    let targetTask: Task | null = null;

    // Handle both qualified (md#123) and local (123) IDs
    const localId = taskId.replace(/^md#/, "");

    // First try exact match with qualified ID
    taskIndex = tasks.findIndex((t) => t.id === taskId || t.id === `md#${localId}`);

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

    if (taskIndex === -1) {
      throw new ResourceNotFoundError(`Task ${taskId} not found`);
    }

    targetTask = tasks[taskIndex];

    // Update the task with proper type safety
    const baseTask = tasks[taskIndex]!; // Safe after index check
    const updatedTask: Task = {
      id: targetTask.id, // Use the existing task ID (already qualified)
      title: updates.title ?? baseTask.title,
      status: updates.status ?? baseTask.status,
      description: updates.description ?? baseTask.description,
      metadata: updates.metadata ?? baseTask.metadata,
      path: updates.path ?? baseTask.path,
      specPath: updates.specPath ?? baseTask.specPath,
      workspacePath: updates.workspacePath ?? baseTask.workspacePath,
      repositoryUri: updates.repositoryUri ?? baseTask.repositoryUri,
    };

    tasks[taskIndex] = updatedTask;
    await this.saveTasks(tasks);
    return updatedTask;
  }

  async deleteTask(taskId: string): Promise<void> {
    const tasks = await this.parseTasks();
    const localId = taskId.replace(/^md#/, "");

    const initialLength = tasks.length;
    const filteredTasks = tasks.filter((t) => {
      const tLocalId = t.id.replace(/^(md#|#)/, "");
      return tLocalId !== localId;
    });

    if (filteredTasks.length === initialLength) {
      throw new ResourceNotFoundError(`Task ${taskId} not found`);
    }

    await this.saveTasks(filteredTasks);
  }

  async listTasks(filters?: TaskFilters): Promise<Task[]> {
    const tasks = await this.parseTasks();

    // Ensure all task IDs are qualified
    const qualifiedTasks = tasks.map((task) => ({
      ...task,
      id: task.id.startsWith("md#") ? task.id : `md#${task.id.replace(/^#/, "")}`,
    }));

    if (!filters) {
      return qualifiedTasks;
    }

    return qualifiedTasks.filter((task) => {
      if (filters.status && task.status !== filters.status) {
        return false;
      }
      if (filters.backend && filters.backend !== "md") {
        return false;
      }
      return true;
    });
  }

  getTaskSpecPath(taskId: string): string {
    const localId = taskId.replace(/^md#/, "");
    return join(this.workspacePath, "process", "tasks", `${localId}.md`);
  }

  supportsFeature(feature: string): boolean {
    const supportedFeatures = [
      "create",
      "read",
      "update",
      "delete",
      "list",
      "status",
      "metadata",
      "export",
      "import",
    ];
    return supportedFeatures.includes(feature);
  }

  async exportTask(taskId: string): Promise<TaskExportData> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new ResourceNotFoundError(`Task ${taskId} not found for export`);
    }

    return {
      spec: {
        title: task.title,
        description: task.description,
        status: task.status,
      },
      metadata: {
        originalId: task.id,
        metadata: task.metadata,
      },
      backend: "md",
      exportedAt: new Date().toISOString(),
    };
  }

  async importTask(data: TaskExportData): Promise<Task> {
    // Use createTask to import the task
    return await this.createTask(data.spec);
  }

  validateLocalId(localId: string): boolean {
    // Validate that local ID is a positive integer
    const numericId = parseInt(localId, 10);
    return !isNaN(numericId) && numericId > 0 && numericId.toString() === localId;
  }

  // Legacy methods to maintain compatibility
  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task ? task.status : undefined;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    if (!Object.values(TASK_STATUS).includes(status as TaskStatus)) {
      throw new Error(`Status must be one of: ${Object.values(TASK_STATUS).join(", ")}`);
    }

    await this.updateTask(id, { status: status as TaskStatus });
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  // Private helper methods
  private async parseTasks(): Promise<Task[]> {
    try {
      const exists = await fs
        .access(this.filePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        return [];
      }

      const content = await fs.readFile(this.filePath, "utf-8");
      return this.parseTasksFromMarkdown(content.toString());
    } catch (error) {
      log.error(`Error reading tasks file: ${getErrorMessage(error)}`);
      return [];
    }
  }

  private async saveTasks(tasks: Task[]): Promise<void> {
    try {
      // Ensure directory exists
      const dir = join(this.workspacePath, "process");
      await fs.mkdir(dir, { recursive: true });

      const content = this.formatTasksToMarkdown(tasks);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      throw new Error(`Failed to save tasks: ${getErrorMessage(error)}`);
    }
  }

  private parseTasksFromMarkdown(content: string): Task[] {
    const lines = content.split("\n");
    const tasks: Task[] = [];
    let currentTask: Partial<Task> | null = null;

    for (const line of lines) {
      // Check for task line - supports both legacy (#123) and qualified (md#123) formats
      const taskMatch = line.match(/^-\s*\[([x\s+])\]\s*([a-z-]*#?\d+)\s+(.+)$/);
      if (taskMatch) {
        if (currentTask && currentTask.id && currentTask.title) {
          tasks.push(currentTask as Task);
        }

        const checkbox = taskMatch[1];
        const id = taskMatch[2];
        const title = taskMatch[3];

        if (checkbox && id && title) {
          let status: TaskStatus;
          if (checkbox === "x") {
            status = TASK_STATUS.DONE;
          } else if (checkbox === "+") {
            status = TASK_STATUS.IN_PROGRESS;
          } else {
            status = TASK_STATUS.TODO;
          }

          // Convert to qualified format if needed
          let qualifiedId: string;
          if (id.includes("#")) {
            // Either "md#123" (already qualified) or "#123" (legacy)
            qualifiedId = id.startsWith("#") ? `md${id}` : id;
          } else {
            // Plain number "123"
            qualifiedId = `md#${id}`;
          }

          currentTask = {
            id: qualifiedId,
            title: title.trim(),
            status,
            description: "",
          };
        }
      } else if (currentTask && line.trim()) {
        // Add to description if we have a current task
        currentTask.description = `${(currentTask.description || "") + line.trim()} `;
      } else if (line.trim() === "" && currentTask) {
        // Empty line ends current task - clean up description
        if (currentTask.description) {
          currentTask.description = currentTask.description.trim();
        }
        if (currentTask.id && currentTask.title) {
          tasks.push(currentTask as Task);
        }
        currentTask = null;
      }
    }

    // Add the last task if exists - clean up description
    if (currentTask && currentTask.id && currentTask.title) {
      if (currentTask.description) {
        currentTask.description = currentTask.description.trim();
      }
      tasks.push(currentTask as Task);
    }

    return tasks;
  }

  private formatTasksToMarkdown(tasks: Task[]): string {
    return tasks
      .map((task) => {
        let checkbox: string;
        if (task.status === TASK_STATUS.DONE) {
          checkbox = "x";
        } else if (task.status === TASK_STATUS.IN_PROGRESS) {
          checkbox = "+";
        } else {
          checkbox = " ";
        }
        // Keep qualified ID format in storage for multi-backend consistency
        const displayId = task.id; // Use full qualified ID (md#123)
        let output = `- [${checkbox}] ${displayId} ${task.title}`;

        if (task.description && task.description.trim()) {
          output += `\n${task.description.trim()}`;
        }

        return output;
      })
      .join("\n\n");
  }
}
