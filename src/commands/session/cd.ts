import { Command } from 'commander';
import { join } from 'path';
import { SessionDB } from '../../domain/session';

/**
 * Gets the full path to a session's repository
 */
function getSessionRepoPath(session: { repoName: string, session: string }): string {
  const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
  return join(xdgStateHome, 'minsky', 'git', session.repoName, session.session);
}

export function createDirCommand(): Command {
  return new Command('dir')
    .description('Print the workdir path for a session (for use with cd $(minsky session dir <session>))')
    .argument('<session>', 'Session identifier')
    .action(async (sessionName: string) => {
      try {
        // Look up the session in the database to get the repoName
        const db = new SessionDB();
        const session = await db.getSession(sessionName);
        
        if (!session) {
          console.error(`Session '${sessionName}' not found.`);
          process.exit(1);
          return;
        }
        
        // Get the full path including the repoName
        const workdir = getSessionRepoPath(session);
        console.log(workdir);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error('Error getting session directory:', err.message);
        process.exit(1);
      }
    });
} 
