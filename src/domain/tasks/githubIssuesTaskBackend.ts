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
  TaskState,
  TaskSpecData,
  TaskBackendConfig,
} from "../../types/tasks/taskData.js";
import type {
  TaskReadOperationResult,
  TaskWriteOperationResult,
} from "../../types/tasks/taskData.js";
import type { TaskBackend } from "./taskBackend";
import { log } from "../../utils/logger";

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
    const sshMatch = remoteUrl.match(/git@github\.com:([^\/]+)\/([^\.]+)/);
    const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/([^\/]+)\/([^\.]+)/);

    const match = sshMatch || httpsMatch;
    if (match && match[1] && match[2]) {
      return {
        owner: match[1],
        repo: match[2].replace(/\.git$/, ""), // Remove .git suffix
      };
    }

    return null as any;
  } catch (error) {
    log.debug("Failed to extract GitHub repo from git remote", {
      workspacePath,
      error: getErrorMessage(error),
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
        error: getErrorMessage(error),
      });
    }
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    try {
      log.debug("Fetching GitHub issues", { owner: this.owner, repo: this.repo });

      // Fetch all issues with Minsky labels
      const labelQueries = Object.values(this.statusLabels).join(",");
      const response = await this.octokit.rest.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        labels: labelQueries,
        state: "all", // Get both open and closed issues
        per_page: 100, // Adjust as needed
      });

      const issues = response.data;
      log.debug(`Retrieved ${issues.length} issues from GitHub`, {
        owner: this.owner,
        repo: this.repo,
      });

      // Convert issues to a format that can be parsed by parseTasks
      const issueData = JSON.stringify(issues) as any;

      return {
        success: true,
        content: issueData,
      };
    } catch (error) {
      log.error("Failed to fetch GitHub issues", {
        owner: this.owner,
        repo: this.repo,
        error: getErrorMessage(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async getTaskSpecData(specPath: string): Promise<TaskReadOperationResult> {
    try {
      // For GitHub backend, spec data is typically embedded in issue descriptions
      // or linked to external files. For now, we'll generate basic spec content
      // from the issue data.

      // Extract task ID from spec path
      const pathParts = specPath.split("/");
      const fileName = pathParts[pathParts.length - 1];
      const taskIdMatch = fileName?.match(/^(\d+)-/);

      if (!taskIdMatch || !taskIdMatch[1]) {
        throw new Error(`Invalid spec path format: ${specPath}`);
      }

      const taskId = `#${taskIdMatch[1]}`;

      // Try to find the corresponding GitHub issue
      const response = await this.octokit.rest.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        labels: Object.values(this.statusLabels).join(",") as any,
        state: "all",
      }) as any;

      const issue = response.data.find((issue) => {
        // Look for issue with matching task ID in title or body
        return issue.title.includes(taskId) || issue.body?.includes(taskId);
      });

      if (!issue) {
        return {
          success: false,
          error: new Error(`No GitHub issue found for task ${taskId}`),
        };
      }

      // Generate spec content from issue
      const specContent = `# Task ${taskId}: ${issue.title}

## Status
${this.getTaskStatusFromIssue(issue)}

## Description
${issue.body || "No description provided"}

## GitHub Issue
- Issue: #${issue.number}
- URL: ${issue.html_url}
- State: ${issue.state}
- Created: ${issue.created_at}
- Updated: ${issue.updated_at}

## Labels
${issue.labels.map((label) => `- ${typeof label === "string" ? label : label.name}`).join("\n")}
`;

      return {
        success: true,
        content: specContent,
      };
    } catch (error) {
      log.error("Failed to get task spec data from GitHub", {
        specPath,
        error: getErrorMessage(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  // ---- Pure Operations ----

  parseTasks(content: string): TaskData[] {
    try {
      const issues = JSON.parse(content);
      return issues.map((issue: any) => this.convertIssueToTaskData(issue));
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
    return JSON.stringify(tasks.map((task) => this.convertTaskDataToIssueFormat(task)));
  }

  parseTaskSpec(content: string): TaskSpecData {
    // Parse markdown content to extract task specification
    const lines = (content).toString().split("\n");
    let title = "";
    let description = "";
    let metadata: Record<string, any> = {};

    let currentSection = "";
    let descriptionLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("# ")) {
        title = trimmed.substring(2).trim();
        // Extract task ID from title if present
        const taskIdMatch = title.match(/^Task (#\d+):/);
        if (taskIdMatch) {
          metadata.taskId = taskIdMatch[1];
          title = title.substring(taskIdMatch[0].length).trim();
        }
      } else if (trimmed.startsWith("## ")) {
        currentSection = trimmed.substring(3).trim().toLowerCase();
        if (currentSection === "description") {
          descriptionLines = [];
        }
      } else if (currentSection === "description" && trimmed) {
        descriptionLines.push(trimmed);
      }
    }

    description = descriptionLines.join("\n");

    return {
      title,
      description,
      metadata,
    };
  }

  formatTaskSpec(spec: TaskSpecData): string {
    const { title, description, metadata } = spec;

    let content = `# Task ${metadata?.taskId || "#000"}: ${title}\n\n`;

    if (description) {
      content += `## Description\n${description}\n\n`;
    }

    // Add GitHub-specific metadata if available
    if (metadata?.githubIssue) {
      const githubIssue = metadata.githubIssue as any;
      content += "## GitHub Issue\n";
      content += `- Issue: #${githubIssue.number}\n`;
      content += `- URL: ${githubIssue.html_url}\n`;
      content += `- State: ${githubIssue.state}\n\n`;
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
        error: getErrorMessage(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
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
        error: getErrorMessage(error),
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

  getTaskSpecPath(taskId: string, title: string): string {
    const id = taskId.startsWith("#") ? taskId.slice(1) : taskId;
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return join("process", "tasks", `${id}-${normalizedTitle}.md`);
  }

  async fileExists(_path: string): Promise<boolean> {
    // For GitHub backend, we always return true since we don't check local files
    // TODO: Implement actual GitHub issue existence check
    return true;
  }

  // ---- Private Helper Methods ----

  private convertIssueToTaskData(issue: any): TaskData {
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
      title: task.title,
      body: task.description,
      labels: this.getLabelsForTaskStatus(task.status),
      state: task.status === "DONE" ? "closed" : "open",
    };
  }

  private extractTaskIdFromIssue(issue: any): string {
    // Try to extract task ID from title or body
    const titleMatch = issue.title.match(/#(\d+)/);
    if (titleMatch) {
      return `#${titleMatch[1]}`;
    }

    const bodyMatch = issue.body?.match(/#(\d+)/);
    if (bodyMatch) {
      return `#${bodyMatch[1]}`;
    }

    // Fallback to issue number
    return `#${issue.number}`;
  }

  private getTaskStatusFromIssue(issue: any): string {
    // Check labels for status
    const labels = issue.labels || [];

    for (const [status, labelName] of Object.entries(this.statusLabels)) {
      if (
        labels.some((label: any) => {
          const name = typeof label === "string" ? label : label.name;
          return name === labelName;
        })
      ) {
        return status;
      }
    }

    // Fallback based on issue state
    return issue.state === "closed" ? "DONE" : "TODO";
  }

  private getLabelsForTaskStatus(status: string): string[] {
    const statusLabel = this.statusLabels[status];
    return statusLabel ? [statusLabel] : [];
  }

  private async syncTaskToGitHub(taskData: TaskData): Promise<void> {
    try {
      const issueData = this.convertTaskDataToIssueFormat(taskData);

      // For now, we'll always create new issues since we can't track existing ones without metadata
      // TODO: Implement a better way to track GitHub issue numbers
      const response = await this.octokit.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title: issueData.title,
        body: issueData.body,
        labels: issueData.labels,
      });

      log.debug("Created GitHub issue", {
        issueNumber: response.data.number,
        title: issueData.title,
      });
    } catch (error) {
      log.error("Failed to sync task to GitHub", {
        taskId: taskData.id,
        error: getErrorMessage(error),
      });
      throw error;
    }
  }
}

/**
 * Create a new GitHubIssuesTaskBackend
 * @param config Backend configuration
 * @returns GitHubIssuesTaskBackend instance
 */
export function createGitHubIssuesTaskBackend(config: GitHubIssuesTaskBackendOptions): TaskBackend {
  return new GitHubIssuesTaskBackend(config);
}
