/**
 * GitHub Issues + SQLite Hybrid Backend
 *
 * Implements true spec/metadata separation by using:
 * - GitHub Issues for task specifications (content, title, description)
 * - SQLite database for task metadata (relationships, provenance, etc.)
 *
 * This enables collaborative workflows (GitHub) with rich local metadata.
 */

import type {
  HybridTaskBackend,
  TaskSpecStorage,
  MetadataDatabase,
  Task,
  TaskSpec,
  TaskMetadata,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
  MetadataQuery,
  BackendCapabilities,
  SpecStorageCapabilities,
} from "./types";
import { createSqliteMetadataDatabase } from "./sqliteMetadataDatabase";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

/**
 * GitHub Issues specification storage
 * Handles task specs through GitHub Issues API
 */
export class GitHubIssuesSpecStorage implements TaskSpecStorage {
  name = "github-issues";
  
  constructor(
    private readonly octokit: any,
    private readonly owner: string,
    private readonly repo: string,
    private readonly workspacePath: string
  ) {}

  async listTaskSpecs(options?: TaskListOptions): Promise<TaskSpec[]> {
    try {
      const { data: issues } = await this.octokit.rest.issues.list({
        owner: this.owner,
        repo: this.repo,
        state: "all",
        labels: options?.status ? [options.status] : undefined,
      });

      return issues.map((issue: any) => ({
        id: issue.number.toString(),
        title: issue.title,
        description: issue.body || "",
        content: issue.body || "",
        specPath: issue.html_url,
      }));
    } catch (error) {
      log.error("Failed to list GitHub task specs", {
        error: getErrorMessage(error as any),
        owner: this.owner,
        repo: this.repo,
      });
      throw error;
    }
  }

  async getTaskSpec(id: string): Promise<TaskSpec | null> {
    try {
      const { data: issue } = await this.octokit.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: parseInt(id),
      });

      return {
        id: issue.number.toString(),
        title: issue.title,
        description: issue.body || "",
        content: issue.body || "",
        specPath: issue.html_url,
      };
    } catch (error) {
      if ((error as any)?.status === 404) {
        return null;
      }
      log.error("Failed to get GitHub task spec", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      throw error;
    }
  }

  async createTaskSpec(spec: TaskSpec, options?: CreateTaskOptions): Promise<TaskSpec> {
    try {
      const { data: issue } = await this.octokit.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title: spec.title,
        body: spec.description || spec.content || "",
      });

      return {
        id: issue.number.toString(),
        title: issue.title,
        description: issue.body || "",
        content: issue.body || "",
        specPath: issue.html_url,
      };
    } catch (error) {
      log.error("Failed to create GitHub task spec", {
        error: getErrorMessage(error as any),
        spec: spec.title,
      });
      throw error;
    }
  }

  async updateTaskSpec(id: string, spec: Partial<TaskSpec>): Promise<void> {
    try {
      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: parseInt(id),
        title: spec.title,
        body: spec.description || spec.content,
      });
    } catch (error) {
      log.error("Failed to update GitHub task spec", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      throw error;
    }
  }

  async deleteTaskSpec(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    try {
      // GitHub doesn't allow deleting issues, so we close them
      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: parseInt(id),
        state: "closed",
      });
      return true;
    } catch (error) {
      log.error("Failed to delete (close) GitHub task spec", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      return false;
    }
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getSpecStorageCapabilities(): SpecStorageCapabilities {
    return {
      supportsFullTextSearch: true,
      supportsVersionHistory: true,
      supportsRealTimeSync: true,
      requiresSpecialWorkspace: false,
      supportsTransactions: false,
    };
  }
}

/**
 * Configuration for GitHub + SQLite hybrid backend
 */
export interface GitHubSqliteHybridBackendOptions {
  // GitHub configuration
  octokit: any;
  owner: string;
  repo: string;
  workspacePath: string;
  
  // SQLite configuration
  metadataDatabasePath?: string;
}

/**
 * Hybrid backend combining GitHub Issues (specs) with SQLite (metadata)
 */
export class GitHubSqliteHybridBackend implements HybridTaskBackend {
  name = "github-sqlite-hybrid";
  
  readonly specStorage: GitHubIssuesSpecStorage;
  readonly metadataStorage: MetadataDatabase;

  constructor(options: GitHubSqliteHybridBackendOptions) {
    this.specStorage = new GitHubIssuesSpecStorage(
      options.octokit,
      options.owner,
      options.repo,
      options.workspacePath
    );
    
    this.metadataStorage = createSqliteMetadataDatabase({
      databasePath: options.metadataDatabasePath,
    });
  }

