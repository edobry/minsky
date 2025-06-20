/**
 * GoogleTasksBackend implementation
 *
 * Integrates with Google Tasks API to manage tasks.
 * Implements the functional TaskBackend interface pattern.
 */

import { google, tasks_v1 } from "googleapis";
import { join } from "path";
import { readFile, writeFile, mkdir, access } from "fs/promises";
import type { TaskData, TaskSpecData, TaskBackendConfig } from "../../types/tasks/taskData.js";
import type {
  TaskReadOperationResult,
  TaskWriteOperationResult,
} from "../../types/tasks/taskData.js";
import type { TaskBackend } from "./taskBackend";
import { log } from "../../utils/logger";

/**
 * Configuration for GoogleTasksBackend
 */
export interface GoogleTasksBackendOptions extends TaskBackendConfig {
  /**
   * Google OAuth 2.0 client ID
   */
  clientId: string;

  /**
   * Google OAuth 2.0 client secret
   */
  clientSecret: string;

  /**
   * OAuth 2.0 redirect URI
   */
  redirectUri?: string;

  /**
   * Path to store tokens
   */
  tokenPath?: string;

  /**
   * Default task list ID to use
   */
  taskListId?: string;

  /**
   * Scopes required for Google Tasks API
   */
  scopes?: string[];
}

/**
 * Default scopes required for Google Tasks API
 */
const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/tasks"];

/**
 * Default redirect URI for OAuth flow
 */
const DEFAULT_REDIRECT_URI = "http://localhost:3000/oauth2callback";

/**
 * Reverse status mapping from Google Tasks to Minsky
 */
const REVERSE_STATUS_MAPPING: Record<string, string> = {
  needsAction: "TODO",
  completed: "DONE",
};

/**
 * GoogleTasksBackend implementation
 */
export class GoogleTasksBackend implements TaskBackend {
  name = "google-tasks";
  private readonly workspacePath: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly tokenPath: string;
  private readonly taskListId?: string;
  private readonly scopes: string[];
  private oauth2Client: InstanceType<typeof google.auth.OAuth2>;
  private tasksService: tasks_v1.Tasks | null = null;
  private tasksData: TaskData[] = [];
  private taskSpecs: Map<string, TaskSpecData> = new Map();

  constructor(options: GoogleTasksBackendOptions) {
    this.workspacePath = options.workspacePath;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri || DEFAULT_REDIRECT_URI;
    this.tokenPath = options.tokenPath || join(this.workspacePath, ".google-tasks-tokens.json");
    this.taskListId = options.taskListId;
    this.scopes = options.scopes || DEFAULT_SCOPES;

    // Initialize OAuth2 client
    this.oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);

