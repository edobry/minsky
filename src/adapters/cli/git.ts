/**
 * CLI adapter for git commands
 */
import { Command } from "commander";
import type { GitPullRequestParams, GitCommitParams, GitPushParams } from "../../schemas/git.js";
import { MinskyError } from "../../errors/index.js";
import { log } from "../../utils/logger";

// Import domain functions from domain index
import {
  createPullRequestFromParams,
  commitChangesFromParams,
  preparePrFromParams,
} from "../../domain/index.js";
// Import GitService directly for push functionality
import { GitService } from "../../domain/git.js";
import { handleCliError, outputResult } from "./utils/index.js";

/**
 * Interface-agnostic function to merge a PR branch
 */
async function mergePrFromParams(params: {
  prBranch: string;
  repo?: string;
  baseBranch?: string;
  session?: string;
}): Promise<{
  prBranch: string;
  baseBranch: string;
  commitHash: string;
  mergeDate: string;
  mergedBy: string;
}> {
  try {
    const git = new GitService();
    const workdir = params.repo || process.cwd();
    
    // If baseBranch is not provided, use the fetchDefaultBranch method to determine it
    const baseBranch = params.baseBranch || await git.fetchDefaultBranch(workdir);

    // 1. Make sure we're on the base branch
    await git.execInRepository(workdir, `git checkout ${baseBranch}`);

    // 2. Make sure we have the latest changes
    await git.execInRepository(workdir, `git pull origin ${baseBranch}`);

    // 3. Merge the PR branch
    await git.execInRepository(workdir, `git merge --no-ff ${params.prBranch}`);

    // 4. Get the commit hash of the merge
    const commitHash = (await git.execInRepository(workdir, "git rev-parse HEAD")).trim();

    // 5. Get merge date and author
    const mergeDate = new Date().toISOString();
    const mergedBy = (await git.execInRepository(workdir, "git config user.name")).trim();

    // 6. Push the merge to the remote
    await git.execInRepository(workdir, `git push origin ${baseBranch}`);

    // 7. Delete the PR branch from the remote
    await git.execInRepository(workdir, `git push origin --delete ${params.prBranch}`);

    return {
      prBranch: params.prBranch,
      baseBranch,
      commitHash,
      mergeDate,
      mergedBy,
    };
  } catch (error) {
    log.error("Error merging PR branch", {
      prBranch: params.prBranch,
      baseBranch: params.baseBranch,
      session: params.session,
      repo: params.repo,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Creates the summary command (renamed from pr)
 */
export function createSummaryCommand(): Command {
  return new Command("summary")
    .description("Generate PR description summary")
    .option("--repo <repositoryUri>", "Repository URI")
    .option("--branch <branch>", "Branch to compare against (defaults to upstream branch)")
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
          // Auto-detect session if neither repo nor session is provided
          let autoDetectedSession = false;
          if (!options.repo && !options.session) {
            try {
              // Import getCurrentSessionContext to auto-detect session
              const { getCurrentSessionContext } = await import("../../domain/workspace.js");
              const sessionContext = await getCurrentSessionContext(process.cwd());

              if (sessionContext) {
                options.session = sessionContext.sessionId;
                autoDetectedSession = true;
                if (!options.json) {
                  log.cli(`Auto-detected session: ${options.session}`);
                }
              }
            } catch (error) {
              // Just log the error but continue - the domain function will handle missing session/repo
              log.debug("Error auto-detecting session", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          // Convert CLI options to domain parameters
          const params: GitPullRequestParams = {
            repo: options.repo,
            branch: options.branch,
            debug: options.debug ?? false,
            session: options.session,
            json: options.json,
          };

          log.debug("Creating PR summary with params", { params });

          const result = await createPullRequestFromParams(params);

          // Output result based on format
          outputResult(result, {
            json: options.json,
            formatter: (result) => {
              console.log(result.markdown);

              // Display status update information if available
              if (result.statusUpdateResult) {
                const { taskId, previousStatus, newStatus } = result.statusUpdateResult;
                console.log(
                  `\nTask ${taskId} status updated: ${previousStatus || "none"} → ${newStatus}`
                );
              }
            }
          });
        } catch (error) {
          handleCliError(error);
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
    .option("--repo <repositoryUri>", "Repository URI")
    .option("--base <branch>", "Base branch for PR (defaults to upstream branch)")
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
          outputResult(result, {
            json: options.json,
            formatter: (result) => {
              log.cli(`Created PR branch ${result.prBranch} from base ${result.baseBranch}`);
              log.cli(`PR branch pushed to origin/${result.prBranch}`);
              log.cli("PR is ready for review");
            }
          });
        } catch (error) {
          handleCliError(error);
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
    .option("--repo <repositoryUri>", "Repository URI")
    .option("--base <branch>", "Base branch to merge into (defaults to upstream branch)")
    .option("--session <session>", "Session to merge PR for")
    .option("--json", "Output as JSON")
    .action(
      async (
        prBranch: string,
        options: {
          repo?: string;
          base?: string;
          session?: string;
          json?: boolean;
        }
      ) => {
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
          outputResult(result, {
            json: options.json,
            formatter: (result) => {
              log.cli(`Merged PR branch ${result.prBranch} into ${result.baseBranch}`);
              log.cli(`Merge commit: ${result.commitHash}`);
              log.cli(`Merge date: ${result.mergeDate}`);
              log.cli(`Merged by: ${result.mergedBy}`);
              log.cli(`PR branch ${result.prBranch} deleted from remote`);
            }
          });
        } catch (error) {
          handleCliError(error);
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
    .option("--repo <repositoryUri>", "Repository URI")
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
          outputResult(result, {
            json: options.json,
            formatter: (result) => {
              log.cli(`Committed changes with message: ${result.message}`);
              log.cli(`Commit hash: ${result.commitHash}`);
            },
          });
        } catch (error) {
          handleCliError(error);
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
    .option("--repo <repositoryUri>", "Repository URI")
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
          outputResult(result, {
            json: options.json,
            formatter: () => {
              log.cli("Successfully pushed changes to remote.");
            },
          });
        } catch (error) {
          handleCliError(error);
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
