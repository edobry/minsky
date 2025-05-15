import { Command } from "commander";
import { GitService } from "../../domain/git";
import * as path from "path";
import * as fs from "fs";
import { log } from "../../utils/logger";

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
    .option("--json", "Output result as JSON")
    .action(
      async (options: {
        session?: string;
        path?: string;
        task?: string;
        branch?: string;
        debug?: boolean;
        statusUpdate?: boolean;
        json?: boolean;
      }) => {
        // We need either a session, path, or task
        if (!options.session && !options.path && !options.task) {
          log.error("Missing required option", {
            message: "Either --session, --path, or --task must be provided",
            options
          });
          
          if (options.json) {
            log.agent(JSON.stringify({
              success: false,
              error: "Either --session, --path, or --task must be provided"
            }));
          } else {
            log.cliError("Error: Either --session, --path, or --task must be provided");
          }
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
              log.debug("Multiple options provided", {
                message: "Both session and path provided. Using session.",
                session: options.session,
                path: options.path
              });
            } else if (options.session && options.task) {
              log.debug("Multiple options provided", {
                message: "Both session and task provided. Using session.",
                session: options.session,
                task: options.task
              });
            } else if (options.path && options.task) {
              log.debug("Multiple options provided", {
                message: "Both path and task provided. Using path.",
                path: options.path,
                task: options.task
              });
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
              log.error("Invalid repository path", {
                repoPath,
                message: "Not a git repository"
              });
              
              if (options.json) {
                log.agent(JSON.stringify({
                  success: false,
                  error: `${repoPath} is not a git repository`
                }));
              } else {
                log.cliError(`Error: ${repoPath} is not a git repository`);
              }
              process.exit(1);
            }
          }

          log.debug("Generating PR markdown", {
            session: options.session,
            repoPath,
            branch: options.branch,
            taskId: options.task,
            debug: options.debug,
            noStatusUpdate: options.statusUpdate === false
          });

          const result = await gitService.pr({
            session: options.session,
            repoPath,
            branch: options.branch,
            taskId: options.task,
            debug: options.debug,
            noStatusUpdate: options.statusUpdate === false,
          });

          // Output the PR markdown
          if (options.json) {
            const jsonResponse = {
              success: true,
              markdown: result.markdown,
              statusUpdate: result.statusUpdateResult ? {
                taskId: result.statusUpdateResult.taskId,
                previousStatus: result.statusUpdateResult.previousStatus,
                newStatus: result.statusUpdateResult.newStatus
              } : null
            };
            log.agent(JSON.stringify(jsonResponse));
          } else {
            // Standard output to stdout using log.cli
            log.cli(result.markdown);

            // Show status update information if applicable
            if (result.statusUpdateResult) {
              const { taskId, previousStatus, newStatus } = result.statusUpdateResult;
              log.cli("\n---");
              log.cli(
                `Task ${taskId} status updated: ${previousStatus || "none"} → ${newStatus}`
              );
            } else if (options.task && options.statusUpdate === false) {
              log.cli("\n---");
              log.cli(`Task ${options.task} status update skipped (--no-status-update)`);
            }
          }
        } catch (error) {
          log.error("Error generating PR markdown", {
            session: options.session,
            path: options.path,
            task: options.task,
            branch: options.branch,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          });
          
          if (options.json) {
            log.agent(JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }));
          } else {
            log.cliError(`Error generating PR markdown: ${error instanceof Error ? error.message : String(error)}`);
          }
          process.exit(1);
        }
      }
    );
}
