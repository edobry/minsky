import type {
  Task,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
  TaskBackend as TaskBackendInterface,
} from "./types";
import { createMinskyTaskBackend } from "./minskyTaskBackend";
import { createGitHubIssuesTaskBackend } from "./githubIssuesTaskBackend";
import { getGitHubBackendConfig } from "./githubBackendConfig";
import { createTaskService } from "./multi-backend-service";
import { TaskBackend } from "../configuration/backend-detection";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

// Define the base TaskService interface used across the domain
export interface TaskServiceInterface {
  listTasks(options?: TaskListOptions): Promise<Task[]>;
  getTask(taskId: string): Promise<Task | null>;
  getTaskStatus(taskId: string): Promise<string | undefined>;
  setTaskStatus(taskId: string, status: string): Promise<void>;
  createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task>;
  deleteTask(taskId: string, options?: DeleteTaskOptions): Promise<boolean>;
  getTasks(ids: string[]): Promise<Task[]>;
  getTaskSpecContent(
    taskId: string,
    section?: string
  ): Promise<{ task: Task; specPath: string; content: string; section?: string }>;
  getWorkspacePath(): string;
  getBackendForTask?(taskId: string): Promise<string>;
  listBackends?(): Pick<TaskBackendInterface, "name" | "prefix">[];
  updateTask?(taskId: string, updates: Partial<Task>): Promise<Task>;
  setDefaultBackend?(backendName: string): void;
}

export interface TaskServiceOptions {
  workspacePath: string;
  backend?: string;
  persistenceProvider: import("../persistence/types").BasePersistenceProvider;
}

// ---- Factory Functions ----

