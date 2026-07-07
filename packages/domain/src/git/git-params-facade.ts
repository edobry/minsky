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
import { execAsync } from "@minsky/shared/exec";
import { pullImpl, type PullImplResult } from "./pull-operations";
import { statusImpl, type StatusResult } from "./status-operations";
import {
  stashImpl,
  stashPopImpl,
  stashListImpl,
  stashDropImpl,
  type StashImplResult,
  type StashPopResult,
  type StashListResult,
  type StashDropResult,
} from "./stash-operations";
import { restoreImpl, type RestoreResult } from "./restore-operations";
import { resetImpl, type ResetResult } from "./reset-operations";

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
  files?: string[];
  /** Pass `--allow-empty` through to `git commit` (mt#2635). */
  allowEmpty?: boolean;
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
  authToken?: string;
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

/** Default deps using project execAsync */
const defaultExecDeps = { execAsync };

/**
 * Pull latest changes from remote using --ff-only.
 */
export async function pullFromParams(params: {
  repo?: string;
  remote?: string;
  branch?: string;
}): Promise<PullImplResult> {
  return pullImpl(
    { repoPath: params.repo, remote: params.remote, branch: params.branch },
    defaultExecDeps
  );
}

/**
 * Get working tree status for the main workspace.
 */
export async function statusFromParams(params: { repo?: string }): Promise<StatusResult> {
  return statusImpl({ repoPath: params.repo }, defaultExecDeps);
}

/**
 * Push changes onto the stash.
 */
export async function stashFromParams(params: {
  repo?: string;
  message?: string;
  paths?: string[];
}): Promise<StashImplResult> {
  return stashImpl(
    { repoPath: params.repo, message: params.message, paths: params.paths },
    defaultExecDeps
  );
}

/**
 * Pop the most recent stash (or a specific stash by ref).
 */
export async function stashPopFromParams(params: {
  repo?: string;
  ref?: string;
}): Promise<StashPopResult> {
  return stashPopImpl({ repoPath: params.repo, ref: params.ref }, defaultExecDeps);
}

/**
 * List all stash entries.
 */
export async function stashListFromParams(params: { repo?: string }): Promise<StashListResult> {
  return stashListImpl({ repoPath: params.repo }, defaultExecDeps);
}

/**
 * Drop a specific stash entry (requires confirmDrop: true).
 */
export async function stashDropFromParams(params: {
  repo?: string;
  ref: string;
  confirmDrop: boolean;
}): Promise<StashDropResult> {
  return stashDropImpl(
    { repoPath: params.repo, ref: params.ref, confirmDrop: params.confirmDrop },
    defaultExecDeps
  );
}

/**
 * Restore (discard) unstaged working-tree changes for specific paths.
 */
export async function restoreFromParams(params: {
  repo?: string;
  paths: string[];
}): Promise<RestoreResult> {
  return restoreImpl({ repoPath: params.repo, paths: params.paths }, defaultExecDeps);
}

/**
 * Run git reset with an explicit mode.
 */
export async function resetFromParams(params: {
  repo?: string;
  mode: "soft" | "mixed" | "hard";
  target?: string;
  confirmHard?: boolean;
}): Promise<ResetResult> {
  return resetImpl(
    {
      repoPath: params.repo,
      mode: params.mode,
      target: params.target,
      confirmHard: params.confirmHard,
    },
    defaultExecDeps
  );
}
