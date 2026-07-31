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
import { gitStatsImpl, type GitStatsResult } from "./stats-operations";
import { detectIndexLock, repairIndexLock } from "./lock-operations";
import {
  checkRef,
  scanForBadRefs,
  repairBadRef,
  type BadRefCheckResult,
} from "./ref-repair-operations";

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

/**
 * Bound the wall-clock time any single git_* main-workspace-ops subprocess
 * may run before `executeCommand` (packages/shared/src/exec.ts) sends its
 * hardcoded `killSignal: "SIGTERM"` (per Node's `child_process.exec` timeout
 * option) — mt#2820 root-cause hardening.
 *
 * Prior to this change, NONE of git_status/git_restore/git_pull/git_stash
 * (or its pop/list/drop siblings)/git_reset passed a `timeout` option, so
 * Node's exec() never times out on
 * its own: a wedged subprocess (credential prompt, filesystem stall, or any
 * other hang) would run indefinitely, holding `.git/index.lock` for as long
 * as it stayed alive. A bounded, SIGTERM-first timeout gives git's own
 * lockfile signal handler (`lockfile.c` chains SIGINT/SIGTERM/SIGHUP/SIGQUIT
 * to clean up pending lockfiles) a chance to self-remove the lock on
 * termination, instead of relying on this task's after-the-fact repair tool
 * to clean up every time.
 *
 * 60s is chosen because: every op in this family except `pull` is a purely
 * local, single-command invocation that normally completes in well under a
 * second; `pull`'s network round-trip to `origin` rarely exceeds a few
 * seconds even on a slow connection. 60s is comfortably above any observed
 * duration for these commands while still bounding a genuine hang to a
 * reasonable wait — a large multiple of the MCP server's own 30s
 * staleness-drain cap (`staleDrainCapMs`, mt#2701), not an arbitrary round
 * number.
 *
 * NOTE: this does NOT fully close the class of abandoned-lock incidents
 * this task investigates — a subprocess orphaned by the PARENT MCP server
 * process itself exiting (rather than hanging) is not reached by an
 * in-process timeout, since the timer dies with the process. See the
 * root-cause investigation notes in this task's spec/PR body and the filed
 * follow-up task for the residual cross-process race.
 */
const GIT_EXEC_TIMEOUT_MS = 60_000;

/** Default deps using project execAsync, bounded by GIT_EXEC_TIMEOUT_MS. */
const defaultExecDeps = {
  execAsync: (command: string, options?: Record<string, unknown>) =>
    execAsync(command, { timeout: GIT_EXEC_TIMEOUT_MS, ...options }),
};

/**
 * Pull latest changes from remote using --ff-only.
 */
export async function pullFromParams(params: {
  repo?: string;
  remote?: string;
  branch?: string;
  repairLock?: boolean;
}): Promise<PullImplResult> {
  return pullImpl(
    {
      repoPath: params.repo,
      remote: params.remote,
      branch: params.branch,
      repairLock: params.repairLock,
    },
    defaultExecDeps
  );
}

/**
 * Get working tree status for the main workspace.
 */
export async function statusFromParams(params: {
  repo?: string;
  repairLock?: boolean;
}): Promise<StatusResult> {
  return statusImpl({ repoPath: params.repo, repairLock: params.repairLock }, defaultExecDeps);
}

/**
 * Push changes onto the stash.
 */
export async function stashFromParams(params: {
  repo?: string;
  message?: string;
  paths?: string[];
  repairLock?: boolean;
}): Promise<StashImplResult> {
  return stashImpl(
    {
      repoPath: params.repo,
      message: params.message,
      paths: params.paths,
      repairLock: params.repairLock,
    },
    defaultExecDeps
  );
}

/**
 * Pop the most recent stash (or a specific stash by ref).
 */
export async function stashPopFromParams(params: {
  repo?: string;
  ref?: string;
  repairLock?: boolean;
}): Promise<StashPopResult> {
  return stashPopImpl(
    { repoPath: params.repo, ref: params.ref, repairLock: params.repairLock },
    defaultExecDeps
  );
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
  repairLock?: boolean;
}): Promise<RestoreResult> {
  return restoreImpl(
    { repoPath: params.repo, paths: params.paths, repairLock: params.repairLock },
    defaultExecDeps
  );
}

/**
 * Run git reset with an explicit mode.
 */
export async function resetFromParams(params: {
  repo?: string;
  mode: "soft" | "mixed" | "hard";
  target?: string;
  confirmHard?: boolean;
  repairLock?: boolean;
}): Promise<ResetResult> {
  return resetImpl(
    {
      repoPath: params.repo,
      mode: params.mode,
      target: params.target,
      confirmHard: params.confirmHard,
      repairLock: params.repairLock,
    },
    defaultExecDeps
  );
}

/**
 * Compute per-path churn (commit count + insertions/deletions) over a
 * window via `git log --numstat` (or `--name-only` when `nameOnly` is set).
 * The sanctioned MCP path for repo-analytics queries the block-git-gh-cli
 * hook denies on Bash (mt#2624).
 */