    // Try to load existing tokens
    this.loadTokens();
  }

  // ---- Data Retrieval ----

  async getTasksData(): Promise<TaskReadOperationResult> {
    try {
      await this.ensureAuthenticated();
      await this.loadTasksFromGoogle();

      const content = this.formatTasks(this.tasksData);
      return {
        success: true,
        content,
        filePath: "google-tasks-cache",
      };
    } catch (error) {
      log.error("Failed to get tasks data from Google Tasks", { error });
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        filePath: "google-tasks-cache",
      };
    }
  }

  async getTaskSpecData(specPath: string): Promise<TaskReadOperationResult> {
    try {
      // Check local cache first
      const cachedSpec = this.taskSpecs.get(specPath);
      if (cachedSpec) {
        return {
          success: true,
          content: this.formatTaskSpec(cachedSpec),
          filePath: specPath,
        };
      }

      // Try to read from local file system
      try {
        const content = await readFile(specPath, "utf-8");
        return {
          success: true,
          content: content as string,
          filePath: specPath,
        };
      } catch {
        // File doesn't exist, return empty spec
        const emptySpec: TaskSpecData = {
          title: "",
          description: "",
        };

        return {
          success: true,
          content: this.formatTaskSpec(emptySpec),
          filePath: specPath,
        };
      }
    } catch (error) {
      log.error("Failed to get task spec data", { specPath, error });
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        filePath: specPath,
      };
    }
  }

  // ---- Pure Operations ----

  parseTasks(content: string): TaskData[] {
    try {
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        return data.map(this.normalizeTaskData);
      }
      return [];
    } catch (error) {
      log.error("Failed to parse tasks content", { error });
      return [];
    }
  }

  formatTasks(tasks: TaskData[]): string {
    return JSON.stringify(tasks, null, 2);
  }

  parseTaskSpec(content: string): TaskSpecData {
    try {
      // Try JSON first
      return JSON.parse(content);
    } catch {
      // Fall back to markdown-like parsing
      const lines = content.split("\n");
      const spec: TaskSpecData = {
        title: "",
        description: "",
        metadata: {
          requirements: [],
          acceptanceCriteria: [],
        },
      };

      let currentSection = "";
      const requirements: string[] = [];
      const acceptanceCriteria: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("# ")) {
          spec.title = trimmed.substring(2);
        } else if (trimmed.startsWith("## Summary") || trimmed.startsWith("## Description")) {
          currentSection = "description";
        } else if (trimmed.startsWith("## Requirements")) {
          currentSection = "requirements";
        } else if (trimmed.startsWith("## Acceptance Criteria")) {
          currentSection = "acceptanceCriteria";
        } else if (trimmed.startsWith("- ") && currentSection === "requirements") {
          requirements.push(trimmed.substring(2));
        } else if (trimmed.startsWith("- ") && currentSection === "acceptanceCriteria") {
          acceptanceCriteria.push(trimmed.substring(2));
        } else if (currentSection === "description" && trimmed) {
          spec.description += (spec.description ? "\n" : "") + trimmed;
        }
      }

      if (requirements.length > 0) {
        spec.metadata!.requirements = requirements;
      }
      if (acceptanceCriteria.length > 0) {
        spec.metadata!.acceptanceCriteria = acceptanceCriteria;
      }

      return spec;
    }
  }

  formatTaskSpec(spec: TaskSpecData): string {
    return JSON.stringify(spec, null, 2);
  }

  // ---- Side Effects ----

  async saveTasksData(content: string): Promise<TaskWriteOperationResult> {
    try {
      await this.ensureAuthenticated();

      // For now, just return success - full sync implementation would go here
      // TODO: Parse content and sync tasks to Google Tasks API
      log.warn("Google Tasks sync is not fully implemented yet", { contentLength: content.length });

      return {
        success: true,
        filePath: "google-tasks-cache",
      };
    } catch (error) {
      log.error("Failed to save tasks data to Google Tasks", { error });
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        filePath: "google-tasks-cache",
      };
    }
  }

  async saveTaskSpecData(specPath: string, content: string): Promise<TaskWriteOperationResult> {
    try {
      const spec = this.parseTaskSpec(content);
      this.taskSpecs.set(specPath, spec);

      // Also save to local file system
      await this.ensureDirectoryExists(specPath);
      await writeFile(specPath, content, "utf-8");

      return {
        success: true,
        filePath: specPath,
      };
    } catch (error) {
      log.error("Failed to save task spec data", { specPath, error });
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
        filePath: specPath,
      };
    }
  }

  // ---- Helper Methods ----

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getTaskSpecPath(taskId: string, title: string): string {
    const sanitizedTitle = title.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
    return join(this.workspacePath, "process", "tasks", `${taskId}-${sanitizedTitle}.md`);
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  // ---- Private Methods ----

  private async ensureAuthenticated(): Promise<void> {
    if (!this.tasksService) {
      if (!this.oauth2Client.credentials.access_token) {
        throw new Error("Not authenticated with Google Tasks. Please run authentication flow.");
      }

      this.tasksService = google.tasks({ version: "v1", auth: this.oauth2Client });
    }
  }

  private async loadTokens(): Promise<void> {
    try {
      const content = await readFile(this.tokenPath, "utf-8");
      const tokens = JSON.parse(content as string);
      this.oauth2Client.setCredentials(tokens);
      log.debug("Loaded Google Tasks tokens", { tokenPath: this.tokenPath });
    } catch {
      log.debug("No existing tokens found", { tokenPath: this.tokenPath });
    }
  }

  private async saveTokens(): Promise<void> {
    try {
      const tokens = this.oauth2Client.credentials;
      await this.ensureDirectoryExists(this.tokenPath);
      await writeFile(this.tokenPath, JSON.stringify(tokens, null, 2), "utf-8");
      log.debug("Saved Google Tasks tokens", { tokenPath: this.tokenPath });
    } catch (error) {
      log.error("Failed to save tokens", { error, tokenPath: this.tokenPath });
    }
  }

  private async loadTasksFromGoogle(): Promise<void> {
    if (!this.tasksService) {
      throw new Error("Tasks service not initialized");
    }

    try {
      // Get task lists
      const taskListsResponse = await this.tasksService.tasklists.list();
      const taskLists = taskListsResponse.data.items || [];

      if (taskLists.length === 0) {
        log.warn("No Google Tasks lists found");
        this.tasksData = [];
        return;
      }

      // Use specified task list or first available
      const targetTaskList = this.taskListId
        ? taskLists.find((list) => list.id === this.taskListId)
        : taskLists[0];

      if (!targetTaskList?.id) {
        throw new Error(`Task list not found: ${this.taskListId || "default"}`);
      }

      // Get tasks from the target list
      const tasksResponse = await this.tasksService.tasks.list({
        tasklist: targetTaskList.id,
        showCompleted: true,
        showHidden: true,
      });

      const googleTasks = tasksResponse.data.items || [];
      this.tasksData = googleTasks.map(this.convertGoogleTaskToTaskData);

      log.debug("Loaded tasks from Google", {
        taskListId: targetTaskList.id,
        taskCount: this.tasksData.length,
      });
    } catch (error) {
      log.error("Failed to load tasks from Google Tasks", { error });
      throw error;
    }
  }

  private convertGoogleTaskToTaskData = (googleTask: tasks_v1.Schema$Task): TaskData => {
    const id = googleTask.id || `google-${Date.now()}`;
    const title = googleTask.title || "Untitled Task";
    const description = googleTask.notes || "";
    const status = REVERSE_STATUS_MAPPING[googleTask.status || "needsAction"] || "TODO";

    return {
      id,
      title,
      description,
      status,
      specPath: this.getTaskSpecPath(id, title),
      worklog: [
        {
          timestamp: new Date().toISOString(),
          message: "Imported from Google Tasks",
        },
      ],
    };
  };

  private normalizeTaskData = (task: any): TaskData => {
    return {
      id: task.id || `task-${Date.now()}`,
      title: task.title || "Untitled Task",
      description: task.description || "",
      status: task.status || "TODO",
      specPath: task.specPath || this.getTaskSpecPath(task.id, task.title),
      worklog: task.worklog || [],
    };
  };

  private async ensureDirectoryExists(filePath: string): Promise<void> {
    const dir = join(filePath, "..");
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      // Ignore error if directory already exists
    }
  }

  /**
   * Generate authentication URL for OAuth flow
   */
  generateAuthUrl(): string {
    return this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: this.scopes,
      prompt: "consent",
    });
  }

  /**
   * Handle OAuth callback with authorization code
   * @param code Authorization code from OAuth callback
   */
  async handleAuthCallback(code: string): Promise<void> {
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      this.oauth2Client.setCredentials(tokens);
      await this.saveTokens();
      log.debug("Google Tasks authentication successful");
    } catch (error) {
      log.error("Failed to handle OAuth callback", { error });
      throw error;
    }
  }
}

/**
 * Factory function to create GoogleTasksBackend instance
 */
export function createGoogleTasksBackend(config: GoogleTasksBackendOptions): TaskBackend {
  return new GoogleTasksBackend(config);
}
