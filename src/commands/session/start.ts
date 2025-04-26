import { Command } from 'commander';
import { GitService } from '../../domain/git';
import { SessionDB } from '../../domain/session';
import fs from 'fs';
import path from 'path';

export function createStartCommand(): Command {
  const gitService = new GitService();
  const sessionDB = new SessionDB();

  return new Command('start')
    .description('Start a new session with a cloned repository')
    .argument('<session>', 'Session identifier')
    .option('-r, --repo <repo>', 'Repository URL or local path to clone (required)')
    .action(async (session: string, options: { repo?: string }) => {
      try {
        // Validate inputs
        if (!options.repo) {
          console.error('Error: --repo is required');
          process.exit(1);
        }

        // Check if session already exists
        const existingSession = await sessionDB.getSession(session);
        if (existingSession) {
          console.error(`Error: Session '${session}' already exists`);
          process.exit(1);
        }

        // Process repo URL or local path
        let repoUrl = options.repo;
        const isLocalPath = fs.existsSync(options.repo) && fs.statSync(options.repo).isDirectory();
        
        if (isLocalPath) {
          // Get the absolute path and add file:// protocol if needed
          const absolutePath = path.resolve(options.repo);
          repoUrl = `file://${absolutePath}`;
        }

        // Clone the repo
        const cloneResult = await gitService.clone({
          repoUrl,
          session
        });

        // Create a branch named after the session
        const branchResult = await gitService.branch({
          session,
          branch: session
        });

        // Record the session
        await sessionDB.addSession({
          session,
          repoUrl,
          branch: session,
          createdAt: new Date().toISOString()
        });

        console.log(`Session '${session}' started.`);
        console.log(`Repository cloned to: ${cloneResult.workdir}`);
        console.log(`Branch '${branchResult.branch}' created.`);
        console.log(`\nTo navigate to this session's directory, run:`);
        console.log(`cd $(minsky session cd ${session})`);
        
        // Return just the path so it can be used in scripts
        console.log(`\n${cloneResult.workdir}`);
      } catch (error) {
        console.error('Error starting session:', error);
        process.exit(1);
      }
    });
} 