export async function gitStatsFromParams(params: {
  repo?: string;
  since?: string;
  until?: string;
  path?: string;
  author?: string;
  nameOnly?: boolean;
  limit?: number;
}): Promise<GitStatsResult> {
  return gitStatsImpl(
    {
      repoPath: params.repo,
      since: params.since,
      until: params.until,
      path: params.path,
      author: params.author,
      nameOnly: params.nameOnly,
      limit: params.limit,
    },
    defaultExecDeps
  );
}

// ---------------------------------------------------------------------------
// git_repair_lock (mt#2820)
// ---------------------------------------------------------------------------

export interface GitLockRepairFromParamsResult {
  present: boolean;
  lockPath?: string;
  ageMs?: number;
  sizeBytes?: number;
  liveProcess?: boolean;
  holderPid?: number;
  livenessDetermined?: boolean;
  /** true when the lock has no live owner AND has aged past the staleness threshold. */
  staleEligible?: boolean;
  removed: boolean;
  message: string;
}

/**
 * Inspect (and, with `confirm: true`, repair) a `.git/index.lock`.
 *
 * Without `confirm`: pure diagnostic — reports presence, age, size, and
 * owning-process liveness, with no mutation.
 *
 * With `confirm: true`: attempts removal. Throws (does not silently no-op)
 * when the lock is held by a live process or its staleness is ambiguous —
 * see `repairIndexLock` for the exact refusal conditions.
 */
export async function repairGitLockFromParams(params: {
  repo?: string;
  confirm?: boolean;
  /**
   * Override `LOCK_STALE_THRESHOLD_MS` for this call (PR #1986 R1). Useful
   * when an operator's environment routinely runs git_* ops longer than the
   * 10-minute incident-grounded default (or wants a tighter bound).
   */
  staleThresholdMs?: number;
}): Promise<GitLockRepairFromParamsResult> {
  const info = await detectIndexLock(
    { repoPath: params.repo, staleThresholdMs: params.staleThresholdMs },
    defaultExecDeps
  );
  if (!info) {
    return { present: false, removed: false, message: "No index.lock present." };
  }

  const staleEligible =
    info.livenessDetermined && !info.liveProcess && info.ageMs >= info.staleThresholdMs;

  const base = {
    present: true,
    lockPath: info.lockPath,
    ageMs: info.ageMs,
    sizeBytes: info.sizeBytes,
    liveProcess: info.liveProcess,
    holderPid: info.holderPid,
    livenessDetermined: info.livenessDetermined,
    staleEligible,
  };

  if (!params.confirm) {
    const ageMinutes = (info.ageMs / 60_000).toFixed(1);
    return {
      ...base,
      removed: false,
      message: staleEligible
        ? `Lock appears stale (age ${ageMinutes}m, no live process) — pass confirm: true to remove it.`
        : info.liveProcess
          ? `Lock is held by a live process (PID ${info.holderPid ?? "unknown"}) — busy.`
          : `Lock is present but not yet stale-eligible (age ${ageMinutes}m below threshold).`,
    };
  }

  const result = await repairIndexLock(
    { repoPath: params.repo, confirm: true, staleThresholdMs: params.staleThresholdMs },
    defaultExecDeps
  );
  return {
    ...base,
    removed: result.removed,
    message: result.removed ? `Removed stale lock at ${result.lockPath}.` : "Lock not removed.",
  };
}

// ---------------------------------------------------------------------------
// git_repair_refs (mt#2820)
// ---------------------------------------------------------------------------

/**
 * Scan refs under a prefix (default `refs/remotes/origin`) for corruption.
 * Read-only — no repair. Use `repairGitRefFromParams` to fix a specific ref.
 */
export async function scanGitRefsFromParams(params: {
  repo?: string;
  refPrefix?: string;
}): Promise<{ results: BadRefCheckResult[] }> {
  const results = await scanForBadRefs(
    { repoPath: params.repo, refPrefix: params.refPrefix },
    defaultExecDeps
  );
  return { results };
}

export interface GitRefRepairFromParamsResult {
  ref: string;
  bad: boolean;
  error?: string;
  deleted: boolean;
  refetched: boolean;
  remote?: string;
}

/**
 * Inspect (and, with `confirm: true`, repair) a single remote-tracking ref.
 *
 * Without `confirm`: pure diagnostic (identify — is this ref bad?).
 * With `confirm: true`: delete + re-fetch. Refuses (throws) if the ref
 * turns out to be healthy — never deletes a ref that isn't actually bad.
 */
export async function repairGitRefFromParams(params: {
  repo?: string;
  ref: string;
  confirm?: boolean;
  remote?: string;
}): Promise<GitRefRepairFromParamsResult> {
  if (!params.confirm) {
    const check = await checkRef({ repoPath: params.repo, ref: params.ref }, defaultExecDeps);
    return {
      ref: params.ref,
      bad: check.bad,
      error: check.error,
      deleted: false,
      refetched: false,
    };
  }
  const result = await repairBadRef(
    { repoPath: params.repo, ref: params.ref, confirm: true, remote: params.remote },
    defaultExecDeps
  );
  return {
    ref: result.ref,
    bad: true,
    deleted: result.deleted,
    refetched: result.refetched,
    remote: result.remote,
  };
}
