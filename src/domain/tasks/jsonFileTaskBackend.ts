import { promises as fs } from "fs";
import path from "path";
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
import type { TaskData } from "../types/tasks/taskData";
import type { DatabaseStorage } from "../storage/database-storage";
import { createDatabaseStorage } from "../storage";
import { TASK_STATUS } from "../constants";

/**
 * JsonFileTaskBackend implementation using DatabaseStorage
 */
export class JsonFileTaskBackend implements TaskBackend {
  name = "json-file";
  private workspacePath: string;
  private storage: DatabaseStorage;

  constructor(config: TaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.storage = createDatabaseStorage(this.workspacePath);
  }

  // ---- User-Facing Operations ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const tasks = await this.getAllTasks();

    let filtered = tasks;
    if (options?.status && options.status !== "all") {
      filtered = filtered.filter((task) => task.status === options.status);
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
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.writeFile(specPath, spec);

    // Create task data
    const newTask: TaskData = {
      id: newId,
      title,
      specPath,
      status: TASK_STATUS.TODO,
      backend: this.name,
    };

    // Save task data
    const createdTask = await this.createTaskData(newTask);
    await this.saveAllTasks([...tasks, createdTask]);

    return this.mapTaskDataToTask(createdTask);
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    const task = await this.getTask(id);
    if (!task) {
      return false;
    }

    // Delete spec file if it exists
    if (task.specPath && (await this.fileExists(task.specPath))) {
      await fs.unlink(task.specPath);
    }

    const deleted = await this.storage.delete(id);
    return deleted;
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
    const tasks = await this.storage.getAll<TaskData>();
    return tasks.map(this.mapTaskDataToTask.bind(this));
  }

  private async saveAllTasks(tasks: Task[]): Promise<void> {
    // Convert back to TaskData and save each one
    for (const task of tasks) {
      const taskData: TaskData = {
        id: task.id,
        title: task.title,
        status: task.status,
        specPath: task.specPath,
      };
      await this.storage.update(task.id, taskData);
    }
  }

  private async createTaskData(task: TaskData): Promise<TaskData> {
    await this.storage.create(task.id, task);
    return task;
  }

  private mapTaskDataToTask(taskData: TaskData): Task {
    return {
      id: taskData.id,
      title: taskData.title,
      status: taskData.status,
      specPath: taskData.specPath,
      backend: this.name,
    };
  }

  private getTaskSpecPath(taskId: string, title: string): string {
    const cleanId = taskId.replace(/^(json-file)?#/, "");
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .substring(0, 50);

    return path.join(this.workspacePath, "process", "tasks", `${cleanId}-${slug}.md`);
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

// Factory function
export function createJsonFileTaskBackend(config: TaskBackendConfig): JsonFileTaskBackend {
  return new JsonFileTaskBackend(config);
}
