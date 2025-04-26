import { Command } from 'commander';
import { GitService } from '../../domain/git';
import path from 'path';
import fs from 'fs';

export function createPrCommand(): Command {
  const gitService = new GitService();

  return new Command('pr')
    .description('Output a markdown document containing the git history for the current or specified branch')
    .option('-s, --session <session>', 'Session identifier for the repo')
    .option('-p, --path <path>', 'Path to a git repository (instead of using a session)')
    .option('-b, --branch <branch>', 'Branch to use (defaults to current branch)')
    .option('--debug', 'Enable debug logging to stderr')
    .action(async (options: { session?: string; path?: string; branch?: string; debug?: boolean }) => {
      // We need either a session or a path
      if (!options.session && !options.path) {
        console.error('Error: Either --session or --path must be provided');
        process.exit(1);
      }
      
      // If both are provided, prefer session
      if (options.session && options.path) {
        if (options.debug) console.error('Warning: Both session and path provided. Using session.');
      }
      
      try {
        // Validate and prepare path if provided
        let repoPath: string | undefined;
        if (options.path && !options.session) {
          repoPath = path.resolve(options.path);
          // Check if it's a git repository
          if (!fs.existsSync(path.join(repoPath, '.git'))) {
            console.error(`Error: ${repoPath} is not a git repository`);
            process.exit(1);
          }
        }
        
        const result = await gitService.pr({
          session: options.session,
          repoPath,
          branch: options.branch,
          debug: options.debug
        });
        console.log(result.markdown);
      } catch (error) {
        console.error('Error generating PR markdown:', error);
        process.exit(1);
      }
    });
} 
