/**
 * Git Operations Module
 *
 * Exports for all modularized git operation components.
 * Part of the modularization effort from git.ts.
 */

// Base operation infrastructure
import { GitOperationRegistry } from "./base-git-operation";
import type { GitOperationDependencies } from "./base-git-operation";

export { BaseGitOperation, GitOperationRegistry, gitOperationRegistry } from "./base-git-operation";
export type {
  GitOperationDependencies,
  GitOperationFactory,
  BaseGitOperationParams,
} from "./base-git-operation";

// PR operations
import {
  createCreatePullRequestOperation,
  createPreparePrOperation,
  createMergePrOperation,
} from "./pr-operations";

export {
  CreatePullRequestOperation,
  PreparePrOperation,
  MergePrOperation,
  createCreatePullRequestOperation,
  createPreparePrOperation,
  createMergePrOperation,
} from "./pr-operations";

// Basic operations
import {
  createCloneOperation,
  createBranchOperation,
  createPushOperation,
  createCommitOperation,
} from "./basic-operations";

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

// Advanced operations
import {
  createMergeOperation,
  createCheckoutOperation,
  createRebaseOperation,
} from "./advanced-operations";

export {
  MergeOperation,
  CheckoutOperation,
  RebaseOperation,
  createMergeOperation,
  createCheckoutOperation,
  createRebaseOperation,
} from "./advanced-operations";

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

    // Advanced operations
    merge: createMergeOperation(deps),
    checkout: createCheckoutOperation(deps),
    rebase: createRebaseOperation(deps),
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
  registry.register("merge", operations.merge);
  registry.register("checkout", operations.checkout);
  registry.register("rebase", operations.rebase);

  return registry;
}
