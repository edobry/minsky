import { join } from "node:path";
import { log } from "../../utils/logger";
import { MinskyError } from "../../errors";
import { normalizeRepoName } from "../repo-utils";
import type { SessionRecord, SessionProviderInterface } from "../session/types";

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
  execInRepository: (workdir: string, command: string) => Promise<string>;
  getSessionWorkdir: (session: string) => string;
}

export async function preparePr(
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
      const currentDir = process.cwd();
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

Current directory: ${process.cwd()}
Session requested: "${options.session}"
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

Current directory: ${process.cwd()}
Session requested: "${options.session}"
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

Current directory: ${process.cwd()}
Session requested: "${options.session}"
`);
      }
    }
    const repoName = record.repoName || normalizeRepoName(record.repoUrl);
    workdir = deps.getSessionWorkdir(options.session);
    
    // Get current branch from repo instead of assuming session name is branch name
    try {
      sourceBranch = await deps.execInRepository(workdir, "git branch --show-current");
      sourceBranch = sourceBranch.trim();
    } catch (branchError) {
      log.debug("Failed to get current branch, falling back to session name", {
        session: options.session,
        error: branchError,
      });
      sourceBranch = options.session;
    }
  } else if (options.repoPath) {
    workdir = options.repoPath;
    try {
      sourceBranch = await deps.execInRepository(workdir, "git branch --show-current");
      sourceBranch = sourceBranch.trim();
    } catch (branchError) {
      throw new MinskyError(`Failed to determine current branch in ${workdir}: ${branchError}`);
    }
  } else {
    throw new MinskyError("Either session or repoPath must be provided");
  }

  // Validate that we have a valid working directory
  try {
    await deps.execInRepository(workdir, "git status");
  } catch (statusError) {
    throw new MinskyError(`Invalid git repository at ${workdir}: ${statusError}`);
  }

  // Create the PR branch name
  const prBranchName = options.branchName || `pr/${sourceBranch}`;

  // Create and checkout the PR branch
  try {
    // First, ensure we're on the source branch
    await deps.execInRepository(workdir, `git checkout ${sourceBranch}`);
    
    // Create and checkout the PR branch
    await deps.execInRepository(workdir, `git checkout -b ${prBranchName}`);
    
    log.debug("Created PR branch", {
      sourceBranch,
      prBranch: prBranchName,
      workdir,
    });
  } catch (branchError) {
    // If branch already exists, just switch to it
    try {
      await deps.execInRepository(workdir, `git checkout ${prBranchName}`);
      log.debug("Switched to existing PR branch", {
        prBranch: prBranchName,
        workdir,
      });
    } catch (checkoutError) {
      throw new MinskyError(`Failed to create or checkout PR branch ${prBranchName}: ${checkoutError}`);
    }
  }

  return {
    prBranch: prBranchName,
    baseBranch,
    title: options.title,
    body: options.body,
  };
} 
