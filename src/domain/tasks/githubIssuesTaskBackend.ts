import { Octokit } from "@octokit/rest";
import type {
  TaskBackend,
  Task,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
  BackendCapabilities,
  TaskMetadata,
} from "./types";

export interface GitHubTaskBackendConfig {
  token: string;
  owner: string;
  repo: string;
  workspacePath: string;
}

export class GitHubIssuesTaskBackend implements TaskBackend {
  name = "github-issues";
  private readonly github: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly workspacePath: string;

  constructor(config: GitHubTaskBackendConfig) {
    this.github = new Octokit({
      auth: config.token,
    });
    this.owner = config.owner;
    this.repo = config.repo;
    this.workspacePath = config.workspacePath;
  }

  // ---- User-Facing Operations ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    try {
      const response = await this.github.rest.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: "all",
        per_page: 100,
      });

      let tasks = response.data.map(this.mapIssueToTask.bind(this));

      // Apply filters
      if (options?.status && options.status !== "all") {
        tasks = tasks.filter((task) => task.status === options.status);
      }
      if (options?.backend) {
        tasks = tasks.filter((task) => task.backend === options.backend);
      }

      return tasks;
    } catch (error) {
      throw new Error(
        `Failed to list GitHub issues: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  async getTask(id: string): Promise<Task | null> {
    try {
      const issueNumber = this.extractIssueNumber(id);
      if (!issueNumber) {
        return null;
      }

      const response = await this.github.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
      });

      return this.mapIssueToTask(response.data);
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 404) {
        return null;
      }
      throw new Error(
        `Failed to get GitHub issue: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    try {
      const issueNumber = this.extractIssueNumber(id);
      if (!issueNumber) {
        throw new Error(`Invalid task ID: ${id}`);
      }

      const githubState = this.mapStatusToGitHubState(status);
      const labels = this.mapStatusToLabels(status);

      await this.github.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        state: githubState,
        labels: labels,
      });
    } catch (error) {
      throw new Error(
        `Failed to set status: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    try {
      const response = await this.octokit.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body: spec,
        labels: ["TODO"],
      });

      return {
        id: `gh#${response.data.number}`,
        title: response.data.title,
        status: "TODO",
        backend: this.name,
      };
    } catch (error) {
      throw new Error(
        `Failed to create GitHub issue: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    // GitHub doesn't support deleting issues, so we close them instead
    try {
      const issueNumber = this.extractIssueNumber(id);
      if (!issueNumber) {
        return false;
      }

      await this.github.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        state: "closed",
        labels: ["CLOSED"],
      });

      return true;
    } catch (error) {
      return false;
    }
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getCapabilities(): BackendCapabilities {
    return {
      canCreate: true,
      canUpdate: true,
      canDelete: false, // GitHub doesn't support deleting issues
      canList: true,
      supportsMetadata: true,
      supportsSearch: true,
    };
  }

  // ---- Optional Metadata Methods ----

  async getTaskMetadata(id: string): Promise<TaskMetadata | null> {
    try {
      const issueNumber = this.extractIssueNumber(id);
      if (!issueNumber) {
        return null;
      }

      const response = await this.github.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
      });

      const issue = response.data;
      return {
        id,
        title: issue.title,
        spec: issue.body || "",
        status: this.mapGitHubStateToStatus(issue.state, issue.labels),
        backend: "github-issues",
        createdAt: new Date(issue.created_at),
        updatedAt: new Date(issue.updated_at),
      };
    } catch (error) {
      return null;
    }
  }

  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    try {
      const issueNumber = this.extractIssueNumber(id);
      if (!issueNumber) {
        throw new Error(`Invalid task ID: ${id}`);
      }

      const githubState = this.mapStatusToGitHubState(metadata.status);
      const labels = this.mapStatusToLabels(metadata.status);

      await this.github.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        title: metadata.title,
        body: metadata.spec,
        state: githubState,
        labels: labels,
      });
    } catch (error) {
      throw new Error(
        `Failed to set metadata: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  // ---- Internal Helper Methods ----

  private mapIssueToTask(issue: any): Task {
    const id = `gh#${issue.number}`;
    return {
      id,
      title: issue.title,
      description: issue.body || "",
      status: this.mapGitHubStateToStatus(issue.state, issue.labels),
      specPath: issue.html_url,
      backend: "github-issues",
    };
  }

  private extractIssueNumber(id: string): number | null {
    const match = id.match(/^gh#(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }

  private mapGitHubStateToStatus(state: string, labels: any[]): string {
    if (state === "closed") {
      return "DONE";
    }

    // Check labels for more specific status
    const labelNames = labels
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter(Boolean);

    if (labelNames.includes("IN-PROGRESS")) return "IN-PROGRESS";
    if (labelNames.includes("IN-REVIEW")) return "IN-REVIEW";
    if (labelNames.includes("BLOCKED")) return "BLOCKED";
    if (labelNames.includes("CLOSED")) return "CLOSED";

    return "TODO";
  }

  private mapStatusToGitHubState(status: string): "open" | "closed" {
    return status === "DONE" || status === "CLOSED" ? "closed" : "open";
  }

  private mapStatusToLabels(status: string): string[] {
    switch (status) {
      case "TODO":
        return ["TODO"];
      case "IN-PROGRESS":
        return ["IN-PROGRESS"];
      case "IN-REVIEW":
        return ["IN-REVIEW"];
      case "DONE":
        return ["DONE"];
      case "BLOCKED":
        return ["BLOCKED"];
      case "CLOSED":
        return ["CLOSED"];
      default:
        return ["TODO"];
    }
  }
}

export function createGitHubIssuesTaskBackend(
  config: GitHubTaskBackendConfig
): GitHubIssuesTaskBackend {
  return new GitHubIssuesTaskBackend(config);
}
