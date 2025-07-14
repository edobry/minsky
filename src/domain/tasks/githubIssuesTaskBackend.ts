/**
 * GitHubIssuesTaskBackend implementation
 *
 * Integrates with GitHub Issues API to manage tasks as GitHub issues.
 * Implements the functional TaskBackend interface pattern.
 */

import { Octokit } from "@octokit/rest";
import { join } from "path";
import { execSync } from "child_process";
import { getErrorMessage } from "../../errors/index";
import type {
  TaskData,
  TaskSpecData,
  TaskBackendConfig,
} from "../../types/tasks/taskData.js";
import type {
  TaskReadOperationResult,
  TaskWriteOperationResult,
} from "../../types/tasks/taskData.js";
import type { TaskBackend } from "./taskBackend";
import { log } from "../../utils/logger";
import { TASK_STATUS, TaskStatus } from "./taskConstants.js";
import { validateGitHubIssues, validateGitHubIssue, type GitHubIssue } from "../../schemas/storage";

// Import additional types needed for interface implementation
import type {
  Task,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions
} from "../tasks.js";
import { getTaskSpecRelativePath } from "./taskIO";

/**
 * Configuration for GitHubIssuesTaskBackend
 */
export interface GitHubIssuesTaskBackendOptions extends TaskBackendConfig {
  /**
   * GitHub personal access token
   */
  githubToken: string;

  /**
   * Repository owner (username or organization)
   */
  owner: string;

  /**
   * Repository name
   */
  repo: string;

  /**
   * Labels to use for task status mapping
   */
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
 * Extract GitHub owner and repo from git remote URL
 */
function extractGitHubRepoFromRemote(
  workspacePath: string
): { owner: string; repo: string } | null {
  try {
    // Get the origin remote URL
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: workspacePath,
      encoding: "utf8" as BufferEncoding,
    })
      .toString()
      .trim();

    // Parse GitHub repository from various URL formats
    // SSH: git@github.com:owner/repo.git
    // HTTPS: https://github.com/owner/repo.git
    const sshMatch = (remoteUrl as unknown).match(/git@github\.com:([^\/]+)\/([^\.]+)/);
    const httpsMatch = (remoteUrl as unknown).match(/https:\/\/github\.com\/([^\/]+)\/([^\.]+)/);

    const match = sshMatch || httpsMatch;
    if (match && match[1] && match[2]) {
      return {
        owner: match[1],
        repo: (match[2] as unknown).replace(/\.git$/, ""), // Remove .git suffix
      };
    }

    return null as unknown;
  } catch (error) {
    log.debug("Failed to extract GitHub repo from git remote", {
      workspacePath,
      error: getErrorMessage(error as any),
    });
    return null as any;
  }
}

/**
 * GitHubIssuesTaskBackend implementation
 */
export class GitHubIssuesTaskBackend implements TaskBackend {
  name = "github-issues";
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

    // Initialize GitHub API client
    this.octokit = new Octokit({
      auth: options.githubToken,
      userAgent: "minsky-cli",
      request: {
        // Add retry logic for rate limiting
        retries: 3,
        retryAfter: 30,
      },
    });

