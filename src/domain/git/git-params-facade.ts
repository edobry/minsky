/**
 * Git *FromParams Facade Functions
 *
 * Interface-agnostic delegation functions that wrap modularGitCommandsManager methods.
 * Extracted from git.ts to reduce file size while preserving the public API.
 */
import { modularGitCommandsManager, createModularGitCommandsManager } from "./git-commands-modular";
import type { GitOperationDependencies } from "./operations/base-git-operation";
import type { MergePrResult } from "./merge-pr-operations";
import type { CloneResult } from "./clone-operations";
import type { PushResult } from "./push-operations";
import type { BranchResult, PrResult } from "./types";
import type { EnhancedMergeResult } from "./conflict-detection";

/**
 * Interface-agnostic function to create a pull request
 * MODULARIZED: Delegates to modular operation
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
): Promise<PrResult> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.createPullRequestFromParams(params);
}

/**
 * Interface-agnostic function to commit changes
 * MODULARIZED: Delegates to modular operation
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
 * Interface-agnostic function to merge a PR branch
 * MODULARIZED: Delegates to modular operation
 */
export async function mergePrFromParams(
  params: {
  prBranch: string;
  repo?: string;
  baseBranch?: string;
  session?: string;
  },
  deps?: GitOperationDependencies
): Promise<MergePrResult> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.mergePrFromParams(params);
}

/**
 * Interface-agnostic function to clone a repository
 * MODULARIZED: Delegates to modular operation
 */
export async function cloneFromParams(
  params: {
  url: string;
  workdir: string; // Explicit workdir path
  session?: string;
  branch?: string;
  },
  deps?: GitOperationDependencies
): Promise<CloneResult> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.cloneFromParams(params);
}

/**
 * Interface-agnostic function to create a branch
 * MODULARIZED: Delegates to modular operation
 */
export async function branchFromParams(
  params: {
  session: string;
  name: string;
  },
  deps?: GitOperationDependencies
): Promise<BranchResult> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.branchFromParams(params);
}

/**
 * Interface-agnostic function to push changes to a remote repository
 * MODULARIZED: Delegates to modular operation
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
): Promise<PushResult> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.pushFromParams(params);
}

/**
 * Interface-agnostic function to merge branches with conflict detection
 * MODULARIZED: Delegates to modular operation
 */
export async function mergeFromParams(
  params: {
  sourceBranch: string;
  targetBranch?: string;
  session?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
  },
  deps?: GitOperationDependencies
): Promise<EnhancedMergeResult> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.mergeFromParams(params);
}

/**
 * Interface-agnostic function to checkout/switch branches with conflict detection
 * MODULARIZED: Delegates to modular operation
 */
export async function checkoutFromParams(
  params: {
  branch: string;
  session?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
  },
  deps?: GitOperationDependencies
): Promise<{
  workdir: string;
  switched: boolean;
  conflicts: boolean;
  conflictDetails?: string;
  warning?: { wouldLoseChanges: boolean; recommendedAction: string };
}> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.checkoutFromParams(params);
}

/**
 * Interface-agnostic function to rebase branches with conflict detection
 * MODULARIZED: Delegates to modular operation
 */
export async function rebaseFromParams(
  params: {
  baseBranch: string;
  featureBranch?: string;
  session?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
  },
  deps?: GitOperationDependencies
): Promise<{
  workdir: string;
  rebased: boolean;
  conflicts: boolean;
  conflictDetails?: string;
  prediction?: {
    canAutoResolve: boolean;
    recommendations: string[];
    overallComplexity: string;
  };
}> {
  const manager = deps ? createModularGitCommandsManager(deps) : modularGitCommandsManager;
  return await manager.rebaseFromParams(params);
}