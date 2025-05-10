/**
 * CLI adapter for git commands
 */
import { Command } from "commander";
import { execSync } from "child_process";
import type {
  GitPullRequestParams,
  GitCommitParams 
} from "../../schemas/git.js";
import { createPullRequestFromParams, commitChangesFromParams } from "../../domain/index.js";
import { MinskyError } from "../../errors/index.js";

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
    .action(async (options: {
      repo?: string,
      branch?: string,
      debug?: boolean,
      session?: string,
      json?: boolean
    }) => {
      try {
        // Convert CLI options to domain parameters
        const params: GitPullRequestParams = {
          repo: options.repo,
          branch: options.branch,
          debug: options.debug ?? false,
          session: options.session,
          json: options.json
        };

        // Call the domain function
        const result = await createPullRequestFromParams(params);
        
        // This will be replaced with direct domain function call once implemented
        // For now, we'll call the existing implementation
        let command = "bun src/cli.ts git pr";
        if (options.repo) command += ` --repo ${options.repo}`;
        if (options.branch) command += ` --branch ${options.branch}`;
        if (options.debug) command += " --debug";
        if (options.session) command += ` --session ${options.session}`;
        if (options.json) command += " --json";
        
        const output = execSync(command).toString();
        console.log(output);
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error}`);
        }
        
        if (typeof Bun !== "undefined") {
          Bun.exit(1);
        } else {
          process.exit(1);
        }
      }
    });
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
    .action(async (options: {
      message: string,
      session?: string,
      repo?: string,
      push?: boolean,
      all?: boolean,
      amend?: boolean,
      stage?: boolean,
      verify?: boolean,
      json?: boolean
    }) => {
      try {
        // Convert CLI options to domain parameters
        const params: GitCommitParams = {
          message: options.message,
          session: options.session,
          repo: options.repo,
          push: options.push ?? false,
          all: options.all ?? false,
          amend: options.amend ?? false,
          noStage: options.stage === false,
          noVerify: options.verify === false,
          json: options.json
        };

        // Call the domain function
        const result = await commitChangesFromParams(params);
        
        // This will be replaced with direct domain function call once implemented
        // For now, we'll call the existing implementation
        let command = `bun src/cli.ts git commit -m "${options.message}"`;
        if (options.session) command += ` --session ${options.session}`;
        if (options.repo) command += ` --repo ${options.repo}`;
        if (options.push) command += " --push";
        if (options.all) command += " --all";
        if (options.amend) command += " --amend";
        if (options.stage === false) command += " --no-stage";
        if (options.verify === false) command += " --no-verify";
        if (options.json) command += " --json";
        
        const output = execSync(command).toString();
        console.log(output);
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error}`);
        }
        
        if (typeof Bun !== "undefined") {
          Bun.exit(1);
        } else {
          process.exit(1);
        }
      }
    });
}

/**
 * Creates the main git command with all subcommands
 */
export function createGitCommand(): Command {
  const gitCommand = new Command("git")
    .description("Git operations");

  gitCommand.addCommand(createPrCommand());
  gitCommand.addCommand(createCommitCommand());

  return gitCommand;
} 
