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
        
        // Get the repository path from SessionDB or use the legacy path as fallback
        // If repoPath is directly available from the session record, use it
        if (session.repoPath) {
          console.log(session.repoPath);
          return;
        }
        
        // Otherwise, use the SessionDB to get the repository path
        try {
          const workdir = await db.getSessionWorkdir(sessionName);
          console.log(workdir);
        } catch (error) {
          // Fallback to the legacy path structure if getSessionWorkdir fails
          const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
          const workdir = join(xdgStateHome, 'minsky', 'git', session.repoName, session.session);
          console.log(workdir);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error('Error getting session directory:', err.message);
        process.exit(1);
      }
    });
} 