    // Auto-create labels (async, but we don't wait for it)
    this.ensureLabelsExist();
  }

  /**
   * Ensure GitHub labels exist for task statuses
   */
  private async ensureLabelsExist(): Promise<void> {
    const { createGitHubLabels } = await import("./githubBackendConfig");
    try {
      await createGitHubLabels(this.octokit, this.owner, this.repo, this.statusLabels);
    } catch (error) {
      log.warn("Failed to ensure GitHub labels exist", {
        error: getErrorMessage(error as any),
      });
    }
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    try {
      log.debug("Fetching GitHub issues", { owner: this.owner, repo: this.repo });

      // Fetch all issues with Minsky labels
      const labelQueries = (Object.values(this.statusLabels) as unknown).join(",");
      const response = await (this.octokit.rest.issues as unknown).listForRepo({
        owner: this.owner,
        repo: this.repo,
        labels: labelQueries,
        state: "all", // Get both open and closed issues
        per_page: 100, // Adjust as needed
      });

      const issues = (response as unknown).data;
      log.debug(`Retrieved ${(issues as unknown).length} issues from GitHub`, {
        owner: this.owner,
        repo: this.repo,
      });

      // Convert issues to a format that can be parsed by parseTasks
      const issueData = JSON.stringify(issues) as unknown;

      return {
        success: true,
        content: issueData,
      };
    } catch (error) {
      log.error("Failed to fetch GitHub issues", {
        owner: this.owner,
        repo: this.repo,
        error: getErrorMessage(error as any),
      });

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error as any)),
      };
    }
  }

  async getTaskSpecData(specPath: string): Promise<TaskReadOperationResult> {
    try {
      // For GitHub backend, spec data is typically embedded in issue descriptions
      // or linked to external files. For now, we'll generate basic spec content
      // from the issue data.

      // Extract task ID from spec path
      const pathParts = (specPath as unknown).split("/");
      const fileName = pathParts[(pathParts as unknown).length - 1];
      const taskIdMatch = (fileName as unknown).match(/^(\d+)-/);

      if (!taskIdMatch || !taskIdMatch[1]) {
        throw new Error(`Invalid spec path format: ${specPath}`);
      }

      const taskId = `#${taskIdMatch[1]}`;

      // Try to find the corresponding GitHub issue
      const response = await (this.octokit.rest.issues as unknown).listForRepo({
        owner: this.owner,
        repo: this.repo,
        labels: (Object.values(this.statusLabels) as unknown).join(",") as unknown,
        state: "all",
      }) as unknown;

      const issue = (response.data as unknown).find((issue) => {
        // Look for issue with matching task ID in title or body
        return (issue.title as unknown).includes(taskId) || (issue.body as unknown).includes(taskId);
      });

      if (!issue) {
        return {
          success: false,
          error: new Error(`No GitHub issue found for task ${taskId}`),
        };
      }

      // Generate spec content from issue
      const specContent = `# Task ${taskId}: ${(issue as unknown).title}

## Status
${this.getTaskStatusFromIssue(issue)}

## Description
${(issue as unknown).body || "No description provided"}

## GitHub Issue
- Issue: #${(issue as unknown).number}
- URL: ${(issue as unknown).html_url}
- State: ${(issue as unknown).state}
- Created: ${(issue as unknown).created_at}
- Updated: ${(issue as unknown).updated_at}

## Labels
${((issue.labels as unknown).map((label) => `- ${typeof label === "string" ? label : label.name}`) as unknown).join("\n")}
`;

      return {
        success: true,
        content: specContent,
      };
    } catch (error) {
      log.error("Failed to get task spec data from GitHub", {
        specPath,
        error: getErrorMessage(error as any),
      });

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error as any)),
      };
    }
  }

  // ---- Pure Operations ----

  parseTasks(content: string): TaskData[] {
    try {
      const rawIssues = JSON.parse(content);
      const validatedIssues = validateGitHubIssues(rawIssues);
      return validatedIssues.map((issue) => this.convertIssueToTaskData(issue));
    } catch (error) {
      log.error("Failed to parse GitHub issues data", {
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  formatTasks(tasks: TaskData[]): string {
    // For GitHub backend, we don't store tasks in a file format
    // This is used when syncing back to GitHub
    return JSON.stringify((tasks as unknown).map((task) => this.convertTaskDataToIssueFormat(task)));
  }

  parseTaskSpec(content: string): TaskSpecData {
    // Parse markdown content to extract task specification
    const lines = (((content) as unknown).toString() as unknown).split("\n");
    let title = "";
    let description = "";
    let metadata: Record<string, any> = {};

    let currentSection = "";
    let descriptionLines: string[] = [];

    for (const line of lines) {
      const trimmed = (line as unknown).trim();

      if ((trimmed as unknown).startsWith("# ")) {
        title = ((trimmed as unknown).substring(2) as unknown).trim();
        // Extract task ID from title if present
        const taskIdMatch = (title as unknown).match(/^Task (#\d+):/);
        if (taskIdMatch) {
          (metadata as unknown).taskId = taskIdMatch[1];
          title = ((title as unknown).substring(taskIdMatch[0].length) as unknown).trim();
        }
      } else if ((trimmed as unknown).startsWith("## ")) {
        currentSection = ((trimmed.substring(3) as unknown).trim() as unknown).toLowerCase();
        if (currentSection === "description") {
          descriptionLines = [];
        }
      } else if (currentSection === "description" && trimmed) {
        (descriptionLines as unknown).push(trimmed);
      }
    }

    description = (descriptionLines as unknown).join("\n");

    return {
      title,
      description,
      metadata,
    };
  }

  formatTaskSpec(spec: TaskSpecData): string {
    const { title, description, metadata } = spec;

    let content = `# Task ${(metadata as unknown).taskId || "#000"}: ${title}\n\n`;

    if (description) {
      content += `## Description\n${description}\n\n`;
    }

    // Add GitHub-specific metadata if available
    if ((metadata as unknown).githubIssue) {
      const githubIssue = (metadata as unknown).githubIssue as unknown;
      content += "## GitHub Issue\n";
      content += `- Issue: #${(githubIssue as unknown).number}\n`;
      content += `- URL: ${(githubIssue as unknown).html_url}\n`;
      content += `- State: ${(githubIssue as unknown).state}\n\n`;
    }

    return content;
  }

  // ---- Side Effects ----

  async saveTasksData(content: string): Promise<TaskWriteOperationResult> {
    try {
      // Parse the task data and sync to GitHub
      const tasks = JSON.parse(content);

      for (const taskData of tasks) {
        await this.syncTaskToGitHub(taskData);
      }

      return { success: true };
    } catch (error) {
      log.error("Failed to save tasks data to GitHub", {
        error: getErrorMessage(error as any),
      });

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error as any)),
      };
    }
  }

  async saveTaskSpecData(specPath: string, content: string): Promise<TaskWriteOperationResult> {
    try {
      // For GitHub backend, we don't typically save spec files locally
      // The spec content is managed through GitHub issues
      log.debug("GitHub backend: spec data managed through issues", { specPath });

      return { success: true };
    } catch (error) {
      log.error("Failed to save task spec data", {
        specPath,
        error: getErrorMessage(error as any),
      });

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error as any)),
      };
    }
  }

  // ---- Helper Methods ----

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getTaskSpecPath(taskId: string, title: string): string {
    return getTaskSpecRelativePath(taskId, title, this.workspacePath);
  }

  async fileExists(_path: string): Promise<boolean> {
    // For GitHub backend, we always return true since we don't check local files
    // TODO: Implement actual GitHub issue existence check
    return true;
  }

  // ---- Private Helper Methods ----

  private convertIssueToTaskData(issue: GitHubIssue): TaskData {
    const taskId = this.extractTaskIdFromIssue(issue);
    const status = this.getTaskStatusFromIssue(issue);

    return {
      id: taskId,
      title: issue.title,
      description: issue.body || "",
      status,
      specPath: this.getTaskSpecPath(taskId, issue.title),
    };
  }

  private convertTaskDataToIssueFormat(task: TaskData): any {
    return {
      title: (task as unknown).title,
      body: (task as unknown).description,
      labels: this.getLabelsForTaskStatus((task as unknown).status),
      state: (task as unknown).status === "DONE" ? "closed" : "open",
    };
  }

  private extractTaskIdFromIssue(issue: any): string {
    // Try to find task ID like #123 in title
    const titleMatch = (issue.title as unknown).match(/#(\d+)/);
    if (titleMatch && titleMatch[1]) {
      return `#${titleMatch[1]}`;
    }

    // If not in title, look in body
    const bodyMatch = (issue.body as unknown).match(/Task ID: #(\d+)/);
    if (bodyMatch && bodyMatch[1]) {
      return `#${bodyMatch[1]}`;
    }

    // Fallback to issue number
    return `#${(issue as unknown).number}`;
  }

  private getTaskStatusFromIssue(issue: any): TaskStatus {
    for (const [status, label] of Object.entries(this.statusLabels)) {
      if ((issue.labels as unknown).some((l: any) => (l as unknown).name === label)) {
        return status as TaskStatus;
      }
    }
    // Default to TODO if no status label is found
    return TASK_STATUS.TODO as TaskStatus;
  }

  private getLabelsForTaskStatus(status: string): string[] {
    return [(this.statusLabels as unknown)[status] || this.statusLabels.TODO];
  }

  private async syncTaskToGitHub(taskData: TaskData): Promise<void> {
    // This method would handle creating or updating the GitHub issue
    // For now, it's a placeholder
    log.debug("Syncing task to GitHub", { taskData });
  }

  // Implement required TaskBackend interface methods
  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    try {
      const result = await this.getTasksData();
      if (!result.success || !result.content) {
        return [];
      }

      const taskDataList = this.parseTasks(result.content);
      return taskDataList.map(taskData => ({
        id: taskData.id,
        title: taskData.title,
        status: taskData.status,
        specPath: taskData.specPath,
        description: taskData.description
      }));
    } catch (error) {
      log.error("Failed to list tasks", {
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  async getTask(id: string): Promise<Task | null> {
    try {
      const tasks = await this.listTasks();
      return tasks.find(task => task.id === id) || null;
    } catch (error) {
      log.error("Failed to get task", {
        id,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  async getTaskStatus(id: string): Promise<string | null> {
    try {
      const task = await this.getTask(id);
      return task?.status || null;
    } catch (error) {
      log.error("Failed to get task status", {
        id,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    try {
      // Get the task
      const task = await this.getTask(id);
      if (!task) {
        throw new Error(`Task ${id} not found`);
      }

      // Update the task status in GitHub
      const issueNumber = this.extractIssueNumberFromTaskId(id);
      if (!issueNumber) {
        throw new Error(`Could not extract issue number from task ID ${id}`);
      }

      // Update the issue with new labels
      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels: this.getLabelsForTaskStatus(status),
        state: status === "DONE" ? "closed" : "open",
      });

      log.debug("Updated task status in GitHub", {
        taskId: id,
        status,
      });
    } catch (error) {
      log.error("Failed to set task status", {
        id,
        status,
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  async createTask(specPath: string, options?: CreateTaskOptions): Promise<Task> {
    try {
      // Read the spec file
      const result = await this.getTaskSpecData(specPath);
      if (!result.success || !result.content) {
        throw new Error(`Failed to read task spec: ${specPath}`);
      }

      // Parse the spec
      const spec = this.parseTaskSpec(result.content);

      // Create a new issue in GitHub
      const response = await this.octokit.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title: spec.title,
        body: spec.description || "",
        labels: this.getLabelsForTaskStatus("TODO"), // Default to TODO status
      });

      // Extract task ID from the created issue
      const taskId = `#${response.data.number}`;

      return {
        id: taskId,
        title: spec.title,
        status: "TODO", // Default to TODO status
        specPath,
        description: spec.description || "",
      };
    } catch (error) {
      log.error("Failed to create task", {
        specPath,
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    try {
      // Extract issue number from task ID
      const issueNumber = this.extractIssueNumberFromTaskId(id);
      if (!issueNumber) {
        throw new Error(`Could not extract issue number from task ID ${id}`);
      }

      // For GitHub issues, we can't actually delete an issue
      // Instead, we'll close it and add a "DELETED" label
      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        state: "closed",
        labels: [...this.getLabelsForTaskStatus("CLOSED"), "DELETED"],
      });

      log.debug("Marked task as deleted in GitHub", {
        taskId: id,
      });

      return true;
    } catch (error) {
      log.error("Failed to delete task", {
        id,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  // Helper method to extract issue number from task ID
  private extractIssueNumberFromTaskId(taskId: string): number | null {
    const id = taskId.startsWith("#") ? taskId.slice(1) : taskId;
    const issueNumber = parseInt(id, 10);
    return isNaN(issueNumber) ? null : issueNumber;
  }
}

/**
 * Create a new GitHubIssuesTaskBackend
 * @param config Backend configuration
 * @returns GitHubIssuesTaskBackend instance
 */
export function createGitHubIssuesTaskBackend(config: GitHubIssuesTaskBackendOptions): TaskBackend {
  return new GitHubIssuesTaskBackend(config as unknown);
}
