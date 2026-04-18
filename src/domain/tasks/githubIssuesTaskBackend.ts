/**
 * GitHubIssuesTaskBackend implementation
 *
 * Integrates with GitHub Issues API to manage tasks as GitHub issues.
 * Implements the functional TaskBackend interface pattern.
 *
 * API operations are in ./github-issues-api.ts
 * Mapping/conversion utilities are in ./github-issues-mapping.ts
 */

import { Octokit } from "@octokit/rest";
import { join } from "path";
import { getErrorMessage } from "../../errors/index";
import type { TaskData, TaskSpecData, TaskBackendConfig } from "../../types/tasks/taskData";
import type { TaskReadOperationResult, TaskWriteOperationResult } from "../../types/tasks/taskData";
import type { TaskBackend } from "./types";
import { log } from "../../utils/logger";
import type { Task, TaskListOptions, CreateTaskOptions, DeleteTaskOptions } from "../tasks";
import { getTaskSpecRelativePath } from "./taskIO";

// API operations
import {
  fetchIssuesData,
  fetchTaskSpecData,
  syncTasksToGitHub,
  updateIssueStatus,
  updateIssueLabels,
  createIssueFromSpec,
  createIssueFromTitleAndDescription,
  createIssueFromTitleAndSpec,
  deleteIssue,
} from "./github-issues-api";

// Mapping / conversion utilities
import {
  parseGitHubIssues,
  formatGitHubTasks,
  parseGitHubTaskSpec,
  formatGitHubTaskSpec,
} from "./github-issues-mapping";

/**
 * Configuration for GitHubIssuesTaskBackend
 */
export interface GitHubIssuesTaskBackendOptions extends TaskBackendConfig {
  /** GitHub personal access token */
  githubToken: string;

  /** Repository owner (username or organization) */
  owner: string;

  /** Repository name */
  repo: string;

  /** Pre-configured Octokit instance (for testing / DI) */
  octokit?: Octokit;

  /** Override for label creation function (for testing / DI) */
  createGitHubLabelsFn?: (
    octokit: Octokit,
    owner: string,
    repo: string,
    statusLabels: Record<string, string>
  ) => Promise<void>;

  /** Labels to use for task status mapping */
  statusLabels?: {
    TODO: string;
    "IN-PROGRESS": string;
    "IN-REVIEW": string;
    DONE: string;
    BLOCKED: string;
    CLOSED: string;
  };
}

/**
 * Default status labels for GitHub issues
 */
const DEFAULT_STATUS_LABELS = {
  TODO: "minsky:todo",
  "IN-PROGRESS": "minsky:in-progress",
  "IN-REVIEW": "minsky:in-review",
  DONE: "minsky:done",
  BLOCKED: "minsky:blocked",
  CLOSED: "minsky:closed",
} as const;

/**
 * GitHubIssuesTaskBackend — thin orchestrator that delegates to API/mapping modules.
 */
export class GitHubIssuesTaskBackend implements TaskBackend {
  name = "github";
  prefix = "gh";
  private readonly workspacePath: string;
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly statusLabels: Record<string, string>;
  private readonly tasksDirectory: string;

  constructor(options: GitHubIssuesTaskBackendOptions) {
    this.workspacePath = options.workspacePath;
    this.owner = options.owner;
    this.repo = options.repo;
    this.statusLabels = { ...DEFAULT_STATUS_LABELS, ...options.statusLabels };
    this.tasksDirectory = join(this.workspacePath, "process", "tasks");

    this.octokit =
      options.octokit ??
      new Octokit({
        auth: options.githubToken,
        userAgent: "minsky-cli",
        request: { retries: 3, retryAfter: 30 },
      });

    // Auto-create labels (async, fire-and-forget)
    this.ensureLabelsExist(options.createGitHubLabelsFn);
  }

  private async ensureLabelsExist(
    createLabelsFn?: GitHubIssuesTaskBackendOptions["createGitHubLabelsFn"]
  ): Promise<void> {
    try {
      if (createLabelsFn) {
        await createLabelsFn(this.octokit, this.owner, this.repo, this.statusLabels);
      } else {
        const { createGitHubLabels } = await import("./githubBackendConfig");
        await createGitHubLabels(this.octokit, this.owner, this.repo, this.statusLabels);
      }
    } catch (error) {
      log.warn("Failed to ensure GitHub labels exist", {
        error: getErrorMessage(error as Error),
      });
    }
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    return fetchIssuesData(this.octokit, this.owner, this.repo);
  }

  async getTaskSpecData(specPath: string): Promise<TaskReadOperationResult> {
    return fetchTaskSpecData(this.octokit, this.owner, this.repo, specPath, this.statusLabels);
  }

  // ---- Pure Operations ----

  parseTasks(content: string): TaskData[] {
    return parseGitHubIssues(content, this.statusLabels, (id, title) =>
      this.getTaskSpecPath(id, title)
    );
  }

