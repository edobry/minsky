export interface TaskBackend {
  name: string;
  listTasks(options?: TaskListOptions): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  getTaskStatus(id: string): Promise<string | undefined>;
  setTaskStatus(id: string, status: string): Promise<void>;
  getWorkspacePath(): string;
  createTask(specPath: string, options?: CreateTaskOptions): Promise<Task>;
  createTaskFromTitleAndDescription(
    title: string,
    description: string,
    options?: CreateTaskOptions
  ): Promise<Task>;
  setTaskMetadata?(id: string, metadata: any): Promise<void>;
  deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean>;
  
  // New capability discovery method
  getCapabilities(): BackendCapabilities;
  
  // Enhanced metadata methods (optional for now, using proper types)
  getTaskMetadata?(id: string): Promise<TaskMetadata | null>;
  setTaskMetadata?(id: string, metadata: TaskMetadata): Promise<void>;
  queryTasksByMetadata?(query: MetadataQuery): Promise<Task[]>;
}