import { join } from "path";
import { SpecialWorkspaceManager } from "../workspace/special-workspace-manager";
import { TaskBackend } from "./taskBackend";
import { MarkdownTaskBackend } from "./markdownTaskBackend";
import { JsonFileTaskBackend } from "./jsonFileTaskBackend";
import { log } from "../../utils/logger";

/**
 * Backend category types for routing decisions
 */
export type BackendCategory = "in-tree" | "external" | "hybrid";

/**
 * Backend routing information
 */
export interface BackendRoutingInfo {
  category: BackendCategory;
  requiresSpecialWorkspace: boolean;
  description: string;
}

/**
 * TaskBackendRouter provides intelligent routing for task backends,
 * determining whether they should use the special workspace or normal resolution.
 */
export class TaskBackendRouter {
  private specialWorkspaceManager?: SpecialWorkspaceManager;

  constructor(private repoUrl?: string) {}

  /**
   * Determine routing information for a backend
   */
  getBackendRoutingInfo(backend: TaskBackend): BackendRoutingInfo {
    // Check for manual override first
    if (backend && "isInTreeBackend" in backend && typeof backend.isInTreeBackend === "function") {
      const isInTree = backend.isInTreeBackend();
      return {
        category: isInTree ? "in-tree" : "external",
        requiresSpecialWorkspace: isInTree,
        description: isInTree ? "Manually configured as in-tree" : "Manually configured as external"
      };
    }

    // Auto-detect based on backend type
    return this.autoDetectBackendCategory(backend);
  }

  /**
   * Auto-detect backend category based on type and configuration
   */
  private autoDetectBackendCategory(backend: TaskBackend): BackendRoutingInfo {
    const constructorName = backend.constructor.name.toLowerCase();

    // Markdown backends - always in-tree
    if (backend instanceof MarkdownTaskBackend || constructorName.includes("markdowntaskbackend")) {
      return {
        category: "in-tree",
        requiresSpecialWorkspace: true,
        description: "Markdown backend stores data in repository files"
      };
    }

    // JSON file backends - depends on file location
    if (backend instanceof JsonFileTaskBackend || constructorName.includes("jsonfiletaskbackend")) {
      return this.categorizeJsonBackend(backend as JsonFileTaskBackend);
    }

    // GitHub Issues backends - always external (check by constructor name)
    if (this.isGitHubBackend(backend)) {
      return {
        category: "external",
        requiresSpecialWorkspace: false,
        description: "GitHub Issues backend uses external API"
      };
    }

    // SQLite backends - hybrid (depends on file location)
    if (this.isSqliteBackend(backend)) {
      return this.categorizeSqliteBackend(backend);
    }

    // PostgreSQL backends - always external
    if (this.isPostgresBackend(backend)) {
      return {
        category: "external",
        requiresSpecialWorkspace: false,
        description: "PostgreSQL backend uses external database"
      };
    }

    // Default to external for unknown backends
    return {
      category: "external",
      requiresSpecialWorkspace: false,
      description: "Unknown backend type, defaulting to external"
    };
  }

  /**
   * Categorize JSON file backend based on file location
   */
  private categorizeJsonBackend(backend: JsonFileTaskBackend): BackendRoutingInfo {
    try {
      // Get the configured file path from the backend
      const filePath = this.getJsonBackendFilePath(backend);
      
      // Check if it's in the repository directory structure
      if (filePath.includes("process/tasks.json") || filePath.includes("process/.minsky/")) {
        return {
          category: "in-tree",
          requiresSpecialWorkspace: true,
          description: "JSON file stored in repository process directory"
        };
      }

      // Check if it's in a local workspace directory
      if (filePath.includes(".minsky/tasks.json")) {
        return {
          category: "in-tree",
          requiresSpecialWorkspace: true,
          description: "JSON file in workspace-local directory, should use centralized storage"
        };
      }

      // External location
      return {
        category: "external",
        requiresSpecialWorkspace: false,
        description: "JSON file in external location"
      };
    } catch (error) {
      log.warn("Failed to determine JSON backend file path, defaulting to in-tree");
      return {
        category: "in-tree",
        requiresSpecialWorkspace: true,
        description: "Unable to determine JSON file location, defaulting to in-tree"
      };
    }
  }

