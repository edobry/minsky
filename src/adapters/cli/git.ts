/**
 * CLI adapter for git commands
 */
import { Command } from "commander";
import type { GitPullRequestParams, GitCommitParams, GitPushParams } from "../../schemas/git.js";
import { MinskyError } from "../../errors/index.js";
import { log } from "../../utils/logger";

// Import domain functions from domain index
import { createPullRequestFromParams, commitChangesFromParams } from "../../domain/index.js";
// Import GitService directly for push functionality
import { GitService } from "../../domain/git.js";

/**
 * Creates the git pr command
 */
export function createPrCommand(): Command {
  return new Command("pr")
    .description("Create a pull request")
    .option("--repo <path>", "Path to the git repository")
    .option("--branch <branch>", "Branch to compare against (defaults to main/master)")
    .option("--debug", "Enable debug output")
    .option("--session <session>", "Session to create PR for")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        repo?: string;
        branch?: string;
        debug?: boolean;
        session?: string;
        json?: boolean;
      }) => {
        try {
          // Convert CLI options to domain parameters
          const params: GitPullRequestParams = {
            repo: options.repo,
            branch: options.branch,
            debug: options.debug ?? false,
            session: options.session,
            json: options.json,
          };

          log.debug("Creating PR with params", { params });

          const result = await createPullRequestFromParams(params);

          // Output result based on format
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(result.markdown);

            // Display status update information if available
            if (result.statusUpdateResult) {
              const { taskId, previousStatus, newStatus } = result.statusUpdateResult;
              console.log(
                `\nTask ${taskId} status updated: ${previousStatus || "none"} → ${newStatus}`
              );
            }
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else if (error instanceof Error) {
            log.cliError(`Unexpected error: ${error.message}`);
          } else {
            log.cliError(`Unexpected error: ${String(error)}`);
          }
          process.exit(1);
        }
      }
    );
}

/**
 * Creates the git commit command
 */
export function createCommitCommand(): Command {
  return new Command("commit")
    .description("Commit changes")
    .requiredOption("-m, --message <message>", "Commit message")
    .option("--session <session>", "Session to commit in")
    .option("--repo <path>", "Repository path")
    .option("--push", "Push changes after committing")
    .option("--all", "Stage all files")
    .option("--amend", "Amend the previous commit")
    .option("--no-stage", "Skip staging files (use already staged files)")
    .option("--no-verify", "Skip pre-commit hooks")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        message: string;
        session?: string;
        repo?: string;
        push?: boolean;
        all?: boolean;
        amend?: boolean;
        stage?: boolean;
        verify?: boolean;
        json?: boolean;
      }) => {
        try {
          // Convert CLI options to domain parameters
          const params: GitCommitParams = {
            message: options.message,
            session: options.session,
            repo: options.repo,
            all: options.all ?? false,
            amend: options.amend ?? false,
            noStage: options.stage === false,
            json: options.json,
          };

          log.debug("Committing changes with params", { params });

          const result = await commitChangesFromParams(params);

          // Output result based on format
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            log.cli(`Committed changes with message: ${result.message}`);
            log.cli(`Commit hash: ${result.commitHash}`);
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else if (error instanceof Error) {
            log.cliError(`Unexpected error: ${error.message}`);
          } else {
            log.cliError(`Unexpected error: ${String(error)}`);
          }
          process.exit(1);
        }
      }
    );
}
