#!/usr/bin/env bun

import { Command } from "commander";
import { GitService } from "../../domain/git";
import { resolveRepoPath } from "../../domain/repo-utils";
import { normalizeTaskId } from "../../utils/task-utils";
import { SessionDB } from "../../domain/session";

export function createGitCommitCommand(): Command {
  const gitService = new GitService();
  const sessionDb = new SessionDB();

  return new Command("commit")
    .description("Stage and commit changes in a single step")
    .requiredOption("-m, --message <message>", "Commit message (required)")
    .option("-s, --session <session>", "Session name")
    .option("-r, --repo <path>", "Repository path")
    .option("-a, --all", "Stage all changes including deletions (default: false)", false)
    .option("--amend", "Amend the previous commit (default: false)", false)
    .option("--no-stage", "Skip staging changes (for when files are already staged)")
    .action(async (options: { 
      message: string; 
      session?: string; 
      repo?: string; 
      all?: boolean; 
      amend?: boolean; 
      stage?: boolean;
    }) => {
      try {
        // Resolve repository path
        const repoPath = await resolveRepoPath({
          session: options.session,
          repo: options.repo
        });

        // If we have a session, get session record to check for task ID
        let prefix = "";
        if (options.session) {
          const sessionRecord = await sessionDb.getSession(options.session);
          if (sessionRecord?.taskId) {
            // Add task ID as prefix to commit message
            const taskId = normalizeTaskId(sessionRecord.taskId);
            prefix = `${taskId}: `;
          }
        }

        // Stage changes if --no-stage was not used
        if (options.stage !== false) {
          if (options.all) {
            await gitService.stageAll(repoPath);
          } else {
            await gitService.stageModified(repoPath);
          }
        }

        // Add prefix to commit message and commit changes
        const fullMessage = prefix + options.message;
        const commitHash = await gitService.commit(fullMessage, repoPath, options.amend);

        console.log("Changes committed successfully.");
        console.log(`Commit: ${commitHash}`);
        console.log(`Message: ${fullMessage}`);
      } catch (error) {
        console.error("Failed to commit changes:", error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
} 
