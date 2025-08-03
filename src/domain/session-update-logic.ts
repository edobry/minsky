/**
 * Pure functions for session update conditional logic
 * Extracted for unit testing without complex git dependencies
 */

export interface SessionUpdateOptions {
  noStash?: boolean;
  noPush?: boolean;
  force?: boolean;
}

export interface SessionUpdateState {
  hasUncommittedChanges: boolean;
  workdir: string;
}

/**
 * Determines if changes should be stashed based on conditions
 * @param options - Update options from user
 * @param state - Current session state
 * @returns true if stashing should occur
 */
export function shouldStashChanges(
  options: SessionUpdateOptions,
  state: SessionUpdateState
): boolean {
  // Don't stash if force is used
  if (options.force) {
    return false;
  }

  // Don't stash if noStash flag is set
  if (options.noStash) {
    return false;
  }

  // Only stash if there are uncommitted changes
  return state.hasUncommittedChanges;
}

/**
 * Determines if stashed changes should be restored
 * @param options - Update options from user
 * @returns true if stash should be restored
 */
export function shouldRestoreStash(options: SessionUpdateOptions): boolean {
  // Only restore if we didn't skip stashing
  return !options.noStash;
}

/**
 * Determines if changes should be pushed to remote
 * @param options - Update options from user
 * @returns true if pushing should occur
 */
export function shouldPushChanges(options: SessionUpdateOptions): boolean {
  // Only push if noPush flag is not set
  return !options.noPush;
}

/**
 * Determines the git operations that should be performed
 * @param options - Update options from user
 * @param state - Current session state
 * @returns object describing which operations to perform
 */
export function determineGitOperations(
  options: SessionUpdateOptions,
  state: SessionUpdateState
): {
  shouldStash: boolean;
  shouldPush: boolean;
  shouldRestoreStash: boolean;
} {
  return {
    shouldStash: shouldStashChanges(options, state),
    shouldPush: shouldPushChanges(options),
    shouldRestoreStash: shouldRestoreStash(options),
  };
}
