import { promises as fs } from "fs";
import * as path from "path";
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
import { TASK_STATUS } from "./taskConstants";

/**
 * JsonFileTaskBackend implementation using simple JSON file storage
 */
export class JsonFileTaskBackend implements TaskBackend {
  name = "json-file";
  private workspacePath: string;
  private tasksFilePath: string;

  constructor(config: TaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.tasksFilePath = path.join(this.workspacePath, "process", "tasks", "tasks.json");
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
    const newTask: Task = {
      id: newId,
      title,
      specPath,
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
      console.warn(`Failed to read tasks file: ${error}`);
      return [];
    }
  }

  private async saveAllTasks(tasks: Task[]): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.tasksFilePath), { recursive: true });

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
