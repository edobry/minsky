#!/usr/bin/env bun

import { Command } from "commander";
import { GitService } from "../../domain/git.js";
import { resolveRepoPath } from "../../domain/repo-utils.js";
import { normalizeTaskId } from "../../domain/tasks.js";
import { SessionDB } from "../../domain/session.js";
import { log } from "../../utils/logger.js";

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
    .option("--json", "Output result as JSON")
    .action(
      async (options: {
        message: string;
        session?: string;
        repo?: string;
        all?: boolean;
        amend?: boolean;
        stage?: boolean;
        json?: boolean;
      }) => {
        try {
          // Resolve repository path
          const repoPath = await resolveRepoPath({
            session: options.session,
            repo: options.repo,
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

          log.debug("Resolved repository path for commit", {
            repoPath,
            session: options.session
          });

          // Stage changes if --no-stage was not used
          if (options.stage !== false) {
            log.debug("Staging changes", { all: options.all });
            if (options.all) {
              await gitService.stageAll(repoPath);
            } else {
              await gitService.stageModified(repoPath);
            }
          }

          // Add prefix to commit message and commit changes
          const fullMessage = prefix + options.message;
          const commitHash = await gitService.commit(fullMessage, repoPath, options.amend);

          log.debug("Commit completed", {
            hash: commitHash,
            message: fullMessage,
            repoPath,
            amend: options.amend
          });

          if (options.json) {
            log.agent(JSON.stringify({
              success: true,
              commit: commitHash,
              message: fullMessage
            }));
          } else {
            log.cli("Changes committed successfully.");
            log.cli(`Commit: ${commitHash}`);
            log.cli(`Message: ${fullMessage}`);
          }
        } catch (error) {
          log.error("Failed to commit changes", {
            message: options.message,
            session: options.session,
            repo: options.repo,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          });
          
          if (options.json) {
            log.agent(JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }));
          } else {
            log.cliError(
              `Failed to commit changes: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          
          process.exit(1);
        }
      }
    );
}
