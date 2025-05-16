/**
 * CLI adapter for git commands
 */
import { Command } from "commander";
import type { GitPullRequestParams, GitCommitParams, GitPushParams } from "../../schemas/git.js";
import { MinskyError } from "../../errors/index.js";
import { log } from "../../utils/logger";

// Import domain functions from domain index
import { 
  createPullRequestSummaryFromParams, 
  commitChangesFromParams,
  preparePrFromParams,
  mergePrFromParams
} from "../../domain/index.js";
// Import GitService directly for push functionality
import { GitService } from "../../domain/git.js";

/**
 * Creates the summary command (renamed from pr)
 */
export function createSummaryCommand(): Command {
  return new Command("summary")
    .description("Generate PR description summary")
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

          log.debug("Creating PR summary with params", { params });

          const result = await createPullRequestSummaryFromParams(params);

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
            // Exit with the specific error code if available
            if (typeof (error as any).code === 'number') {
              process.exit((error as any).code);
            }
            process.exit(1);
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
 * Creates the prepare-pr command
 */
export function createPreparePrCommand(): Command {
  return new Command("prepare-pr")
    .description("Prepare a PR branch with a merge commit")
    .option("--repo <path>", "Path to the git repository")
    .option("--base <branch>", "Base branch for PR (defaults to main)")
    .option("--title <title>", "PR title (if not provided, will be generated)")
    .option("--body <body>", "PR body (if not provided, will be generated)")
    .option("--debug", "Enable debug output")
    .option("--session <session>", "Session to create PR for")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        repo?: string;
        base?: string;
        title?: string;
        body?: string;
        debug?: boolean;
        session?: string;
        json?: boolean;
      }) => {
        try {
          const params = {
            repo: options.repo,
            baseBranch: options.base,
            title: options.title,
            body: options.body,
            debug: options.debug ?? false,
            session: options.session,
          };

          log.debug("Preparing PR branch with params", { params });

          const result = await preparePrFromParams(params);

          // Output result based on format
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            log.cli(`Created PR branch ${result.prBranch} from base ${result.baseBranch}`);
            log.cli(`PR branch pushed to origin/${result.prBranch}`);
            log.cli("PR is ready for review");
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
            // Exit with the specific error code if available
            if (typeof (error as any).code === 'number') {
              process.exit((error as any).code);
            }
            process.exit(1);
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
 * Creates the merge-pr command
 */
export function createMergePrCommand(): Command {
  return new Command("merge-pr")
    .description("Merge a PR branch into the base branch")
    .argument("<pr-branch>", "PR branch to merge")
    .option("--repo <path>", "Path to the git repository")
    .option("--base <branch>", "Base branch to merge into (defaults to main)")
    .option("--session <session>", "Session to merge PR for")
    .option("--json", "Output as JSON")
    .action(
      async (prBranch: string, options: {
        repo?: string;
        base?: string;
        session?: string;
        json?: boolean;
      }) => {
        try {
          const params = {
            prBranch,
            repo: options.repo,
            baseBranch: options.base,
            session: options.session,
          };

          log.debug("Merging PR branch with params", { params });

          const result = await mergePrFromParams(params);

          // Output result based on format
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            log.cli(`Merged PR branch ${result.prBranch} into ${result.baseBranch}`);
            log.cli(`Merge commit: ${result.commitHash}`);
            log.cli(`Merge date: ${result.mergeDate}`);
            log.cli(`Merged by: ${result.mergedBy}`);
            log.cli(`PR branch ${result.prBranch} deleted from remote`);
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
            // Exit with the specific error code if available
            if (typeof (error as any).code === 'number') {
              process.exit((error as any).code);
            }
            process.exit(1);
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

// Add the push command
/**
 * Creates the git push command
 */
export function createPushCommand(): Command {
  return new Command("push")
    .description("Push changes to remote")
    .option("--session <session>", "Session to push in")
    .option("--repo <path>", "Repository path")
    .option("--remote <remote>", "Remote to push to (defaults to origin)")
    .option("--force", "Force push (use with caution)")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        session?: string;
        repo?: string;
        remote?: string;
        force?: boolean;
        json?: boolean;
      }) => {
        try {
          // Use GitService directly for push
          const gitService = new GitService();
          const result = await gitService.push({
            session: options.session,
            repoPath: options.repo,
            remote: options.remote || "origin",
            force: options.force ?? false,
          });

          // Output result based on format
          if (options.json) {
            log.agent(JSON.stringify(result, null, 2));
          } else {
            log.cli("Successfully pushed changes to remote.");
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            log.cliError(`Error: ${error.message}`);
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
 * Creates the main git command with all subcommands
 */
export function createGitCommand(): Command {
  const gitCommand = new Command("git").description("Git operations");

  gitCommand.addCommand(createSummaryCommand());
  gitCommand.addCommand(createPreparePrCommand());
  gitCommand.addCommand(createMergePrCommand());
  gitCommand.addCommand(createCommitCommand());
  gitCommand.addCommand(createPushCommand());

  return gitCommand;
}
