import { promisify } from "node:util";
import { exec } from "node:child_process";
import { normalizeRepoName } from "../repo-utils";
import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import type { SessionRecord, SessionProviderInterface } from "../session";

const execAsync = promisify(exec);

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
  push: (options: { repoPath: string; remote: string; force: boolean }) => Promise<any>;
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

            // Extract task ID from session name if it follows the task#N pattern
            const taskIdMatch = options.session.match(/^task#(\d+)$/);
            const taskId = taskIdMatch ? `#${taskIdMatch[1]}` : undefined;

            // Create session record
            const newSessionRecord: SessionRecord = {
              session: options.session,
              repoUrl: repoUrl.trim(),
              repoName,
              createdAt: new Date().toISOString(),
              taskId,
              branch: options.session,
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
                `All sessions in database: count=${allSessions.length}, sessionNames=${allSessions.map((s) => s.session).slice(0, 10).join(", ")}, searchedFor=${options.session}`
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
              `All sessions in database: count=${allSessions.length}, sessionNames=${allSessions.map((s) => s.session).slice(0, 10).join(", ")}, searchedFor=${options.session}`
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
            `All sessions in database: count=${allSessions.length}, sessionNames=${allSessions.map((s) => s.session).slice(0, 10).join(", ")}, searchedFor=${options.session}`
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
    const { stdout: branchOut } = await execAsync(
      `git -C ${workdir} rev-parse --abbrev-ref HEAD`
    );
    sourceBranch = branchOut.trim();
  } else if (options.repoPath) {
    workdir = options.repoPath;
    // Get current branch from repo
    const { stdout: branchOut } = await execAsync(
      `git -C ${workdir} rev-parse --abbrev-ref HEAD`
    );
    sourceBranch = branchOut.trim();
  } else {
    // Try to infer from current directory
    workdir = (process as any).cwd();
    // Get current branch from cwd
    const { stdout: branchOut } = await execAsync(
      `git -C ${workdir} rev-parse --abbrev-ref HEAD`
    );
    sourceBranch = branchOut.trim();
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
    await execAsync(`git -C ${workdir} rev-parse --verify ${baseBranch}`);
  } catch (err) {
    throw new MinskyError(`Base branch '${baseBranch}' does not exist or is not accessible`);
  }

  // Make sure we have the latest from the base branch
  await execAsync(`git -C ${workdir} fetch origin ${baseBranch}`);

  // Create PR branch FROM base branch (not feature branch) - per Task #025
  try {
    // Check if PR branch already exists locally and delete it for clean slate
    try {
      await execAsync(`git -C ${workdir} rev-parse --verify ${prBranch}`);
      // Branch exists, delete it to recreate cleanly
      await execAsync(`git -C ${workdir} branch -D ${prBranch}`);
      log.debug(`Deleted existing PR branch ${prBranch} for clean recreation`);
    } catch {
      // Branch doesn't exist, which is fine
    }

    // Check if PR branch exists remotely and delete it for clean slate
    try {
      await execAsync(`git -C ${workdir} ls-remote --exit-code origin ${prBranch}`);
      // Remote branch exists, delete it to recreate cleanly
      await execAsync(`git -C ${workdir} push origin --delete ${prBranch}`);
      log.debug(`Deleted existing remote PR branch ${prBranch} for clean recreation`);
    } catch {
      // Remote branch doesn't exist, which is fine
    }

    // Fix for origin/origin/main bug: Don't prepend origin/ if baseBranch already has it
    const remoteBaseBranch = baseBranch.startsWith("origin/")
      ? baseBranch
      : `origin/${baseBranch}`;

    // Create PR branch FROM base branch WITHOUT checking it out (Task #025 specification)
    // Use git branch instead of git switch to avoid checking out the PR branch
    await execAsync(`git -C ${workdir} branch ${prBranch} ${remoteBaseBranch}`);
    log.debug(`Created PR branch ${prBranch} from ${remoteBaseBranch} without checking it out`);
  } catch (err) {
    throw new MinskyError(`Failed to create PR branch: ${getErrorMessage(err as any)}`);
  }

  // Create commit message file for merge commit (Task #025)
  const commitMsgFile = `${workdir}/.pr_title`;
  try {
    let commitMessage = options.title || `Merge ${sourceBranch} into ${prBranch}`;
    if (options.body) {
      commitMessage += `\n\n${options.body}`;
    }

    // CRITICAL BUG FIX: Improve commit message file handling
    // Write commit message to file for git merge -F
    // Use fs.writeFile instead of echo to avoid shell parsing issues
    const fs = await import("fs/promises");
    await fs.writeFile(commitMsgFile, commitMessage, "utf8");

    // VERIFICATION: Read back the commit message file to ensure it was written correctly
    const writtenMessage = await fs.readFile(commitMsgFile, "utf8");
    if (writtenMessage !== commitMessage) {
      throw new Error(
        `Commit message file verification failed. Expected: ${commitMessage}, Got: ${writtenMessage}`
      );
    }

    log.debug("Created and verified commit message file for prepared merge commit", {
      commitMessage,
      commitMsgFile,
      sourceBranch,
      prBranch,
    });

    // Merge feature branch INTO PR branch with --no-ff (prepared merge commit)
    // First checkout the PR branch temporarily to perform the merge
    await execAsync(`git -C ${workdir} switch ${prBranch}`);

    // CRITICAL BUG FIX: Use explicit commit message format and verify the merge
    // Use -m instead of -F to avoid potential file reading issues
    const escapedCommitMessage = commitMessage.replace(
      /"/g,
      String.fromCharCode(92) + String.fromCharCode(34)
    );
    await execAsync(
      `git -C ${workdir} merge --no-ff ${sourceBranch} -m "${escapedCommitMessage}"`
    );

    // VERIFICATION: Check that the merge commit has the correct message
    const actualCommitMessage = await execAsync(`git -C ${workdir} log -1 --pretty=format:%B`);
    const actualTitle = actualCommitMessage.stdout.trim().split("\n")[0];
    const expectedTitle = commitMessage.split("\n")[0];

    if (actualTitle !== expectedTitle) {
      log.warn("Commit message mismatch detected", {
        expected: expectedTitle,
        actual: actualTitle,
        fullExpected: commitMessage,
        fullActual: actualCommitMessage.stdout.trim(),
      });
      // Don't throw error but log the issue for debugging
    } else {
      log.debug("✅ Verified merge commit message is correct", {
        commitMessage: actualTitle,
      });
    }

    log.debug(`Created prepared merge commit by merging ${sourceBranch} into ${prBranch}`);

    // Clean up the commit message file
    await fs.unlink(commitMsgFile).catch(() => {
      // Ignore errors when cleaning up
    });
  } catch (err) {
    // Clean up on error
    try {
      await execAsync(`git -C ${workdir} merge --abort`);
      const fs = await import("fs/promises");
      await fs.unlink(commitMsgFile).catch(() => {
        // Ignore file cleanup errors
      });
      // CRITICAL: Switch back to session branch on error
      await execAsync(`git -C ${workdir} switch ${sourceBranch}`);
      log.debug("Aborted merge, cleaned up, and switched back to session branch after conflict");
    } catch (cleanupErr) {
      log.warn("Failed to clean up after merge error", { cleanupErr });
    }

    if (err instanceof Error && err.message.includes("CONFLICT")) {
      throw new MinskyError(
        "Merge conflicts occurred while creating prepared merge commit. Please resolve conflicts and retry.",
        { exitCode: 4 }
      );
    }
    throw new MinskyError(
      `Failed to create prepared merge commit: ${getErrorMessage(err as any)}`
    );
  }

  // Push changes to the PR branch
  await deps.push({
    repoPath: workdir,
    remote: "origin",
    force: true,
  });

  // CRITICAL: Always switch back to the original session branch after creating PR branch
  // This ensures session pr command never leaves user on the PR branch
  try {
    await execAsync(`git -C ${workdir} switch ${sourceBranch}`);
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
