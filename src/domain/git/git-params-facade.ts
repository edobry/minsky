/**
 * Git *FromParams Facade Functions
 *
 * Interface-agnostic delegation functions that wrap modularGitCommandsManager methods.
 * Extracted from git.ts to reduce file size while preserving the public API.
 */
import { modularGitCommandsManager } from "./git-commands-modular";
import type { PreparePrResult } from "./prepare-pr-operations";
import type { MergePrResult } from "./merge-pr-operations";
import type { CloneResult } from "./clone-operations";
import type { PushResult } from "./push-operations";
import type { BranchResult, PrResult } from "./types";
import type { EnhancedMergeResult } from "./conflict-detection";

/**
 * Interface-agnostic function to create a pull request
 * MODULARIZED: Delegates to modular operation
 */
export async function createPullRequestFromParams(params: {
  session?: string;
  repo?: string;
  branch?: string;
  taskId?: string;
  debug?: boolean;
  noStatusUpdate?: boolean;
}): Promise<PrResult> {
  return await modularGitCommandsManager.createPullRequestFromParams(params);
}

/**
 * Interface-agnostic function to commit changes
 * MODULARIZED: Delegates to modular operation
 */
export async function commitChangesFromParams(params: {
  message: string;
  session?: string;
  repo?: string;
  all?: boolean;
  amend?: boolean;
  noStage?: boolean;
}): Promise<{ commitHash: string; message: string }> {
  return await modularGitCommandsManager.commitChangesFromParams(params);
}

/**
 * Interface-agnostic function to prepare a PR branch
 * MODULARIZED: Delegates to modular operation
 */
export async function preparePrFromParams(params: {
  session?: string;
  repo?: string;
  baseBranch?: string;
  title?: string;
  body?: string;
  branchName?: string;
  debug?: boolean;
}): Promise<PreparePrResult> {
  return await modularGitCommandsManager.preparePrFromParams(params);
}

/**
 * Interface-agnostic function to merge a PR branch
 * MODULARIZED: Delegates to modular operation
 */
export async function mergePrFromParams(params: {
  prBranch: string;
  repo?: string;
  baseBranch?: string;
  session?: string;
}): Promise<MergePrResult> {
  const { modularGitCommandsManager } = await import("./git-commands-modular");
  return await modularGitCommandsManager.mergePrFromParams(params);
}

/**
 * Interface-agnostic function to clone a repository
 * MODULARIZED: Delegates to modular operation
 */
export async function cloneFromParams(params: {
  url: string;
  workdir: string; // Explicit workdir path
  session?: string;
  branch?: string;
}): Promise<CloneResult> {
  return await modularGitCommandsManager.cloneFromParams(params);
}

/**
 * Interface-agnostic function to create a branch
 * MODULARIZED: Delegates to modular operation
 */
export async function branchFromParams(params: {
  session: string;
  name: string;
}): Promise<BranchResult> {
  const { modularGitCommandsManager } = await import("./git-commands-modular");
  return await modularGitCommandsManager.branchFromParams(params);
}

/**
 * Interface-agnostic function to push changes to a remote repository
 * MODULARIZED: Delegates to modular operation
 */
export async function pushFromParams(params: {
  session?: string;
  repo?: string;
  remote?: string;
  force?: boolean;
  debug?: boolean;
}): Promise<PushResult> {
  const { modularGitCommandsManager } = await import("./git-commands-modular");
  return await modularGitCommandsManager.pushFromParams(params);
}

/**
 * Interface-agnostic function to merge branches with conflict detection
 * MODULARIZED: Delegates to modular operation
 */
export async function mergeFromParams(params: {
  sourceBranch: string;
  targetBranch?: string;
  session?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}): Promise<EnhancedMergeResult> {
  const { modularGitCommandsManager } = await import("./git-commands-modular");
  return await modularGitCommandsManager.mergeFromParams(params);
}

/**
 * Interface-agnostic function to checkout/switch branches with conflict detection
 * MODULARIZED: Delegates to modular operation
 */
export async function checkoutFromParams(params: {
  branch: string;
  session?: string;
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
  const { modularGitCommandsManager } = await import("./git-commands-modular");
  return await modularGitCommandsManager.checkoutFromParams(params);
}

/**
 * Interface-agnostic function to rebase branches with conflict detection
 * MODULARIZED: Delegates to modular operation
 */
export async function rebaseFromParams(params: {
  baseBranch: string;
  featureBranch?: string;
  session?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}): Promise<{
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
  const { modularGitCommandsManager } = await import("./git-commands-modular");
  return await modularGitCommandsManager.rebaseFromParams(params);
}
