import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import type { SessionProviderInterface } from "../session";
// TODO: mt#881 — remove after GitService cleanup
// import { createPreparedMergeCommitPR } from "./prepared-merge-commit-workflow";

// execAsync is now injected via deps.execAsync

/**
 * Attempts to recover from corrupted PR branch state
 * Since PR branches are throwaway, we can aggressively clean them up
 */
async function attemptPrBranchRecovery(
  workdir: string,
  prBranch: string,
  deps: { execInRepository: (workdir: string, command: string) => Promise<string> },
  options: { preserveCommitMessage?: boolean } = {}
): Promise<{ recovered: boolean; preservedMessage?: string }> {
  log.debug("Attempting PR branch recovery", { prBranch, workdir });

  let preservedMessage: string | undefined;

  // Try to preserve commit message before cleanup
  if (options.preserveCommitMessage) {
    try {
      preservedMessage = await deps.execInRepository(
        workdir,
        `git log -1 --pretty=format:%B ${prBranch}`
      );
      log.debug("Preserved commit message from existing PR branch", {
        prBranch,
        messageLength: preservedMessage.length,
      });
    } catch {
      // Ignore errors - branch might not exist or be corrupted
    }
  }

  // Aggressive cleanup operations (all failures ignored)
  const cleanupOps = [
    "git merge --abort",
    "git rebase --abort",
    "git reset --hard HEAD",
    `git branch -D ${prBranch}`,
    `git push origin --delete ${prBranch}`,
  ];

  for (const cmd of cleanupOps) {
    try {
      await deps.execInRepository(workdir, cmd);
    } catch {
      // Ignore all cleanup errors
    }
  }

  log.debug("PR branch recovery completed", { prBranch });
  return { recovered: true, preservedMessage };
}

export interface PreparePrOptions {
  session?: string;
  repoPath?: string;
  baseBranch?: string;
  title?: string;
  body?: string;
  debug?: boolean;
  branchName?: string;
}

export interface PreparePrResult {
  prBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
}

export interface PreparePrDependencies {
  sessionDb: SessionProviderInterface;
  getSessionWorkdir: (session: string) => string;
  execInRepository: (workdir: string, command: string) => Promise<string>;
  gitFetch?: (workdir: string, timeout?: number) => Promise<void>;
  gitPush?: (workdir: string, branch: string, timeout?: number) => Promise<void>;
  execAsync?: (command: string) => Promise<{ stdout: string; stderr: string }>;
  push?: (options: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Prepares a pull request by creating a PR branch and merging changes
 *
 * @param options - PR preparation options
 * @param deps - Injected dependencies
 * @returns PR preparation result
 */
export async function preparePrImpl(
  options: PreparePrOptions,
  deps: PreparePrDependencies
): Promise<PreparePrResult> {
  let workdir: string;
  let sourceBranch: string;
  const baseBranch = options.baseBranch || "main";

  // Add debugging for session lookup
  if (options.session) {
    log.debug(`Attempting to look up session in database: ${options.session}`);
  }

  // Determine working directory and current branch
  if (options.session) {
    const record = await deps.sessionDb.getSession(options.session);

    // Add more detailed debugging
    log.debug(
      `Session database lookup result: ${options.session}, found: ${!!record}, recordData: ${record ? JSON.stringify({ repoName: record.repoName, repoUrl: record.repoUrl, taskId: record.taskId }) : "null"}`
    );

    if (!record) {
      throw new MinskyError(
        `Session "${options.session}" not found. ` +
          `The session database (with auto-repair) could not locate this session.\n\n` +
          `💡 Try:\n` +
          `  minsky session list              (see registered sessions)\n` +
          `  minsky session start --task ID   (create a new session)\n`
      );
    }
    workdir = deps.getSessionWorkdir(options.session);
    // Get current branch from repo instead of assuming session ID is branch name
    sourceBranch = await deps.execInRepository(workdir, "git rev-parse --abbrev-ref HEAD");
  } else if (options.repoPath) {
    workdir = options.repoPath;
    // Get current branch from repo
    sourceBranch = await deps.execInRepository(workdir, "git rev-parse --abbrev-ref HEAD");
  } else {
    // Try to infer from current directory
    workdir = process.cwd();
    // Get current branch from cwd
    sourceBranch = await deps.execInRepository(workdir, "git rev-parse --abbrev-ref HEAD");
  }

  // CRITICAL: PR creation must only be from session branches, not PR branches
  if (sourceBranch.startsWith("pr/")) {
    throw new MinskyError(
      `Cannot create PR from PR branch '${sourceBranch}'. ` +
        `PRs must be created from session branches only. ` +
        `Switch to your session branch first (e.g., '${sourceBranch.slice(3)}').`
    );
  }

  // Create PR branch name with pr/ prefix - always use the current git branch name
  // Fix for task #95: Don't use title for branch naming
  const prBranchName = options.branchName || sourceBranch;
  const prBranch = `pr/${prBranchName}`;

  log.debug("Creating PR branch using git branch as basis", {
    sourceBranch,
    prBranch,
    usedProvidedBranchName: Boolean(options.branchName),
  });

  // Verify base branch exists
  try {
    await deps.execInRepository(workdir, `git rev-parse --verify ${baseBranch}`);
  } catch (err) {
    throw new MinskyError(`Base branch '${baseBranch}' does not exist or is not accessible`);
  }

  // Make sure we have the latest from the base branch
  if (deps.gitFetch) {
    await deps.gitFetch(workdir, 30000);
  }

  // Create PR branch FROM base branch (not feature branch) - per Task #025
  let _existingPrMessage: string | undefined;

  try {
    // Enhanced PR branch cleanup with automatic recovery

    try {
      await deps.execInRepository(workdir, `git rev-parse --verify ${prBranch}`);

      // Branch exists - use recovery function to handle any corrupted state
      log.debug(`PR branch ${prBranch} exists, attempting recovery cleanup`);

      const recovery = await attemptPrBranchRecovery(workdir, prBranch, deps, {
        preserveCommitMessage: !options.title, // Only preserve if no new title provided
      });

      _existingPrMessage = recovery.preservedMessage;

      if (recovery.recovered) {
        log.cli(`🔧 Cleaned up existing PR branch state (${prBranch})`);
      }
    } catch {
      // Branch doesn't exist, which is fine
      log.debug(`PR branch ${prBranch} doesn't exist locally`);
    }

    // Fix for origin/origin/main bug: Don't prepend origin/ if baseBranch already has it
    const remoteBaseBranch = baseBranch.startsWith("origin/") ? baseBranch : `origin/${baseBranch}`;

    // Create PR branch FROM base branch WITHOUT checking it out (Task #025 specification)
    // Use git branch instead of git switch to avoid checking out the PR branch
    await deps.execInRepository(workdir, `git branch ${prBranch} ${remoteBaseBranch}`);
    log.debug(`Created PR branch ${prBranch} from ${remoteBaseBranch} without checking it out`);
  } catch (err) {
    throw new MinskyError(`Failed to create PR branch: ${getErrorMessage(err)}`);
  }

  // TODO: mt#881 — remove this entire file after GitService cleanup
  throw new MinskyError(
    "prepare-pr-operations: prepared merge commit workflow has been removed. See mt#881."
  );
}