  formatTasks(tasks: TaskData[]): string {
    return formatGitHubTasks(tasks, this.statusLabels);
  }

  parseTaskSpec(content: string): TaskSpecData {
    return parseGitHubTaskSpec(content);
  }

  formatTaskSpec(spec: TaskSpecData): string {
    return formatGitHubTaskSpec(spec);
  }

  // ---- Side Effects ----

  async saveTasksData(content: string): Promise<TaskWriteOperationResult> {
    return syncTasksToGitHub(this.octokit, this.owner, this.repo, content);
  }

  async saveTaskSpecData(specPath: string, _content: string): Promise<TaskWriteOperationResult> {
    try {
      log.debug("GitHub backend: spec data managed through issues", { specPath });
      return { success: true };
    } catch (error) {
      log.error("Failed to save task spec data", {
        specPath,
        error: getErrorMessage(error as Error),
      });
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  // ---- Helper Methods ----

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getCapabilities(): import("./types").BackendCapabilities {
    return {
      canCreate: true,
      canUpdate: true,
      canDelete: true,
      canList: true,
      supportsTaskCreation: true,
      supportsTaskUpdate: true,
      supportsTaskDeletion: true,
      supportsStatus: true,
      supportsMetadata: true,
      supportsTags: true,
    };
  }

  getTaskSpecPath(taskId: string, title: string): string {
    return getTaskSpecRelativePath(taskId, title, this.workspacePath);
  }

  async fileExists(_path: string): Promise<boolean> {
    return true;
  }

  // ---- TaskBackend Interface Methods ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    try {
      const result = await this.getTasksData();
      if (!result.success || !result.content) {
        return [];
      }

      const taskDataList = this.parseTasks(result.content);
      let tasks = taskDataList.map((taskData) => ({
        id: taskData.id,
        title: taskData.title,
        status: taskData.status,
        specPath: taskData.specPath,
        spec: taskData.spec,
        tags: taskData.tags || [],
      }));

      if (options?.status && options.status !== "all") {
        tasks = tasks.filter((task) => task.status === options.status);
      } else if (!options?.all) {
        tasks = tasks.filter((task) => task.status !== "DONE" && task.status !== "CLOSED");
      }

      // Filter by tags if specified
      if (options?.tags && options.tags.length > 0) {
        tasks = tasks.filter((task) => options.tags!.every((tag) => task.tags?.includes(tag)));
      }

      return tasks;
    } catch (error) {
      log.error("Failed to list tasks", { error: getErrorMessage(error) });
      return [];
    }
  }

  async getTask(id: string): Promise<Task | null> {
    try {
      const tasks = await this.listTasks();
      return tasks.find((task) => task.id === id) || null;
    } catch (error) {
      log.error("Failed to get task", { id, error: getErrorMessage(error) });
      return null;
    }
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    try {
      const task = await this.getTask(id);
      return task?.status || undefined;
    } catch (error) {
      log.error("Failed to get task status", { id, error: getErrorMessage(error) });
      return undefined;
    }
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    await updateIssueStatus(this.octokit, this.owner, this.repo, id, status, this.statusLabels);
  }

  async createTask(specPath: string, _options?: CreateTaskOptions): Promise<Task> {
    const result = await this.getTaskSpecData(specPath);
    if (!result.success || !result.content) {
      throw new Error(`Failed to read task spec: ${specPath}`);
    }
    return createIssueFromSpec(
      this.octokit,
      this.owner,
      this.repo,
      result.content,
      specPath,
      this.statusLabels
    );
  }

  async createTaskFromTitleAndDescription(
    title: string,
    description: string,
    options: CreateTaskOptions = {}
  ): Promise<Task> {
    const task = await createIssueFromTitleAndDescription(
      this.octokit,
      this.owner,
      this.repo,
      title,
      description,
      this.statusLabels,
      options.tags
    );
    return { ...task, tags: options.tags || [] };
  }

  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options: CreateTaskOptions = {}
  ): Promise<Task> {
    const task = await createIssueFromTitleAndSpec(
      this.octokit,
      this.owner,
      this.repo,
      title,
      spec,
      this.statusLabels,
      options.tags
    );
    return { ...task, tags: options.tags || [] };
  }

  async updateTags(id: string, tags: string[]): Promise<void> {
    await updateIssueLabels(this.octokit, this.owner, this.repo, id, tags, this.statusLabels);
  }

  async deleteTask(id: string, _options?: DeleteTaskOptions): Promise<boolean> {
    return deleteIssue(this.octokit, this.owner, this.repo, id, this.statusLabels);
  }
}

/**
 * Create a new GitHubIssuesTaskBackend
 */
export function createGitHubIssuesTaskBackend(config: GitHubIssuesTaskBackendOptions): TaskBackend {
  return new GitHubIssuesTaskBackend(config);
}
