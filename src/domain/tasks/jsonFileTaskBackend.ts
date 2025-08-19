// Keep all existing imports at the top

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
    const tasks = await this.getAllTasks();

    // Generate next ID
    const maxId = tasks.reduce((max, task) => {
      const numId = parseInt(task.id.replace(/^(json-file)?#/, ""), 10);
      return numId > max ? numId : max;
    }, 0);

    const newId = `json-file#${maxId + 1}`;

    // Create spec file
    const specPath = this.getTaskSpecPath(newId, title);
    const specContent = this.generateTaskSpecification(title, description);

    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.writeFile(specPath, specContent);

    // Create task entry
    const newTask: TaskData = {
      id: newId,
      title,
      description,
      status: TASK_STATUS.TODO,
      specPath,
    };

    await this.createTaskData(newTask);

    return {
      id: newTask.id,
      title: newTask.title,
      description: newTask.description,
      status: newTask.status,
      specPath: newTask.specPath,
      backend: "json-file",
    };
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
        backend: task.backend,
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
    return tasks.map(this.mapTaskDataToTask);
  }

  private async saveAllTasks(tasks: Task[]): Promise<void> {
    // Convert back to TaskData and save each one
    for (const task of tasks) {
      const taskData: TaskData = {
        id: task.id,
        title: task.title,
        description: task.description,
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
      description: taskData.description || "",
      status: taskData.status,
      specPath: taskData.specPath,
      backend: "json-file",
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

  private generateTaskSpecification(title: string, description: string): string {
    return `# ${title}

## Context

${description}

## Requirements

(Requirements to be added)

## Implementation

(Implementation details to be added)
`;
  }
}

// ... keep existing factory function and other exports ...
