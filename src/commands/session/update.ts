import { Command } from "commander";
import { GitService } from "../../domain/git";
import { SessionDB } from "../../domain/session";
import { getCurrentSession } from "../../domain/workspace";

export function createUpdateCommand(gitService: GitService, sessionDb: SessionDB) {
  const command = new Command("update")
    .description("Update a session with the latest changes from the main branch. If no session is provided, auto-detects the current session if run from a session workspace.")
    .argument("[session]", "Session name (defaults to current session)")
    .option("--no-stash", "Don't stash changes before updating")
    .option("--no-push", "Don't push changes after updating")
    .option("--branch <branch>", "Branch to merge from", "main")
    .option("--remote <remote>", "Remote to pull from", "origin")
    .option("--ignore-workspace", "Bypass workspace auto-detection")
    .action(async (session?: string, options?: any) => {
      try {
        // Get session info
        let workdir: string;
        if (session) {
          const record = await sessionDb.getSession(session);
          if (!record) {
            throw new Error(`Session '${session}' not found.`);
          }
          workdir = gitService.getSessionWorkdir(record.repoName, session);
        } else if (!options.ignoreWorkspace) {
          // Try to detect current session from working directory using the utility
          const currentSessionName = await getCurrentSession();
          if (!currentSessionName) {
            throw new Error("No session specified and not in a session workspace. Please provide a session name.");
          }
          const record = await sessionDb.getSession(currentSessionName);
          if (!record) {
            throw new Error(`Current session '${currentSessionName}' not found in session database.`);
          }
          workdir = gitService.getSessionWorkdir(record.repoName, record.session);
        } else {
          throw new Error("You must provide a session name when using --ignore-workspace.");
        }

        // Stash changes if needed
        if (options.stash) {
          await gitService.stashChanges(workdir);
        }

        try {
          // Pull latest changes
          await gitService.pullLatest(workdir, options.remote);

          // Merge specified branch
          const mergeResult = await gitService.mergeBranch(workdir, options.branch);
          if (mergeResult.conflicts) {
            throw new Error("Merge conflicts detected");
          }

          // Push changes if needed
          if (options.push) {
            await gitService.pushBranch(workdir, options.remote);
          }
        } finally {
          // Always try to restore stashed changes
          if (options.stash) {
            await gitService.popStash(workdir);
          }
        }
      } catch (error) {
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error("An unknown error occurred");
        }
        process.exit(1);
      }
    });

  return command;
}
