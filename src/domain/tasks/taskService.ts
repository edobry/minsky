// ... keep all existing imports and class header ...

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
      createDatabaseTaskBackend({
        name: "db",
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

  /**
   * Get all tasks from the current backend
   * @returns Promise resolving to array of tasks
   */
  async getAllTasks(): Promise<TaskData[]> {
    const tasks = await this.currentBackend.listTasks();

    // Convert to TaskData format for compatibility
    return tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      specPath: task.specPath,
    }));
  }

  /**
   * Get a single task by ID
   * @param id Task ID
   * @returns Promise resolving to task or null if not found
   */
  async getTask(id: string): Promise<TaskData | null> {
    const task = await this.currentBackend.getTask(id);
    if (!task) {
      return null;
    }

    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      specPath: task.specPath,
    };
  }

  /**
   * Create a new task from title and description
   * @param title Task title
   * @param options Create options
   * @returns Promise resolving to the created task
   */
  async createTask(title: string, options?: CreateTaskOptions): Promise<TaskData> {
    const description = options?.description || "";
    const task = await this.currentBackend.createTaskFromTitleAndSpec(title, description, options);

    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      specPath: task.specPath,
    };
  }

  /**
   * Update a task's metadata
   * @param id Task ID
   * @param updates Task updates
   * @returns Promise resolving to updated task
   */
  async updateTask(id: string, updates: Partial<TaskData>): Promise<TaskData> {
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // Update status if provided
    if (updates.status && updates.status !== task.status) {
      await this.currentBackend.setTaskStatus(id, updates.status);
    }

    // Update metadata if provided
    if (updates.title || updates.description) {
      const metadata: TaskMetadata = {
        id: task.id,
        title: updates.title || task.title,
        status: updates.status || task.status,
        backend: this.currentBackend.name,
        spec: updates.description || task.description,
      };

      if (this.currentBackend.setTaskMetadata) {
        await this.currentBackend.setTaskMetadata(id, metadata);
      }
    }

    // Return updated task
    return (await this.getTask(id)) || task;
  }

  /**
   * List tasks with optional filtering
   * @param options List options
   * @returns Promise resolving to array of tasks
   */
  async listTasks(options?: TaskListOptions): Promise<TaskData[]> {
    const tasks = await this.currentBackend.listTasks(options);

    // Convert to TaskData format and apply additional filtering
    let result = tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      specPath: task.specPath,
    }));

    // Apply default filtering if no status filter specified
    if (!options?.status && options?.all !== true) {
      result = result.filter((task) => task.status !== "DONE");
    }

    return result;
  }

  /**
   * Get task status
   * @param id Task ID
   * @returns Promise resolving to task status or undefined
   */
  async getTaskStatus(id: string): Promise<string | undefined> {
    return await this.currentBackend.getTaskStatus(id);
  }

  /**
   * Set task status
   * @param id Task ID
   * @param status New status
   * @returns Promise that resolves when status is set
   */
  async setTaskStatus(id: string, status: string): Promise<void> {
    await this.currentBackend.setTaskStatus(id, status);
  }

  /**
   * Delete a task
   * @param id Task ID
   * @param options Delete options
   * @returns Promise resolving to true if deleted, false if not found
   */
  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    return await this.currentBackend.deleteTask(id, options);
  }

  /**
   * Get task specification content
   * @param id Task ID
   * @returns Promise resolving to task specification content with metadata
   */
  async getTaskSpecContent(id: string): Promise<{ content: string; specPath: string; task: any }> {
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // For database backend, get spec from metadata
    if (this.currentBackend.name === "db" && this.currentBackend.getTaskMetadata) {
      const metadata = await this.currentBackend.getTaskMetadata(id);
      return {
        content: metadata?.spec || "",
        specPath: `db:${id}`,
        task,
      };
    }

    // For other backends, read from spec file
    if (!task.specPath) {
      throw new Error(`No spec path found for task ${id}`);
    }

    const content = await fs.readFile(task.specPath, "utf-8");
    return {
      content: content.toString(),
      specPath: task.specPath,
      task,
    };
  }

  /**
   * Get the backend for a specific task
   * @param id Task ID
   * @returns Promise resolving to the appropriate backend or null if not found
   */
  async getBackendForTask(id: string): Promise<TaskBackend | null> {
    for (const backend of this.backends) {
      const task = await backend.getTask(id);
      if (task) {
        return backend;
      }
    }
    return null;
  }

  /**
   * Set task metadata
   * @param id Task ID
   * @param metadata Task metadata to set
   * @returns Promise that resolves when metadata is set
   */
  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    if (!this.currentBackend.setTaskMetadata) {
      throw new Error(`Backend ${this.currentBackend.name} does not support metadata operations`);
    }

    await this.currentBackend.setTaskMetadata(id, metadata);
  }

  /**
   * Get task metadata
   * @param id Task ID
   * @returns Promise resolving to task metadata or null if not found
   */
  async getTaskMetadata(id: string): Promise<TaskMetadata | null> {
    if (!this.currentBackend.getTaskMetadata) {
      return null;
    }

    return await this.currentBackend.getTaskMetadata(id);
  }

  /**
   * Get the workspace path
   * @returns Workspace path
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Create a task service with repository backend integration
   * Used for GitHub Issues backend with repository override
   */
  static async createWithRepositoryBackend(options: {
    workspacePath: string;
    backend: string;
    githubRepoOverride?: string;
  }): Promise<TaskService> {
    const service = new TaskService({
      workspacePath: options.workspacePath,
      backend: options.backend,
    });

    // Override backend if GitHub repo is specified
    if (options.backend === "github-issues" && options.githubRepoOverride) {
      const [owner, repo] = options.githubRepoOverride.split("/");
      if (owner && repo) {
        const effectiveBackend = options.backend;

        let taskBackend: TaskBackend;
        if (effectiveBackend === "markdown") {
          taskBackend = createMarkdownTaskBackend({
            name: "markdown",
            workspacePath: options.workspacePath,
          });
        } else if (effectiveBackend === "json-file") {
          taskBackend = createJsonFileTaskBackend({
            name: "json-file",
            workspacePath: options.workspacePath,
          });
        } else if (effectiveBackend === "db") {
          taskBackend = createDatabaseTaskBackend({
            name: "db",
            workspacePath: options.workspacePath,
          });
        } else {
          throw new Error(`Unsupported backend type: ${effectiveBackend}`);
        }

        service.currentBackend = taskBackend;
      }
    }

    return service;
  }
}

// ... keep existing factory functions ...
