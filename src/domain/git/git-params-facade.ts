/**
 * Git *FromParams Facade Functions
 *
 * Interface-agnostic delegation functions that wrap modularGitCommandsManager methods.
 * Extracted from git.ts to reduce file size while preserving the public API.
 *
 * Session resolution is NOT performed here — callers must resolve session UUIDs
 * to repo paths before calling these functions.
 */
import { modularGitCommandsManager } from "./git-commands-modular";
import type { MergePrResult } from "./merge-pr-operations";
import type { CloneResult } from "./clone-operations";
import type { PushResult } from "./push-operations";
import type { BranchResult, PrResult } from "./types";
import type { EnhancedMergeResult } from "./conflict-detection";

/**
 * Interface-agnostic function to create a pull request
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
 */
export async function commitChangesFromParams(params: {
  message: string;
  repo?: string;
  all?: boolean;
  amend?: boolean;
  noStage?: boolean;
}): Promise<{ commitHash: string; message: string }> {
  return await modularGitCommandsManager.commitChangesFromParams(params);
}

/**
 * Interface-agnostic function to merge a PR branch
 */
export async function mergePrFromParams(params: {
  prBranch: string;
  repo?: string;
  baseBranch?: string;
}): Promise<MergePrResult> {
  return await modularGitCommandsManager.mergePrFromParams(params);
}

/**
 * Interface-agnostic function to clone a repository
 */
export async function cloneFromParams(params: {
  url: string;
  workdir: string;
  session?: string;
  branch?: string;
}): Promise<CloneResult> {
  return await modularGitCommandsManager.cloneFromParams(params);
}

/**
 * Interface-agnostic function to create a branch
 */
export async function branchFromParams(params: {
  session: string;
  name: string;
}): Promise<BranchResult> {
  return await modularGitCommandsManager.branchFromParams(params);
}

/**
 * Interface-agnostic function to push changes to a remote repository
 */
export async function pushFromParams(params: {
  repo?: string;
  remote?: string;
  force?: boolean;
  debug?: boolean;
}): Promise<PushResult> {
  return await modularGitCommandsManager.pushFromParams(params);
}

/**
 * Interface-agnostic function to merge branches with conflict detection
 */
export async function mergeFromParams(params: {
  sourceBranch: string;
  targetBranch?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}): Promise<EnhancedMergeResult> {
  return await modularGitCommandsManager.mergeFromParams(params);
}

/**
 * Interface-agnostic function to checkout/switch branches with conflict detection
 */
export async function checkoutFromParams(params: {
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
  return await modularGitCommandsManager.checkoutFromParams(params);
}

/**
 * Interface-agnostic function to rebase branches with conflict detection
 */
export async function rebaseFromParams(params: {
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
  prediction?: {
    canAutoResolve: boolean;
    recommendations: string[];
    overallComplexity: string;
  };
}> {
  return await modularGitCommandsManager.rebaseFromParams(params);
}
