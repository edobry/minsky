#!/usr/bin/env bun

import { Command } from "commander";
import { GitService } from "../../domain/git";
import { SessionService } from "../../domain/session";
import { resolveRepoPath } from "../../utils/repo";

export function createGitCommitCommand() {
  const command = new Command("commit");

  command
    .description("Stage and commit changes in a single step")
    .option("-m, --message <message>", "Commit message (required)")
    .option("-s, --session <session>", "Session name")
    .option("-r, --repo <path>", "Repository path")
    .option("-a, --all", "Stage all changes including deletions", false)
    .option("--amend", "Amend the previous commit", false)
    .option("--no-stage", "Skip staging changes (for when files are already staged)")
    .action(async (options) => {
      try {
        const { message, session, repo, all, amend, stage } = options;

        if (!message && !amend) {
          throw new Error("Commit message is required unless using --amend");
        }

        // Resolve repository path
        let repoPath: string;
        if (session) {
          const sessionService = new SessionService();
          const sessionInfo = await sessionService.getSession(session);
          if (!sessionInfo) {
            throw new Error(`Session '${session}' not found`);
          }
          repoPath = sessionInfo.repoPath;
        } else if (repo) {
          repoPath = repo;
        } else {
          repoPath = await resolveRepoPath();
        }

        const gitService = new GitService(repoPath);

        // Check if there are changes to commit
        const status = await gitService.getStatus();
        if (!status.modified && !status.untracked && !status.deleted) {
          throw new Error("No changes to commit");
        }

        // Stage changes unless --no-stage is used
        if (stage) {
          if (all) {
            await gitService.stageAll();
          } else {
            await gitService.stageModified();
          }
        }

        // Get task ID from session if available
        let finalMessage = message;
        if (session) {
          const sessionInfo = await new SessionService().getSession(session);
          if (sessionInfo?.taskId) {
            finalMessage = `task#${sessionInfo.taskId}: ${message}`;
          }
        }

        // Commit changes
        const commitHash = await gitService.commit(finalMessage, amend);
                
        console.log("Changes committed successfully.");
        console.log(`Commit: ${commitHash}`);
        console.log(`Message: ${finalMessage}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  return command;
} 
