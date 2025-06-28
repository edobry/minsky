import { TaskBackend } from "./taskBackend";
import { SpecialWorkspaceManager } from "../workspace/special-workspace-manager";
import { resolveWorkspacePath } from "../workspace";
import { log } from "../../utils/logger";

/**
 * Strategy for determining backend workspace requirements
 */
export interface BackendWorkspaceStrategy {
  /** Check if backend requires special workspace for synchronization */
  requiresSpecialWorkspace(backend: TaskBackend): boolean;
  
  /** Get appropriate workspace path for the backend */
  getWorkspacePath(backend: TaskBackend): Promise<string>;
}

/**
 * Extended interface for backends that can indicate if they're in-tree
 */
export interface InTreeBackendCapable {
  /** Returns true if this backend stores data in repository files */
  isInTreeBackend(): boolean;
}

/**
 * Check if a backend implements the InTreeBackendCapable interface
 */
export function isInTreeBackendCapable(backend: TaskBackend): backend is TaskBackend & InTreeBackendCapable {
  return typeof (backend as any).isInTreeBackend === "function";
}

/**
 * Default strategy for routing backends to appropriate workspaces
 */
export class DefaultBackendWorkspaceStrategy implements BackendWorkspaceStrategy {
  constructor(
    private specialWorkspaceManager?: SpecialWorkspaceManager,
    private fallbackToSpecialWorkspace: boolean = true
  ) {}

  requiresSpecialWorkspace(backend: TaskBackend): boolean {
    // 1. Check if backend explicitly declares itself as in-tree
    if (isInTreeBackendCapable(backend)) {
      return backend.isInTreeBackend();
    }

    // 2. Auto-detect based on backend type/name
    const backendName = backend.constructor.name.toLowerCase();
    const inTreeBackends = [
      "markdowntaskbackend",
      "markdownfilebackend", 
      "jsontaskbackend",
      "jsonfiletaskbackend"
    ];
    
    if (inTreeBackends.some(name => backendName.includes(name.toLowerCase()))) {
      return this.fallbackToSpecialWorkspace;
    }

    // 3. External backends (GitHub, SQLite, PostgreSQL, etc.)
    const externalBackends = [
      "github",
      "sqlite", 
      "postgresql",
      "postgres",
      "mysql",
      "redis",
      "api"
    ];
    
    if (externalBackends.some(name => backendName.includes(name.toLowerCase()))) {
      return false;
    }

    // 4. Default: assume in-tree if we have special workspace available
    return this.fallbackToSpecialWorkspace && !!this.specialWorkspaceManager;
  }

  async getWorkspacePath(backend: TaskBackend): Promise<string> {
    if (this.requiresSpecialWorkspace(backend) && this.specialWorkspaceManager) {
      log.debug({
        message: "Using special workspace for in-tree backend",
        backendType: backend.constructor.name
      });
      
      return await this.specialWorkspaceManager.getWorkspacePath();
    }

    // Use normal workspace resolution for external backends
    log.debug({
      message: "Using normal workspace resolution for external backend",
      backendType: backend.constructor.name  
    });
    
    return resolveWorkspacePath();
  }
}

/**
 * Router for intelligently directing backends to appropriate workspaces
 */
export class TaskBackendRouter {
  constructor(
    private strategy: BackendWorkspaceStrategy = new DefaultBackendWorkspaceStrategy()
  ) {}

  /**
   * Get appropriate workspace path for a backend
   */
  async getWorkspacePathForBackend(backend: TaskBackend): Promise<string> {
    return await this.strategy.getWorkspacePath(backend);
  }

  /**
   * Check if backend should use special workspace
   */
  requiresSpecialWorkspace(backend: TaskBackend): boolean {
    return this.strategy.requiresSpecialWorkspace(backend);
  }

  /**
   * Create router with special workspace support
   */
  static withSpecialWorkspace(
    specialWorkspaceManager: SpecialWorkspaceManager,
    fallbackToSpecialWorkspace: boolean = true
  ): TaskBackendRouter {
    const strategy = new DefaultBackendWorkspaceStrategy(
      specialWorkspaceManager,
      fallbackToSpecialWorkspace
    );
    return new TaskBackendRouter(strategy);
  }

  /**
   * Create router without special workspace (external backends only)
   */
  static externalOnly(): TaskBackendRouter {
    const strategy = new DefaultBackendWorkspaceStrategy(undefined, false);
    return new TaskBackendRouter(strategy);
  }
} 
