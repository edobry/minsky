import { Command } from 'commander';
import { SessionDB } from '../../domain/session';

export function createListCommand(): Command {
  return new Command('list')
    .description('List all sessions')
    .action(async () => {
      const db = new SessionDB();
      const sessions = await db.listSessions();
      if (sessions.length === 0) {
        console.log('No sessions found.');
        return;
      }
      for (const s of sessions) {
        console.log(`Session: ${s.session}\n  Repo: ${s.repoUrl}\n  Branch: ${s.branch || '(none)'}\n  Created: ${s.createdAt}\n`);
      }
    });
} 