  async initialize(): Promise<void> {
    await this.metadataStorage.initialize();
  }

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    try {
      // Get specs from GitHub
      const specs = await this.specStorage.listTaskSpecs(options);
      
      // Get metadata for all tasks
      const tasks: Task[] = [];
      for (const spec of specs) {
        const metadata = await this.metadataStorage.getTaskMetadata(spec.id);
        
        tasks.push({
          id: spec.id,
          title: spec.title,
          description: spec.description,
          status: metadata?.status || "TODO",
          metadata: metadata || {},
          specPath: spec.specPath,
          workspacePath: this.getWorkspacePath(),
        });
      }
      
      return tasks;
    } catch (error) {
      log.error("Failed to list hybrid tasks", {
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  async getTask(id: string): Promise<Task | null> {
    try {
      const [spec, metadata] = await Promise.all([
        this.specStorage.getTaskSpec(id),
        this.metadataStorage.getTaskMetadata(id),
      ]);

      if (!spec) {
        return null;
      }

      return {
        id: spec.id,
        title: spec.title,
        description: spec.description,
        status: metadata?.status || "TODO",
        metadata: metadata || {},
        specPath: spec.specPath,
        workspacePath: this.getWorkspacePath(),
      };
    } catch (error) {
      log.error("Failed to get hybrid task", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      throw error;
    }
  }

  async createTask(
    spec: TaskSpec,
    metadata?: TaskMetadata,
    options?: CreateTaskOptions
  ): Promise<Task> {
    try {
      // Create spec in GitHub
      const createdSpec = await this.specStorage.createTaskSpec(spec, options);
      
      // Create metadata in SQLite
      const taskMetadata: TaskMetadata = {
        ...metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      
      await this.metadataStorage.setTaskMetadata(createdSpec.id, taskMetadata);

      return {
        id: createdSpec.id,
        title: createdSpec.title,
        description: createdSpec.description,
        status: taskMetadata.status || "TODO",
        metadata: taskMetadata,
        specPath: createdSpec.specPath,
        workspacePath: this.getWorkspacePath(),
      };
    } catch (error) {
      log.error("Failed to create hybrid task", {
        error: getErrorMessage(error as any),
        spec: spec.title,
      });
      throw error;
    }
  }

  async updateTask(
    id: string,
    updates: { spec?: Partial<TaskSpec>; metadata?: Partial<TaskMetadata> }
  ): Promise<void> {
    try {
      const promises: Promise<any>[] = [];

      // Update spec if provided
      if (updates.spec) {
        promises.push(this.specStorage.updateTaskSpec(id, updates.spec));
      }

      // Update metadata if provided
      if (updates.metadata) {
        const existingMetadata = await this.metadataStorage.getTaskMetadata(id);
        const updatedMetadata: TaskMetadata = {
          ...existingMetadata,
          ...updates.metadata,
          updatedAt: new Date().toISOString(),
        };
        promises.push(this.metadataStorage.setTaskMetadata(id, updatedMetadata));
      }

      await Promise.all(promises);
    } catch (error) {
      log.error("Failed to update hybrid task", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      throw error;
    }
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    try {
      const [specDeleted] = await Promise.all([
        this.specStorage.deleteTaskSpec(id, options),
        this.metadataStorage.deleteTaskMetadata(id),
      ]);
      
      return specDeleted;
    } catch (error) {
      log.error("Failed to delete hybrid task", {
        error: getErrorMessage(error as any),
        taskId: id,
      });
      return false;
    }
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const metadata = await this.metadataStorage.getTaskMetadata(id);
    return metadata?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    const existingMetadata = await this.metadataStorage.getTaskMetadata(id);
    const updatedMetadata: TaskMetadata = {
      ...existingMetadata,
      status: status as any,
      updatedAt: new Date().toISOString(),
    };
    
    await this.metadataStorage.setTaskMetadata(id, updatedMetadata);
  }

  async getTaskMetadata(id: string): Promise<TaskMetadata | null> {
    return this.metadataStorage.getTaskMetadata(id);
  }

  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    const updatedMetadata: TaskMetadata = {
      ...metadata,
      updatedAt: new Date().toISOString(),
    };
    
    await this.metadataStorage.setTaskMetadata(id, updatedMetadata);
  }

  async queryTasksByMetadata(query: MetadataQuery): Promise<Task[]> {
    try {
      // Query metadata first
      const metadataResults = await this.metadataStorage.queryTasks(query);
      
      // Get corresponding specs
      const tasks: Task[] = [];
      for (const metadata of metadataResults) {
        if (metadata.taskId) {
          const spec = await this.specStorage.getTaskSpec(metadata.taskId);
          if (spec) {
            tasks.push({
              id: spec.id,
              title: spec.title,
              description: spec.description,
              status: metadata.status || "TODO",
              metadata,
              specPath: spec.specPath,
              workspacePath: this.getWorkspacePath(),
            });
          }
        }
      }
      
      return tasks;
    } catch (error) {
      log.error("Failed to query hybrid tasks by metadata", {
        error: getErrorMessage(error as any),
        query,
      });
      throw error;
    }
  }

  getWorkspacePath(): string {
    return this.specStorage.getWorkspacePath();
  }

  getCapabilities(): BackendCapabilities {
    const specCaps = this.specStorage.getSpecStorageCapabilities();
    
    return {
      // Core operations
      supportsTaskCreation: true,
      supportsTaskUpdate: true,
      supportsTaskDeletion: true,

      // Essential metadata support
      supportsStatus: true,

      // Structural metadata (enabled by SQLite)
      supportsSubtasks: true,
      supportsDependencies: true,

      // Provenance metadata (enabled by SQLite)
      supportsOriginalRequirements: true,
      supportsAiEnhancementTracking: true,

      // Query capabilities
      supportsMetadataQuery: true,
      supportsFullTextSearch: specCaps.supportsFullTextSearch,

      // Update mechanism
      requiresSpecialWorkspace: specCaps.requiresSpecialWorkspace,
      supportsTransactions: false, // GitHub doesn't support transactions
      supportsRealTimeSync: specCaps.supportsRealTimeSync,
      
      // Hybrid backend indicators
      isHybridBackend: true,
      specStorageType: "github-issues",
      metadataStorageType: "sqlite",
    };
  }
}

/**
 * Factory function to create GitHub + SQLite hybrid backend
 */
export function createGitHubSqliteHybridBackend(
  options: GitHubSqliteHybridBackendOptions
): GitHubSqliteHybridBackend {
  return new GitHubSqliteHybridBackend(options);
}