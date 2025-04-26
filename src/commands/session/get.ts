import { Command } from 'commander';
import { SessionDB } from '../../domain/session';

export function createGetCommand(): Command {
  return new Command('get')
    .description('Get details for a specific session')
    .argument('<session>', 'Session identifier')
    .action(async (session: string) => {
      const db = new SessionDB();
      const record = await db.getSession(session);
      if (!record) {
        console.error(`Session '${session}' not found.`);
        process.exit(1);
      }
      console.log(JSON.stringify(record, null, 2));
    });
} 
