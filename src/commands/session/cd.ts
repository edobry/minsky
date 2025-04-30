import { Command } from 'commander';
import { join } from 'path';
import { SessionDB } from '../../domain/session';

export function createDirCommand(): Command {
  return new Command('dir')
    .description('Print the workdir path for a session (for use with cd $(minsky session dir <session>))')
    .argument('<session>', 'Session identifier')
    .action(async (sessionName: string) => {
      try {
        // Look up the session in the database
        const db = new SessionDB();
        const session = await db.getSession(sessionName);
        
        if (!session) {
          console.error(`Session '${sessionName}' not found.`);
          process.exit(1);
          return;
        }
        
        // Get the repository path from SessionDB
        try {
          const workdir = await db.getRepoPath(session);
          console.log(workdir);
        } catch (error) {
          // Fallback to a constructed path in case of error
          const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
          const workdir = join(xdgStateHome, 'minsky', 'git', session.repoName, 'sessions', session.session);
          console.log(workdir);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error('Error getting session directory:', err.message);
        process.exit(1);
      }
    });
} 
