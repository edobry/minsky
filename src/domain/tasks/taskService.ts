// Define the base TaskService interface used across the domain
export interface TaskServiceInterface {
  listTasks(options?: any): Promise<any[]>;
  getTask(taskId: string): Promise<any | null>;
  getTaskStatus(taskId: string): Promise<string | undefined>;
  setTaskStatus(taskId: string, status: string): Promise<void>;
  createTask(specPath: string, options?: any): Promise<any>;
  createTaskFromTitleAndSpec(title: string, spec: string, options?: any): Promise<any>;
  deleteTask(taskId: string, options?: any): Promise<boolean>;
  getTaskSpecContent(
    taskId: string,
    section?: string
  ): Promise<{ task: any; specPath: string; content: string; section?: string }>;
  getWorkspacePath(): string;
}
import { createMarkdownTaskBackend } from "./markdownTaskBackend";
import { createJsonFileTaskBackend } from "./jsonFileTaskBackend";
import { createMinskyTaskBackend } from "./minskyTaskBackend";
import { createGitHubIssuesTaskBackend } from "./githubIssuesTaskBackend";
import { getGitHubBackendConfig } from "./githubBackendConfig";
import { createTaskService } from "./multi-backend-service";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

export interface TaskServiceOptions {
  workspacePath: string;
  backend?: string;
}

// ---- Factory Functions ----

export async function createConfiguredTaskService(options: {
  workspacePath: string;
  backend?: string;
}): Promise<TaskServiceInterface> {
  // Create task service - handles single or multiple backends based on options
  const service = createTaskService({ workspacePath: options.workspacePath });

  // If specific backend requested, only register that backend
  if (options.backend) {
    switch (options.backend) {
      case "markdown": {
        const markdownBackend = createMarkdownTaskBackend({
          name: "markdown",
          workspacePath: options.workspacePath,
        });
        (markdownBackend as any).prefix = "md";
        service.registerBackend(markdownBackend);
        break;
      }

      case "json-file": {
        const jsonBackend = createJsonFileTaskBackend({
          name: "json-file",
          workspacePath: options.workspacePath,
        });
        (jsonBackend as any).prefix = "json";
        service.registerBackend(jsonBackend);
        break;
      }

      case "github": {
        const config = getGitHubBackendConfig(options.workspacePath, { logErrors: true });
        if (!config || !config.githubToken || !config.owner || !config.repo) {
          throw new Error(
            "GitHub backend configuration not available. Ensure GitHub token, owner, and repo are configured."
          );
        }
        const githubBackend = createGitHubIssuesTaskBackend({
          name: "github",
          workspacePath: options.workspacePath,
          githubToken: config.githubToken,
          owner: config.owner,
          repo: config.repo,
          statusLabels: config.statusLabels,
        });
        (githubBackend as any).prefix = "gh";
        service.registerBackend(githubBackend);
        log.debug("GitHub backend registered successfully");
        break;
      }

      case "minsky": {
        try {
          const { createDatabaseConnection } = await import("../database/connection-manager");
          const db = await createDatabaseConnection();
          const minskyBackend = createMinskyTaskBackend({
            name: "minsky",
            workspacePath: options.workspacePath,
            db,
          });
          (minskyBackend as any).prefix = "mt";
          service.registerBackend(minskyBackend);
          log.debug("Minsky backend registered successfully");
        } catch (error) {
          log.debug("Minsky backend not available", { error: getErrorMessage(error as any) });
          throw new Error(
            `Minsky backend requested but not available: ${getErrorMessage(error as any)}`
          );
        }
        break;
      }

      default:
        throw new Error(`Unknown backend: ${options.backend}`);
    }
  } else {
    // No specific backend requested - register all available backends for multi-backend mode
    try {
      const markdownBackend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: options.workspacePath,
      });
      // Add prefix property for multi-backend routing
      (markdownBackend as any).prefix = "md";
      service.registerBackend(markdownBackend);

      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: options.workspacePath,
      });
      (jsonBackend as any).prefix = "json";
      service.registerBackend(jsonBackend);

      // Add GitHub backend (gh# prefix) - requires GitHub configuration
      try {
        const config = getGitHubBackendConfig(options.workspacePath, { logErrors: false });
        if (config && config.githubToken && config.owner && config.repo) {
          const githubBackend = createGitHubIssuesTaskBackend({
            name: "github",
            workspacePath: options.workspacePath,
            githubToken: config.githubToken,
            owner: config.owner,
            repo: config.repo,
            statusLabels: config.statusLabels,
          });
          (githubBackend as any).prefix = "gh";
          service.registerBackend(githubBackend);
          log.debug("GitHub backend registered successfully");
        }
      } catch (error) {
        log.debug("GitHub backend not available", { error: getErrorMessage(error as any) });
      }

      // Add minsky backend (mt# prefix) - requires database connection
      try {
        // Use configured database connection
        const { createDatabaseConnection } = await import("../database/connection-manager");
        const db = await createDatabaseConnection();

        const minskyBackend = createMinskyTaskBackend({
          name: "minsky",
          workspacePath: options.workspacePath,
          db,
        });
        (minskyBackend as any).prefix = "mt";
        service.registerBackend(minskyBackend);
        log.debug("Minsky backend registered successfully");
      } catch (error) {
        log.debug("Minsky backend not available", { error: getErrorMessage(error as any) });
      }

      // Set the configured default backend (respect tasks.backend configuration with fallback to 'minsky')
      try {
        const { getConfiguration } = await import("../configuration");
        const config = getConfiguration();
        const configuredBackend = config.tasks.backend; // Config system handles default fallback
        (service as any).setDefaultBackend(configuredBackend);
        log.debug(`Set default backend to '${configuredBackend}' from configuration`);
      } catch (error) {
        log.debug("Could not read configuration for default backend", {
          error: getErrorMessage(error as any),
        });
        // Fallback to 'minsky' if config system fails
        (service as any).setDefaultBackend("minsky");
      }
    } catch (error) {
      log.warn("Failed to register some backends", { error: getErrorMessage(error as any) });
    }
  }

  return service;
}

// ---- Utility functions used by tests (GitHub URL parsing) ----
export function extractGitHubInfoFromRepoUrl(url: string): { owner: string; repo: string } | null {
  try {
    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/^git@github.com:([^/]+)\/(.+?)(\.git)?$/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }
    // HTTPS: https://github.com/owner/repo(.git)?
    const httpsMatch = url.match(/^https?:\/\/github.com\/([^/]+)\/(.+?)(\.git)?$/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseGitHubRepoString(input: string): { owner: string; repo: string } | null {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

// ---- Type Exports ----

export type { TaskServiceOptions };
