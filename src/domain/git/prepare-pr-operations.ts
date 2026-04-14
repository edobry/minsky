import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import type { SessionProviderInterface } from "../session";
import { createPreparedMergeCommitPR } from "./prepared-merge-commit-workflow";

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
  let existingPrMessage: string | undefined;

  try {
    // Enhanced PR branch cleanup with automatic recovery

    try {
      await deps.execInRepository(workdir, `git rev-parse --verify ${prBranch}`);

      // Branch exists - use recovery function to handle any corrupted state
      log.debug(`PR branch ${prBranch} exists, attempting recovery cleanup`);

      const recovery = await attemptPrBranchRecovery(workdir, prBranch, deps, {
        preserveCommitMessage: !options.title, // Only preserve if no new title provided
      });

      existingPrMessage = recovery.preservedMessage;

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

  // Create commit message for merge commit (Task #025)
  try {
    // Use preserved message from recovery if no new title provided
    let commitMessage =
      options.title || existingPrMessage || `Merge ${sourceBranch} into ${prBranch}`;
    if (options.body) {
      commitMessage += `\n\n${options.body}`;
    }

    // If we're reusing a preserved message, log it for transparency
    if (!options.title && existingPrMessage) {
      log.cli("📝 Reusing commit message from recovered PR branch");
    }

    log.debug("Prepared commit message for merge commit", {
      commitMessage,
      sourceBranch,
      prBranch,
    });

    // DELEGATE to conflict-checking workflow instead of duplicating logic
    // This ensures both code paths use the same conflict validation
    try {
      await createPreparedMergeCommitPR(
        {
          title: options.title || `Merge ${sourceBranch} into ${prBranch}`,
          body: options.body || "",
          sourceBranch,
          baseBranch,
          workdir,
          session: options.session,
        },
        {
          execGitWithTimeout: async (
            operation: string,
            command: string,
            options?: { workdir?: string; timeout?: number }
          ) => {
            const result = await deps.execInRepository(options?.workdir ?? "", `git ${command}`);
            return {
              stdout: result,
              stderr: "",
              command: `git ${command}`,
              workdir: options?.workdir,
              executionTimeMs: 0,
            };
          },
          predictConflicts: async (workdir: string, sourceBranch: string, baseBranch: string) => {
            return {
              hasConflicts: false,
              conflictType: "none",
              userGuidance: "",
            };
          },
        }
      );

      log.debug("✅ Delegated to createPreparedMergeCommitPR successfully");
    } catch (error) {
      log.debug("❌ createPreparedMergeCommitPR failed", {
        error: getErrorMessage(error),
        sourceBranch,
        prBranch,
        workdir,
      });
      throw error; // Re-throw to maintain error handling behavior
    }

    // 🔥 DEBUG: Log after successful merge
    log.debug("🔥 DEBUG: Merge completed successfully", {
      sourceBranch,
      prBranch,
    });

    // VERIFICATION: Check that the merge commit has the correct message
    const logOutput = await deps.execInRepository(workdir, "git log -1 --pretty=format:%B");
    const actualTitle = logOutput.trim().split("\n")[0];
    const expectedTitle = commitMessage.split("\n")[0];

    if (actualTitle !== expectedTitle) {
      log.warn("Commit message mismatch detected", {
        expected: expectedTitle,
        actual: actualTitle,
        fullExpected: commitMessage,
        fullActual: logOutput.trim(),
      });
      // Don't throw error but log the issue for debugging
    } else {
      log.debug("✅ Verified merge commit message is correct", {
        commitMessage: actualTitle,
      });
    }

    log.debug(`Created prepared merge commit by merging ${sourceBranch} into ${prBranch}`);
  } catch (err) {
    // 🔥 DEBUG: Log merge error details
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.debug("🔥 DEBUG: Merge failed with error", {
      error: errorMessage,
      errorType: err?.constructor?.name,
      sourceBranch,
      prBranch,
      workdir,
    });

    // Check for conflict errors FIRST - before any cleanup
    if (
      errorMessage.includes("CONFLICT") ||
      errorMessage.includes("Automatic merge failed") ||
      errorMessage.includes("💥 Merge Conflicts Detected")
    ) {
      // DON'T clean up on conflict - leave user in natural git merge conflict state
      // This allows them to use standard git workflow to resolve conflicts
      log.debug("Merge conflicts detected - staying in conflict state for user resolution", {
        prBranch,
        sourceBranch,
        workdir,
      });

      throw new MinskyError(
        `🔥 Session PR creation encountered merge conflicts.

You are currently on branch '${prBranch}' with merge in progress.

To resolve conflicts and complete the PR:

1. 🔍 Check current status:
   git status

2. ✏️ Resolve conflicts manually (recommended):
   code <conflicted-file>
   # Then stage and commit resolved files:
   git add <resolved-files>
   git commit --no-edit

3. 🚀 Or accept all session changes (use with caution):
   git checkout --theirs . && git add . && git merge --continue

4. 🔄 Or accept all main branch changes (use with caution):
   git checkout --ours . && git add . && git merge --continue

After resolving conflicts, re-run the PR creation command to complete the process.`,
        { exitCode: 4 }
      );
    }

    // For non-conflict errors, clean up and switch back
    try {
      await deps.execInRepository(workdir, "git merge --abort");
      await deps.execInRepository(workdir, `git switch ${sourceBranch}`);
      log.debug("Cleaned up after non-conflict merge error");
    } catch (cleanupErr) {
      log.warn("Failed to clean up after non-conflict merge error", { cleanupErr });
    }

    throw new MinskyError(`Failed to create prepared merge commit: ${getErrorMessage(err)}`);
  }

  // Push changes to the PR branch with timeout handling
  try {
    if (deps.gitPush) {
      await deps.gitPush(workdir, prBranch, 30000);
    }
    log.debug(`Successfully pushed PR branch ${prBranch} to remote`);
  } catch (error) {
    throw new MinskyError(`Failed to push PR branch to remote: ${getErrorMessage(error)}`);
  }

  // CRITICAL: Always switch back to the original session branch after creating PR branch
  // This ensures session pr command never leaves user on the PR branch
  try {
    await deps.execInRepository(workdir, `git switch ${sourceBranch}`);
    log.debug(`✅ Switched back to session branch ${sourceBranch} after creating PR branch`);
  } catch (err) {
    log.warn(`Failed to switch back to original branch ${sourceBranch}: ${getErrorMessage(err)}`);
  }

  return {
    prBranch,
    baseBranch,
    title: options.title,
    body: options.body,
  };
}
