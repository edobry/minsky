/**
 * Modular Git Commands
 *
 * Lightweight orchestration layer that coordinates the extracted git operation components.
 * This provides backward-compatible *FromParams functions using the new modular architecture.
 */
import {
  createAllGitOperations,
  setupGitOperationRegistry,
  type GitOperationDependencies,
  type GitOperationRegistry,
} from "./operations";
import { createGitService } from "./git-service-factory";

/**
 * Default dependencies for git operations
 */
const defaultGitOperationDependencies: GitOperationDependencies = {
  createGitService,
};

/**
 * Modular Git Commands Manager
 *
 * Manages git operations using the Strategy Pattern with dependency injection.
 * Provides a clean interface for executing git operations.
 */
export class ModularGitCommandsManager {
  private operations: ReturnType<typeof createAllGitOperations>;
  private operationRegistry: GitOperationRegistry;

  constructor(deps: GitOperationDependencies = defaultGitOperationDependencies) {
    this.operations = createAllGitOperations(deps);
    this.operationRegistry = setupGitOperationRegistry(deps);
  }

  /**
   * Create pull request using the provided parameters
   */
  async createPullRequestFromParams(params: {
    session?: string;
    repo?: string;
    branch?: string;
    taskId?: string;
    debug?: boolean;
    noStatusUpdate?: boolean;
  }): Promise<{ markdown: string; statusUpdateResult?: any }> {
    return await this.operations.createPullRequest.execute(params);
  }

  /**
   * Commit changes using the provided parameters
   */
  async commitChangesFromParams(params: {
    message: string;
    session?: string;
    repo?: string;
    all?: boolean;
    amend?: boolean;
    noStage?: boolean;
  }): Promise<{ commitHash: string; message: string }> {
    return await this.operations.commit.execute(params);
  }

  /**
   * Prepare PR using the provided parameters
   */
  async preparePrFromParams(params: {
    session?: string;
    repo?: string;
    baseBranch?: string;
    title?: string;
    body?: string;
    branchName?: string;
    debug?: boolean;
  }): Promise<any> {
    return await this.operations.preparePr.execute(params);
  }

  /**
   * Merge PR using the provided parameters
   */
  async mergePrFromParams(params: {
    prBranch: string;
    repo?: string;
    baseBranch?: string;
    session?: string;
  }): Promise<any> {
    return await this.operations.mergePr.execute(params);
  }

  /**
   * Clone repository using the provided parameters
   */
  async cloneFromParams(params: {
    url: string;
    workdir: string;
    session?: string;
    branch?: string;
  }): Promise<any> {
    return await this.operations.clone.execute(params);
  }

  /**
   * Create branch using the provided parameters
   */
  async branchFromParams(params: {
    session: string;
    name: string;
  }): Promise<any> {
    return await this.operations.branch.execute(params);
  }

  /**
   * Push changes using the provided parameters
   */
  async pushFromParams(params: {
    session?: string;
    repo?: string;
    remote?: string;
    force?: boolean;
    debug?: boolean;
  }): Promise<any> {
    return await this.operations.push.execute(params);
  }

  /**
   * Execute operation by name (registry-based execution)
   */
  async executeOperation<TParams, TResult>(
    operationName: string,
    params: TParams
  ): Promise<TResult> {
    return await this.operationRegistry.execute<TParams, TResult>(operationName, params);
  }

  /**
   * Get available operation names
   */
  getOperationNames(): string[] {
    return this.operationRegistry.getOperationNames();
  }

  /**
   * Get the operation registry
   */
  getOperationRegistry(): GitOperationRegistry {
    return this.operationRegistry;
  }

  /**
   * Get direct access to operations (for advanced usage)
   */
  getOperations() {
    return this.operations;
  }
}

/**
 * Default modular git commands manager instance
 */
export const modularGitCommandsManager = new ModularGitCommandsManager();

/**
 * Factory function to create a git commands manager with custom dependencies
 */
export function createModularGitCommandsManager(
  deps?: GitOperationDependencies
): ModularGitCommandsManager {
  return new ModularGitCommandsManager(deps);
}

// Backward compatibility functions that delegate to the modular manager

/**
 * Create pull request using the provided parameters (backward compatibility)
 */
export async function createPullRequestFromParams(
  params: {
    session?: string;
    repo?: string;
    branch?: string;
    taskId?: string;
    debug?: boolean;
    noStatusUpdate?: boolean;
  },
  deps?: GitOperationDependencies
): Promise<{ markdown: string; statusUpdateResult?: any }> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.createPullRequestFromParams(params);
}

/**
 * Commit changes using the provided parameters (backward compatibility)
 */
export async function commitChangesFromParams(
  params: {
    message: string;
    session?: string;
    repo?: string;
    all?: boolean;
    amend?: boolean;
    noStage?: boolean;
  },
  deps?: GitOperationDependencies
): Promise<{ commitHash: string; message: string }> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.commitChangesFromParams(params);
}

/**
 * Prepare PR using the provided parameters (backward compatibility)
 */
export async function preparePrFromParams(
  params: {
    session?: string;
    repo?: string;
    baseBranch?: string;
    title?: string;
    body?: string;
    branchName?: string;
    debug?: boolean;
  },
  deps?: GitOperationDependencies
): Promise<any> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.preparePrFromParams(params);
}

/**
 * Merge PR using the provided parameters (backward compatibility)
 */
export async function mergePrFromParams(
  params: {
    prBranch: string;
    repo?: string;
    baseBranch?: string;
    session?: string;
  },
  deps?: GitOperationDependencies
): Promise<any> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.mergePrFromParams(params);
}

/**
 * Clone repository using the provided parameters (backward compatibility)
 */
export async function cloneFromParams(
  params: {
    url: string;
    workdir: string;
    session?: string;
    branch?: string;
  },
  deps?: GitOperationDependencies
): Promise<any> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.cloneFromParams(params);
}

/**
 * Create branch using the provided parameters (backward compatibility)
 */
export async function branchFromParams(
  params: {
    session: string;
    name: string;
  },
  deps?: GitOperationDependencies
): Promise<any> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.branchFromParams(params);
}

/**
 * Push changes using the provided parameters (backward compatibility)
 */
export async function pushFromParams(
  params: {
    session?: string;
    repo?: string;
    remote?: string;
    force?: boolean;
    debug?: boolean;
  },
  deps?: GitOperationDependencies
): Promise<any> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.pushFromParams(params);
}

// Export all operation components for direct access
export * from "./operations";

// Export for migration path
export { ModularGitCommandsManager as GitCommandsManager };
export { modularGitCommandsManager as gitCommandsManager };