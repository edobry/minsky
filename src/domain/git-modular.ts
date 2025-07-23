/**
 * Modular Git Domain (Legacy Compatibility Wrapper)
 *
 * This module provides backward compatibility for the original git interface
 * while delegating key *FromParams functions to the new modular architecture.
 * 
 * MIGRATION IN PROGRESS: Key functions extracted to modular operations
 * GitService class preserved to avoid massive refactoring
 */

// Re-export everything from the original git.ts that hasn't been extracted yet
export * from "./git";

// Import and re-export the modularized functions
import {
  createPullRequestFromParams as modularCreatePullRequestFromParams,
  commitChangesFromParams as modularCommitChangesFromParams,
  preparePrFromParams as modularPreparePrFromParams,
  mergePrFromParams as modularMergePrFromParams,
  cloneFromParams as modularCloneFromParams,
  branchFromParams as modularBranchFromParams,
  pushFromParams as modularPushFromParams,
  ModularGitCommandsManager,
  modularGitCommandsManager,
  createModularGitCommandsManager,
} from "./git/git-commands-modular";

// Override the original functions with modular implementations
export {
  modularCreatePullRequestFromParams as createPullRequestFromParams,
  modularCommitChangesFromParams as commitChangesFromParams,
  modularPreparePrFromParams as preparePrFromParams,
  modularMergePrFromParams as mergePrFromParams,
  modularCloneFromParams as cloneFromParams,
  modularBranchFromParams as branchFromParams,
  modularPushFromParams as pushFromParams,
};

// Export modular components for migration path
export {
  ModularGitCommandsManager,
  modularGitCommandsManager,
  createModularGitCommandsManager,
};

// Export all modular git operation components for full access
export * from "./git/operations";

// Export for backward compatibility
export { ModularGitCommandsManager as GitCommandsManager };
export { modularGitCommandsManager as gitCommandsManager };