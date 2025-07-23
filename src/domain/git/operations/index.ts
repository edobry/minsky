/**
 * Git Operations Module
 * 
 * Exports for all modularized git operation components.
 * Part of the modularization effort from git.ts.
 */

// Base operation infrastructure
export {
  BaseGitOperation,
  GitOperationRegistry,
  gitOperationRegistry,
} from "./base-git-operation";
export type {
  GitOperationDependencies,
  GitOperationFactory,
  BaseGitOperationParams,
} from "./base-git-operation";

// PR operations
export {
  CreatePullRequestOperation,
  PreparePrOperation,
  MergePrOperation,
  createCreatePullRequestOperation,
  createPreparePrOperation,
  createMergePrOperation,
} from "./pr-operations";

// Basic operations
export {
  CloneOperation,
  BranchOperation,
  PushOperation,
  CommitOperation,
  createCloneOperation,
  createBranchOperation,
  createPushOperation,
  createCommitOperation,
} from "./basic-operations";

// Factory for creating all operations
export function createAllGitOperations(deps?: GitOperationDependencies) {
  return {
    // Basic operations
    clone: createCloneOperation(deps),
    branch: createBranchOperation(deps),
    push: createPushOperation(deps),
    commit: createCommitOperation(deps),
    
    // PR operations
    createPullRequest: createCreatePullRequestOperation(deps),
    preparePr: createPreparePrOperation(deps),
    mergePr: createMergePrOperation(deps),
  };
}

// Registry setup function
export function setupGitOperationRegistry(deps?: GitOperationDependencies): GitOperationRegistry {
  const registry = new GitOperationRegistry();
  const operations = createAllGitOperations(deps);
  
  // Register all operations
  registry.register("clone", operations.clone);
  registry.register("branch", operations.branch);
  registry.register("push", operations.push);
  registry.register("commit", operations.commit);
  registry.register("createPullRequest", operations.createPullRequest);
  registry.register("preparePr", operations.preparePr);
  registry.register("mergePr", operations.mergePr);
  
  return registry;
}