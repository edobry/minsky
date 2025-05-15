import { Command } from "commander";
import { GitService } from "../../domain/git.js";
import { log } from "../../utils/logger.js";

export function createCloneCommand(): Command {
  const gitService = new GitService();

  return new Command("clone")
    .description("Clone a git repository to a workdir")
    .argument("<repo-url>", "URL of the repository to clone")
    .option("-s, --session <session>", "Session identifier for this clone")
    .option("--json", "Output result as JSON")
    .action(async (repoUrl: string, options: { session?: string; json?: boolean }) => {
      try {
        const result = await gitService.clone({
          repoUrl,
          session: options.session,
        });

        log.debug("Repository cloned successfully", {
          repoUrl,
          session: result.session,
          workdir: result.workdir
        });

        if (options.json) {
          // Return structured JSON data
          log.agent(JSON.stringify({
            success: true,
            session: result.session,
            workdir: result.workdir
          }));
        } else {
          // Human-readable output
          log.cli("Repository cloned successfully!");
          log.cli(`Session: ${result.session}`);
          log.cli(`Workdir: ${result.workdir}`);
        }
      } catch (error) {
        log.error("Error cloning repository", {
          repoUrl,
          session: options.session,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });

        if (options.json) {
          log.agent(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }));
        } else {
          log.cliError(`Error cloning repository: ${error instanceof Error ? error.message : String(error)}`);
        }
        
        process.exit(1);
      }
    });
}
