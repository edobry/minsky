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
  pushFromParams
} from "../../domain/index.js";
// Import GitService directly for push functionality
import { GitService } from "../../domain/git.js";
import { 
  handleCliError, 
  outputResult,
  addRepoOptions,
  addOutputOptions,
  normalizeRepoOptions,
  normalizeOutputOptions
} from "./utils/index.js";

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
  const command = new Command("summary")
    .description("Generate PR description summary")
    .option("--branch <branch>", "Branch to compare against (defaults to upstream branch)");
  
  // Add shared options
  addRepoOptions(command);
  addOutputOptions(command);
  
  command.action(
    async (options: {
      repo?: string;
      branch?: string;
      debug?: boolean;
      session?: string;
      "upstream-repo"?: string;
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

        // Convert CLI options to domain parameters using normalization helpers
        const repoOptions = normalizeRepoOptions(options);
        const outputOptions = normalizeOutputOptions(options);
        
        // Convert CLI options to domain parameters
        const params: GitPullRequestParams = {
          ...repoOptions,
          ...outputOptions,
          branch: options.branch,
        };

        log.debug("Creating PR summary with params", { params });

        const result = await createPullRequestFromParams(params);

        // Output result based on format
        outputResult(result, {
          json: options.json,
          formatter: (result) => {
            log.cli(result.markdown);
            // Display status update information if available
            if (result.statusUpdateResult) {
              const { taskId, previousStatus, newStatus } = result.statusUpdateResult;
              log.cli(`\nTask ${taskId} status updated: ${previousStatus || "none"} → ${newStatus}`);
            }
          },
        });
      } catch (error) {
        handleCliError(error);
      }
    }
  );
  
  return command;
}

/**
 * Creates the prepare-pr command
 */
export function createPreparePrCommand(): Command {
  const command = new Command("prepare-pr")
    .description("Prepare a PR branch with a merge commit")
    .option("--base <branch>", "Base branch for PR (defaults to upstream branch)")
    .option("--title <title>", "PR title (if not provided, will be generated)")
    .option("--body <body>", "PR body (if not provided, will be generated)");
  
  // Add shared options
  addRepoOptions(command);
  addOutputOptions(command);
  
  command.action(
    async (options: {
      repo?: string;
      session?: string;
      "upstream-repo"?: string;
      base?: string;
      title?: string;
      body?: string;
      debug?: boolean;
      json?: boolean;
    }) => {
      try {
        // Convert CLI options to domain parameters using normalization helpers
        const repoOptions = normalizeRepoOptions(options);
        const outputOptions = normalizeOutputOptions(options);
        
        const params = {
          ...repoOptions,
          baseBranch: options.base,
          title: options.title,
          body: options.body,
          debug: options.debug ?? false,
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
          },
        });
      } catch (error) {
        handleCliError(error);
      }
    }
  );
  
  return command;
}

/**
 * Creates the merge-pr command
 */
export function createMergePrCommand(): Command {
  const command = new Command("merge-pr")
    .description("Merge a PR branch into the base branch")
    .argument("<pr-branch>", "PR branch to merge")
    .option("--base <branch>", "Base branch to merge into (defaults to upstream branch)");
  
  // Add shared options
  addRepoOptions(command);
  addOutputOptions(command);
  
  command.action(
    async (
      prBranch: string,
      options: {
        repo?: string;
        session?: string;
        "upstream-repo"?: string;
        base?: string;
        json?: boolean;
      }
    ) => {
      try {
        // Convert CLI options to domain parameters using normalization helpers
        const repoOptions = normalizeRepoOptions(options);
        
        const params = {
          prBranch,
          ...repoOptions,
          baseBranch: options.base,
        };

        log.debug("Merging PR branch with params", { params });

        const result = await mergePrFromParams(params);

        // Output result based on format
        outputResult(result, {
          json: options.json,
          formatter: (result) => {
            log.cli(`Merged PR branch ${result.prBranch} into ${result.baseBranch}`);
            log.cli(`Merge commit: ${result.commitHash}`);
            log.cli(`Date: ${result.mergeDate}`);
            log.cli(`Merged by: ${result.mergedBy}`);
          },
        });
      } catch (error) {
        handleCliError(error);
      }
    }
  );
  
  return command;
}

/**
 * Creates the git command
 */
export function createGitCommand(): Command {
  const gitCommand = new Command("git").description("Git operations");

  // Add all git subcommands
  gitCommand.addCommand(createSummaryCommand());
  gitCommand.addCommand(createPreparePrCommand());
  gitCommand.addCommand(createMergePrCommand());

  return gitCommand;
}
