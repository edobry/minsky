import { Command } from 'commander';
import { GitService } from '../../domain/git';

export function createBranchCommand(): Command {
  const gitService = new GitService();

  return new Command('branch')
    .description('Create a new branch in the specified session repository')
    .argument('<branch>', 'Name of the branch to create')
    .requiredOption('-s, --session <session>', 'Session identifier for the repo')
    .action(async (branch: string, options: { session: string }) => {
      try {
        const result = await gitService.branch({
          session: options.session,
          branch
        });
        console.log(`Branch '${result.branch}' created in workdir: ${result.workdir}`);
      } catch (error) {
        console.error('Error creating branch:', error);
        process.exit(1);
      }
    });
} 
