/**
 * Modular Git Commands
 *
 * Lightweight orchestration layer that coordinates the extracted git operation components.
 * This provides *FromParams functions using the modular architecture.
 *
 * Session resolution is NOT performed here — callers must resolve session UUIDs
 * to repo paths before calling these functions.
 */
import {
  createAllGitOperations,
  setupGitOperationRegistry,
  type GitOperationDependencies,
  type GitOperationRegistry,
} from "./operations";
import { createGitService } from "./git-service-factory";
import type {
  CloneResult,
  BranchResult,
  PushResult,
  MergePrResult,
  EnhancedMergeResult,
  PrResult,
} from "./types";

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
  private operations: ReturnType<typeof createAllGitOperations> | null = null;
  private operationRegistry: GitOperationRegistry | null = null;
  private deps: GitOperationDependencies;

  constructor(deps: GitOperationDependencies = defaultGitOperationDependencies) {
    this.deps = deps;
    // Lazy load operations to avoid circular dependency issues
  }

  private initializeOperations(): void {
    if (!this.operations) {
      this.operations = createAllGitOperations(this.deps);
      this.operationRegistry = setupGitOperationRegistry(this.deps);
    }
  }

  private getOperations(): ReturnType<typeof createAllGitOperations> {
    this.initializeOperations();
    // initializeOperations() guarantees this.operations is set
    return this.operations as ReturnType<typeof createAllGitOperations>;
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
  }): Promise<PrResult> {
    return await this.getOperations().createPullRequest.execute(params);
  }

  /**
   * Commit changes using the provided parameters
   */
  async commitChangesFromParams(params: {
    message: string;
    repo?: string;
    all?: boolean;
    amend?: boolean;
    noStage?: boolean;
    files?: string[];
  }): Promise<{ commitHash: string; message: string }> {
    return await this.getOperations().commit.execute(params);
  }

  /**
   * Merge PR using the provided parameters
   */
  async mergePrFromParams(params: {
    prBranch: string;
    repo?: string;
    baseBranch?: string;
  }): Promise<MergePrResult> {
    return await this.getOperations().mergePr.execute(params);
  }

  /**
   * Clone repository using the provided parameters
   */
  async cloneFromParams(params: {
    url: string;
    workdir: string;
    session?: string;
    branch?: string;
  }): Promise<CloneResult> {
    return await this.getOperations().clone.execute(params);
  }

  /**
   * Create branch using the provided parameters
   */
  async branchFromParams(params: { session: string; name: string }): Promise<BranchResult> {
    return await this.getOperations().branch.execute(params);
  }

  /**
   * Push changes using the provided parameters
   */
  async pushFromParams(params: {
    repo?: string;
    remote?: string;
    force?: boolean;
    debug?: boolean;
  }): Promise<PushResult> {
    return await this.getOperations().push.execute(params);
  }

  /**
   * Merge branches using the provided parameters
   */
  async mergeFromParams(params: {
    sourceBranch: string;
    targetBranch?: string;
    repo?: string;
    preview?: boolean;
    autoResolve?: boolean;
    conflictStrategy?: string;
  }): Promise<EnhancedMergeResult> {
    return await this.getOperations().merge.execute(params);
  }

  /**
   * Checkout branch using the provided parameters
   */
  async checkoutFromParams(params: {
    branch: string;
    repo?: string;
    preview?: boolean;
    autoResolve?: boolean;
    conflictStrategy?: string;
  }): Promise<{
    workdir: string;
    switched: boolean;
    conflicts: boolean;
    conflictDetails?: string;
    warning?: { wouldLoseChanges: boolean; recommendedAction: string };
  }> {
    return await this.getOperations().checkout.execute(params);
  }

  /**
   * Rebase branch using the provided parameters
   */
  async rebaseFromParams(params: {
    baseBranch: string;
    featureBranch?: string;
    repo?: string;
    preview?: boolean;
    autoResolve?: boolean;
    conflictStrategy?: string;
  }): Promise<{
    workdir: string;
    rebased: boolean;
    conflicts: boolean;
    conflictDetails?: string;
    prediction?: { canAutoResolve: boolean; recommendations: string[]; overallComplexity: string };
  }> {
    return await this.getOperations().rebase.execute(params);
  }

  /**
   * Execute operation by name (registry-based execution)
   */
  async executeOperation<TParams, TResult>(
    operationName: string,
    params: TParams
  ): Promise<TResult> {
    this.initializeOperations();
    // initializeOperations() guarantees this.operationRegistry is set
    return await (this.operationRegistry as GitOperationRegistry).execute<TParams, TResult>(
      operationName,
      params
    );
  }

  /**
   * Get available operation names
   */
  getOperationNames(): string[] {
    this.initializeOperations();
    // initializeOperations() guarantees this.operationRegistry is set
    return (this.operationRegistry as GitOperationRegistry).getOperationNames();
  }

  /**
   * Get the operation registry
   */
  getOperationRegistry(): GitOperationRegistry {
    this.initializeOperations();
    // initializeOperations() guarantees this.operationRegistry is set
    return this.operationRegistry as GitOperationRegistry;
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

// Export all operation components for direct access
export * from "./operations";

// Export for migration path
export { ModularGitCommandsManager as GitCommandsManager };
export { modularGitCommandsManager as gitCommandsManager };
