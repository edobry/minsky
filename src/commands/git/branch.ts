import { Command } from "commander";
import { GitService } from "../../domain/git.js";
import { log } from "../../utils/logger.js";

export function createBranchCommand(): Command {
  const gitService = new GitService();

  return new Command("branch")
    .description("Create a new branch in the specified session repository")
    .argument("<branch>", "Name of the branch to create")
    .requiredOption("-s, --session <session>", "Session identifier for the repo")
    .option("--json", "Output result as JSON")
    .action(async (branch: string, options: { session: string; json?: boolean }) => {
      try {
        const result = await gitService.branch({
          session: options.session,
          branch,
        });
        
        log.debug("Branch created successfully", {
          branch: result.branch,
          session: options.session,
          workdir: result.workdir
        });
        
        if (options.json) {
          log.agent(JSON.stringify({
            success: true,
            branch: result.branch,
            workdir: result.workdir
          }));
        } else {
          log.cli(`Branch '${result.branch}' created in workdir: ${result.workdir}`);
        }
      } catch (error) {
        log.error("Error creating branch", {
          branch,
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
          log.cliError(`Error creating branch: ${error instanceof Error ? error.message : String(error)}`);
        }
        
        process.exit(1);
      }
    });
}