  /**
   * Categorize SQLite backend based on database location
   */
  private categorizeSqliteBackend(backend: TaskBackend): BackendRoutingInfo {
    try {
      // Try to get database file path from backend
      const dbPath = this.getSqliteBackendPath(backend);
      
      // Check if it's in the repository directory structure
      if (dbPath.includes("process/") || dbPath.includes(".git/")) {
        return {
          category: "in-tree",
          requiresSpecialWorkspace: true,
          description: "SQLite database stored in repository"
        };
      }

      // External database
      return {
        category: "external",
        requiresSpecialWorkspace: false,
        description: "SQLite database in external location"
      };
    } catch (error) {
      // Default to external for SQLite if we can't determine location
      return {
        category: "external",
        requiresSpecialWorkspace: false,
        description: "Unable to determine SQLite location, defaulting to external"
      };
    }
  }

  /**
   * Get the workspace path for in-tree operations
   */
  async getInTreeWorkspacePath(): Promise<string> {
    if (!this.repoUrl) {
      throw new Error("Repository URL required for in-tree workspace operations");
    }

    if (!this.specialWorkspaceManager) {
      this.specialWorkspaceManager = await SpecialWorkspaceManager.create(this.repoUrl);
    }

    return (this.specialWorkspaceManager as unknown).getWorkspacePath();
  }

  /**
   * Perform an operation in the appropriate workspace
   */
  async performBackendOperation<T>(
    backend: TaskBackend,
    operation: string,
    callback: (workspacePath: string) => Promise<T>
  ): Promise<T> {
    const routingInfo = this.getBackendRoutingInfo(backend);

    if (routingInfo.requiresSpecialWorkspace) {
      // Use special workspace for in-tree backends
      if (!this.specialWorkspaceManager) {
        if (!this.repoUrl) {
          throw new Error("Repository URL required for in-tree backend operations");
        }
        this.specialWorkspaceManager = await SpecialWorkspaceManager.create(this.repoUrl);
      }

      return (this.specialWorkspaceManager as unknown).performOperation(operation, callback as unknown);
    } else {
      // Use current working directory for external backends
      const currentDir = (process as any).cwd();
      return callback(currentDir);
    }
  }

  /**
   * Helper methods for backend type detection
   */
  private isGitHubBackend(backend: TaskBackend): boolean {
    // Check if backend constructor name or class indicates GitHub
    return backend.constructor.name.toLowerCase().includes("github") ||
           backend.name.toLowerCase().includes("github");
  }

  private isSqliteBackend(backend: TaskBackend): boolean {
    // Check if backend constructor name or class indicates SQLite
    return backend.constructor.name.toLowerCase().includes("sqlite") ||
           backend.constructor.name.toLowerCase().includes("sql");
  }

  private isPostgresBackend(backend: TaskBackend): boolean {
    // Check if backend constructor name or class indicates PostgreSQL
    return backend.constructor.name.toLowerCase().includes("postgres") ||
           backend.constructor.name.toLowerCase().includes("pg");
  }

  /**
   * Extract file path from JSON backend (implementation-specific)
   */
  private getJsonBackendFilePath(backend: JsonFileTaskBackend): string {
    // Try to get the storage location from the backend
    if (typeof backend.getStorageLocation === "function") {
      return backend.getStorageLocation();
    }

    // Try to access other file path properties
    if ("filePath" in backend) {
      return backend.filePath;
    }
    
    if ("fileName" in backend) {
      return backend.fileName;
    }

    // Fallback: assume it's using standard location
    return join((process as any).cwd(), ".minsky", "tasks.json");
  }

  /**
   * Extract database path from SQLite backend (implementation-specific)
   */
  private getSqliteBackendPath(backend: TaskBackend): string {
    // Try to access the database path property
    if ("dbPath" in backend) {
      return backend.dbPath;
    }
    
    if ("databasePath" in backend) {
      return backend.databasePath;
    }

    // Fallback: assume external location
    throw new Error("Cannot determine SQLite database path");
  }

  /**
   * Create a router with repository URL for in-tree operations
   */
  static async createWithRepo(repoUrl: string): Promise<TaskBackendRouter> {
    const router = new TaskBackendRouter(repoUrl);
    return router;
  }

  /**
   * Create a router for external operations only
   */
  static createExternal(): TaskBackendRouter {
    return new TaskBackendRouter();
  }
} 
