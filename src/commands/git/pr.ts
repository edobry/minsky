import { Command } from "commander";
import { GitService } from "../../domain/git";
import path from "path";
import fs from "fs";

export function createPrCommand(): Command {
  const gitService = new GitService();

  return new Command("pr")
    .description(
      "Output a markdown document containing the git history for the current or specified branch"
    )
    .option("-s, --session <session>", "Session identifier for the repo")
    .option("-p, --path <path>", "Path to a git repository (instead of using a session)")
    .option("-t, --task <taskId>", "Task ID to use (will look up the associated session)")
    .option("-b, --branch <branch>", "Branch to use (defaults to current branch)")
    .option("--debug", "Enable debug logging to stderr")
    .option("--no-status-update", "Skip automatic task status update to IN-REVIEW")
    .action(
      async (options: {
        session?: string;
        path?: string;
        task?: string;
        branch?: string;
        debug?: boolean;
        statusUpdate?: boolean;
      }) => {
        // We need either a session, path, or task
        if (!options.session && !options.path && !options.task) {
          console.error("Error: Either --session, --path, or --task must be provided");
          process.exit(1);
        }

        // Define precedence if multiple options are provided
        if (
          (options.session && options.path) ||
          (options.session && options.task) ||
          (options.path && options.task)
        ) {
          if (options.debug) {
            if (options.session && options.path) {
              console.error("Warning: Both session and path provided. Using session.");
            } else if (options.session && options.task) {
              console.error("Warning: Both session and task provided. Using session.");
            } else if (options.path && options.task) {
              console.error("Warning: Both path and task provided. Using path.");
            }
          }
        }

        try {
          // Validate and prepare path if provided
          let repoPath: string | undefined;
          if (options.path && !options.session && !options.task) {
            repoPath = path.resolve(options.path);
            // Check if it's a git repository
            if (!fs.existsSync(path.join(repoPath, ".git"))) {
              console.error(`Error: ${repoPath} is not a git repository`);
              process.exit(1);
            }
          }

          const result = await gitService.pr({
            session: options.session,
            repoPath,
            branch: options.branch,
            taskId: options.task,
            debug: options.debug,
            noStatusUpdate: options.statusUpdate === false,
          });

          // Output the PR markdown
          console.log(result.markdown);

          // Show status update information if applicable
          if (result.statusUpdateResult) {
            console.log("\n---");
            const { taskId, previousStatus, newStatus } = result.statusUpdateResult;
            console.log(
              `Task ${taskId} status updated: ${previousStatus || "none"} → ${newStatus}`
            );
          } else if (options.task && options.statusUpdate === false) {
            console.log("\n---");
            console.log(`Task ${options.task} status update skipped (--no-status-update)`);
          }
        } catch (error) {
          console.error("Error generating PR markdown:", error);
          process.exit(1);
        }
      }
    );
}