export async function createConfiguredTaskService(options: {
  workspacePath: string;
  backend?: string;
  persistenceProvider: import("../persistence/types").BasePersistenceProvider;
}): Promise<TaskServiceInterface> {
  // Create task service - handles single or multiple backends based on options
  const service = createTaskService({ workspacePath: options.workspacePath });

  // If specific backend requested, only register that backend
  if (options.backend) {
    switch (options.backend) {
      case TaskBackend.GITHUB: {
        const config = getGitHubBackendConfig(options.workspacePath, { logErrors: true });
        if (!config || !config.githubToken || !config.owner || !config.repo) {
          throw new Error(
            "GitHub backend configuration not available. Ensure GitHub token, owner, and repo are configured."
          );
        }
        const githubBackend = createGitHubIssuesTaskBackend({
          name: TaskBackend.GITHUB,
          workspacePath: options.workspacePath,
          githubToken: config.githubToken,
          owner: config.owner,
          repo: config.repo,
          statusLabels: config.statusLabels,
        });
        githubBackend.prefix = "gh";
        service.registerBackend(githubBackend);
        log.debug("GitHub backend registered successfully");
        break;
      }

      case TaskBackend.MINSKY: {
        try {
          if (!options.persistenceProvider) {
            throw new Error("Minsky backend requires a persistenceProvider to be injected");
          }
          const persistence =
            options.persistenceProvider as import("../persistence/types").SqlCapablePersistenceProvider;
          const db = await persistence.getDatabaseConnection?.();
          if (!db) {
            throw new Error(
              "Minsky backend requires a database connection, but none was available"
            );
          }

          const minskyBackend = createMinskyTaskBackend({
            name: TaskBackend.MINSKY,
            workspacePath: options.workspacePath,
            db,
          });
          minskyBackend.prefix = "mt";
          service.registerBackend(minskyBackend);
          log.debug("Minsky backend registered successfully");
        } catch (error) {
          log.debug("Minsky backend not available", { error: getErrorMessage(error) });
          throw new Error(`Minsky backend requested but not available: ${getErrorMessage(error)}`);
        }
        break;
      }

      default: {
        const { getAvailableBackendsString } = await import("./taskConstants");
        throw new Error(
          `Unknown backend: ${options.backend}. Available backends: ${getAvailableBackendsString()}`
        );
      }
    }
  } else {
    // No specific backend requested - register all available backends for multi-backend mode
    try {
      const persistenceProvider = options.persistenceProvider;
      log.debug("Using injected persistence provider for multi-backend mode");

      // Add GitHub backend (gh# prefix) - requires GitHub configuration
      try {
        const config = getGitHubBackendConfig(options.workspacePath, { logErrors: false });
        if (config && config.githubToken && config.owner && config.repo) {
          const githubBackend = createGitHubIssuesTaskBackend({
            name: TaskBackend.GITHUB,
            workspacePath: options.workspacePath,
            githubToken: config.githubToken,
            owner: config.owner,
            repo: config.repo,
            statusLabels: config.statusLabels,
          });
          githubBackend.prefix = "gh";
          service.registerBackend(githubBackend);
          log.debug("GitHub backend registered successfully");
        }
      } catch (error) {
        log.debug("GitHub backend not available", { error: getErrorMessage(error) });
      }

      // Add minsky backend (mt# prefix) - persistence is guaranteed
      if (
        "getDatabaseConnection" in persistenceProvider &&
        typeof persistenceProvider.getDatabaseConnection === "function"
      ) {
        try {
          const db = await persistenceProvider.getDatabaseConnection();
          if (db) {
            const minskyBackend = createMinskyTaskBackend({
              name: TaskBackend.MINSKY,
              workspacePath: options.workspacePath,
              db,
            });
            minskyBackend.prefix = "mt";
            service.registerBackend(minskyBackend);
            log.debug("Minsky backend registered successfully");
          } else {
            log.debug("Minsky backend database connection returned null");
          }
        } catch (error) {
          log.warn("Minsky backend database connection failed", {
            error: getErrorMessage(error),
          });
        }
      }

      // Set the configured default backend (respect tasks.backend configuration with fallback to 'minsky')
      let configuredBackend: string | undefined;
      try {
        const { getConfiguration } = await import("../configuration");
        const config = getConfiguration();
        configuredBackend = config.tasks.backend; // Config system handles default fallback
        if (configuredBackend) {
          service.setDefaultBackend?.(configuredBackend);
        }
        log.debug(`Set default backend to '${configuredBackend}' from configuration`);
      } catch (error) {
        log.debug("Could not read configuration for default backend", {
          error: getErrorMessage(error),
        });
        // Fallback to 'minsky' if config system fails
        configuredBackend = TaskBackend.MINSKY;
        service.setDefaultBackend?.(TaskBackend.MINSKY);
      }

      // Verify the configured default backend was actually registered.
      // If not, the service will silently fail on every operation — fail loudly instead.
      const registeredBackends = service.listBackends?.() ?? [];
      if (
        configuredBackend &&
        registeredBackends.length > 0 &&
        !registeredBackends.some((b) => b.name === configuredBackend)
      ) {
        const registered = registeredBackends.map((b) => b.name).join(", ");
        log.warn(
          `Configured default backend '${configuredBackend}' was not registered ` +
            `(registered: ${registered || "none"}). ` +
            `Tasks with '${configuredBackend === TaskBackend.MINSKY ? "mt" : configuredBackend}#' prefix will fail. ` +
            `Ensure persistenceProvider is injected when creating the task service.`
        );
      }
    } catch (error) {
      log.warn("Failed to register some backends", { error: getErrorMessage(error) });
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
      return { owner: sshMatch[1] || "", repo: sshMatch[2] || "" };
    }
    // HTTPS: https://github.com/owner/repo(.git)?
    const httpsMatch = url.match(/^https?:\/\/github.com\/([^/]+)\/(.+?)(\.git)?$/);
    if (httpsMatch) {
      return { owner: httpsMatch[1] || "", repo: httpsMatch[2] || "" };
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
// TaskServiceOptions is already exported above as `export interface TaskServiceOptions`
