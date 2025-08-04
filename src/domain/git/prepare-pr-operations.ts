import { promisify } from "node:util";
import { exec } from "node:child_process";
import { normalizeRepoName } from "../repo-utils";
import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import type { SessionRecord, SessionProviderInterface } from "../session";
import { sessionNameToTaskId } from "../tasks/unified-task-id";
import {
  SessionMultiBackendIntegration,
  type MultiBackendSessionRecord,
} from "../session/multi-backend-integration";
import {
  execGitWithTimeout,
  gitFetchWithTimeout,
  gitPushWithTimeout,
  type GitExecOptions,
} from "../../utils/git-exec";

const execAsync = promisify(exec);

/**
 * Attempts to recover from corrupted PR branch state
 * Since PR branches are throwaway, we can aggressively clean them up
 */
async function attemptPrBranchRecovery(
  workdir: string,
  prBranch: string,
  options: { preserveCommitMessage?: boolean } = {}
): Promise<{ recovered: boolean; preservedMessage?: string }> {
  log.debug("Attempting PR branch recovery", { prBranch, workdir });

  let preservedMessage: string | undefined;

  // Try to preserve commit message before cleanup
  if (options.preserveCommitMessage) {
    try {
      const logResult = await execGitWithTimeout("log", `log -1 --pretty=format:%B ${prBranch}`, {
        workdir,
        timeout: 5000,
      });
      preservedMessage = logResult.stdout.trim();
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
    "merge --abort",
    "rebase --abort",
    "reset --hard HEAD",
    `branch -D ${prBranch}`,
    `push origin --delete ${prBranch}`,
  ];

  for (const cmd of cleanupOps) {
    try {
      await execGitWithTimeout("cleanup", cmd, { workdir, timeout: 10000 });
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
    let record = await deps.sessionDb.getSession(options.session);

    // Add more detailed debugging
    log.debug(
      `Session database lookup result: ${options.session}, found: ${!!record}, recordData: ${record ? JSON.stringify({ repoName: record.repoName, repoUrl: record.repoUrl, taskId: record.taskId }) : "null"}`
    );

    // TASK #168 FIX: Implement session self-repair for preparePr
    if (!record) {
      log.debug("Session not found in database, attempting self-repair in preparePr", {
        session: options.session,
      });

      // Check if we're currently in a session workspace directory
      const currentDir = (process as any).cwd();
      const pathParts = currentDir.split("/");
      const sessionsIndex = pathParts.indexOf("sessions");

      if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
        const sessionNameFromPath = pathParts[sessionsIndex + 1];

        // If the session name matches the one we're looking for, attempt self-repair
        if (sessionNameFromPath === options.session) {
          log.debug("Attempting to register orphaned session in preparePr", {
            session: options.session,
            currentDir,
          });

          try {
            // Get the repository URL from git remote
            const repoUrl = await deps.execInRepository(currentDir, "git remote get-url origin");
            const repoName = normalizeRepoName(repoUrl.trim());

            // Extract task ID from session name using proper utilities
            let taskId = sessionNameToTaskId(options.session);

            // Handle legacy patterns - extract plain numbers for enhancement to handle properly
            const legacyPlainMatch = options.session.match(/^task(\d+)$/); // task123 → 123
            const legacyHashMatch = options.session.match(/^task#(\d+)$/); // task#456 → 456

            if (legacyPlainMatch) {
              taskId = legacyPlainMatch[1]; // Keep as plain number for enhancement to handle
            } else if (legacyHashMatch) {
              taskId = legacyHashMatch[1]; // Keep as plain number for enhancement to handle
            }

            // Create basic session record
            const basicSessionRecord: SessionRecord = {
              session: options.session,
              repoUrl: repoUrl.trim(),
              repoName,
              createdAt: new Date().toISOString(),
              taskId: taskId !== options.session ? taskId : undefined, // Only set if valid task ID
              branch: options.session,
            };

            // Enhance with multi-backend support
            const enhancedRecord =
              SessionMultiBackendIntegration.enhanceSessionRecord(basicSessionRecord);

            // Ensure legacyTaskId is always explicitly set for test compatibility
            const newSessionRecord = {
              ...enhancedRecord,
              legacyTaskId: enhancedRecord.legacyTaskId ?? undefined,
            };

            // Register the session
            await deps.sessionDb.addSession(newSessionRecord);
            record = newSessionRecord;

            log.debug("Successfully registered orphaned session in preparePr", {
              session: options.session,
              repoUrl: repoUrl.trim(),
              taskId,
            });
          } catch (selfRepairError) {
            log.debug("Session self-repair failed in preparePr", {
              session: options.session,
              error: selfRepairError,
            });

            // Before throwing error, let's try to understand what sessions are in the database
            try {
              const allSessions = await deps.sessionDb.listSessions();
              log.debug(
                `All sessions in database: count=${allSessions.length}, sessionNames=${allSessions
                  .map((s) => s.session)
                  .slice(0, 10)
                  .join(", ")}, searchedFor=${options.session}`
              );
            } catch (listError) {
              log.error(`Failed to list sessions for debugging: ${listError}`);
            }

            throw new MinskyError(`
🔍 Session "${options.session}" Not Found in Database

The session exists in the file system but isn't registered in the session database.
This can happen when sessions are created outside of Minsky or the database gets out of sync.

💡 How to fix this:

📋 Check if session exists on disk:
   ls -la ~/.local/state/minsky/git/*/sessions/

🔄 If session exists, re-register it:
   cd /path/to/main/workspace
   minsky sessions import "${options.session}"

🆕 Or create a fresh session:
   minsky session start ${options.session}

📁 Alternative - use repository path directly:
   minsky session pr --repo "/path/to/session/workspace" --title "Your PR title"

🗃️ Check registered sessions:
   minsky sessions list

⚠️  Note: Session PR commands should be run from within the session directory to enable automatic session self-repair.

Current directory: ${(process as any).cwd()}
Session requested: "${(options as any).session}"
`);
          }
        } else {
          // Before throwing error, let's try to understand what sessions are in the database
          try {
            const allSessions = await deps.sessionDb.listSessions();
            log.debug(
              `All sessions in database: count=${allSessions.length}, sessionNames=${allSessions
                .map((s) => s.session)
                .slice(0, 10)
                .join(", ")}, searchedFor=${options.session}`
            );
          } catch (listError) {
            log.error(`Failed to list sessions for debugging: ${listError}`);
          }

          throw new MinskyError(`
🔍 Session "${options.session}" Not Found in Database

The session exists in the file system but isn't registered in the session database.
This can happen when sessions are created outside of Minsky or the database gets out of sync.

💡 How to fix this:

📋 Check if session exists on disk:
   ls -la ~/.local/state/minsky/git/*/sessions/

🔄 If session exists, re-register it:
   cd /path/to/main/workspace
   minsky sessions import "${options.session}"

🆕 Or create a fresh session:
   minsky session start ${options.session}

📁 Alternative - use repository path directly:
   minsky session pr --repo "/path/to/session/workspace" --title "Your PR title"

🗃️ Check registered sessions:
   minsky sessions list

⚠️  Note: Session PR commands should be run from within the session directory to enable automatic session self-repair.

Current directory: ${(process as any).cwd()}
Session requested: "${(options as any).session}"
`);
        }
      } else {
        // Before throwing error, let's try to understand what sessions are in the database
        try {
          const allSessions = await deps.sessionDb.listSessions();
          log.debug(
            `All sessions in database: count=${allSessions.length}, sessionNames=${allSessions
              .map((s) => s.session)
              .slice(0, 10)
              .join(", ")}, searchedFor=${options.session}`
          );
        } catch (listError) {
          log.error(`Failed to list sessions for debugging: ${listError}`);
        }

        throw new MinskyError(`
🔍 Session "${options.session}" Not Found in Database

The session exists in the file system but isn't registered in the session database.
This can happen when sessions are created outside of Minsky or the database gets out of sync.

💡 How to fix this:

📋 Check if session exists on disk:
   ls -la ~/.local/state/minsky/git/*/sessions/

🔄 If session exists, re-register it:
   cd /path/to/main/workspace
   minsky sessions import "${options.session}"

🆕 Or create a fresh session:
   minsky session start ${options.session}

📁 Alternative - use repository path directly:
   minsky session pr --repo "/path/to/session/workspace" --title "Your PR title"

🗃️ Check registered sessions:
   minsky sessions list

⚠️  Note: Session PR commands should be run from within the session directory to enable automatic session self-repair.

Current directory: ${(process as any).cwd()}
Session requested: "${(options as any).session}"
`);
      }
    }
    const repoName = record.repoName || normalizeRepoName(record.repoUrl);
    workdir = deps.getSessionWorkdir(options.session);
    // Get current branch from repo instead of assuming session name is branch name
    const branchResult = await execGitWithTimeout("rev-parse", "rev-parse --abbrev-ref HEAD", {
      workdir,
      timeout: 10000,
    });
    sourceBranch = branchResult.stdout.trim();
  } else if (options.repoPath) {
    workdir = options.repoPath;
    // Get current branch from repo
    const branchResult = await execGitWithTimeout("rev-parse", "rev-parse --abbrev-ref HEAD", {
      workdir,
      timeout: 10000,
    });
    sourceBranch = branchResult.stdout.trim();
  } else {
    // Try to infer from current directory
    workdir = (process as any).cwd();
    // Get current branch from cwd
    const branchResult = await execGitWithTimeout("rev-parse", "rev-parse --abbrev-ref HEAD", {
      workdir,
      timeout: 10000,
    });
    sourceBranch = branchResult.stdout.trim();
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
    await execGitWithTimeout("rev-parse --verify", `rev-parse --verify ${baseBranch}`, {
      workdir,
      timeout: 10000,
    });
  } catch (err) {
    throw new MinskyError(`Base branch '${baseBranch}' does not exist or is not accessible`);
  }

  // Make sure we have the latest from the base branch
  await gitFetchWithTimeout("origin", baseBranch, {
    workdir,
    timeout: 30000,
    context: [{ label: "Operation", value: "session PR preparation" }],
  });

  // Create PR branch FROM base branch (not feature branch) - per Task #025
  let existingPrMessage: string | undefined;

  try {
    // Enhanced PR branch cleanup with automatic recovery

    try {
      await execGitWithTimeout("rev-parse --verify", `rev-parse --verify ${prBranch}`, {
        workdir,
        timeout: 10000,
      });

      // Branch exists - use recovery function to handle any corrupted state
      log.debug(`PR branch ${prBranch} exists, attempting recovery cleanup`);

      const recovery = await attemptPrBranchRecovery(workdir, prBranch, {
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
    await execGitWithTimeout("branch", `branch ${prBranch} ${remoteBaseBranch}`, {
      workdir,
      timeout: 10000,
    });
    log.debug(`Created PR branch ${prBranch} from ${remoteBaseBranch} without checking it out`);
  } catch (err) {
    throw new MinskyError(`Failed to create PR branch: ${getErrorMessage(err as any)}`);
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

    // Merge feature branch INTO PR branch with --no-ff (prepared merge commit)
    // First checkout the PR branch temporarily to perform the merge
    await execGitWithTimeout("switch", `switch ${prBranch}`, { workdir, timeout: 30000 });

    // Check merge complexity and warn user if needed
    try {
      const diffStats = await execGitWithTimeout(
        "diff --name-only",
        `diff --name-only ${prBranch}..${sourceBranch}`,
        { workdir, timeout: 10000 }
      );
      const changedFiles = diffStats.stdout
        .trim()
        .split("\n")
        .filter((f) => f.trim());

      if (changedFiles.length > 5) {
        log.cli(
          `📊 Preparing PR with ${changedFiles.length} changed files - this may take a moment...`
        );
      }
    } catch (diffError) {
      // Ignore diff check errors - merge will proceed anyway
      log.debug("Could not check merge complexity", { error: getErrorMessage(diffError) });
    }

    // CRITICAL BUG FIX: Use explicit commit message format and verify the merge
    // Use -m instead of -F to avoid potential file reading issues
    const escapedCommitMessage = commitMessage.replace(
      /"/g,
      String.fromCharCode(92) + String.fromCharCode(34)
    );

    // 🔥 DEBUG: Log before merge attempt
    log.debug("🔥 DEBUG: About to attempt merge", {
      sourceBranch,
      prBranch,
      baseBranch,
      workdir,
      command: `merge --no-ff ${sourceBranch} -m "${escapedCommitMessage}"`,
    });

    await execGitWithTimeout(
      "merge",
      `merge --no-ff ${sourceBranch} -m "${escapedCommitMessage}"`,
      { workdir, timeout: 180000 } // Increased to 3 minutes for complex merges
    );

    // 🔥 DEBUG: Log after successful merge
    log.debug("🔥 DEBUG: Merge completed successfully", {
      sourceBranch,
      prBranch,
    });

    // VERIFICATION: Check that the merge commit has the correct message
    const logResult = await execGitWithTimeout("log", "log -1 --pretty=format:%B", {
      workdir,
      timeout: 10000,
    });
    const actualTitle = logResult.stdout.trim().split("\n")[0];
    const expectedTitle = commitMessage.split("\n")[0];

    if (actualTitle !== expectedTitle) {
      log.warn("Commit message mismatch detected", {
        expected: expectedTitle,
        actual: actualTitle,
        fullExpected: commitMessage,
        fullActual: logResult.stdout.trim(),
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
      await execGitWithTimeout("merge --abort", "merge --abort", { workdir, timeout: 30000 });
      await execGitWithTimeout("switch", `switch ${sourceBranch}`, { workdir, timeout: 30000 });
      log.debug("Cleaned up after non-conflict merge error");
    } catch (cleanupErr) {
      log.warn("Failed to clean up after non-conflict merge error", { cleanupErr });
    }

    throw new MinskyError(`Failed to create prepared merge commit: ${getErrorMessage(err as any)}`);
  }

  // Push changes to the PR branch with timeout handling
  try {
    await execGitWithTimeout("push", `push origin ${prBranch} --force`, {
      workdir,
      timeout: 30000,
      context: [
        { label: "Operation", value: "pushing PR branch" },
        { label: "Branch", value: prBranch },
      ],
    });
    log.debug(`Successfully pushed PR branch ${prBranch} to remote`);
  } catch (error) {
    throw new MinskyError(`Failed to push PR branch to remote: ${getErrorMessage(error)}`);
  }

  // CRITICAL: Always switch back to the original session branch after creating PR branch
  // This ensures session pr command never leaves user on the PR branch
  try {
    await execGitWithTimeout("switch", `switch ${sourceBranch}`, { workdir, timeout: 30000 });
    log.debug(`✅ Switched back to session branch ${sourceBranch} after creating PR branch`);
  } catch (err) {
    log.warn(
      `Failed to switch back to original branch ${sourceBranch}: ${getErrorMessage(err as any)}`
    );
  }

  return {
    prBranch,
    baseBranch,
    title: options.title,
    body: options.body,
  };
}
