import { Command } from "commander";
import { GitService } from "../../domain/git";

export function createCloneCommand(): Command {
  const gitService = new GitService();

  return new Command("clone")
    .description("Clone a git repository to a workdir")
    .argument("<repo-url>", "URL of the repository to clone")
    .option("-s, --session <session>", "Session identifier for this clone")
    .action(async (repoUrl: string, options: { session?: string }) => {
      try {
        const result = await gitService.clone({
          repoUrl,
          session: options.session
        });
        
        console.log("Repository cloned successfully!");
        console.log(`Session: ${result.session}`);
        console.log(`Workdir: ${result.workdir}`);
      } catch (error) {
        console.error("Error cloning repository:", error);
        process.exit(1);
      }
    });
} 
