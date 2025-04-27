import { Command } from 'commander';
import { SessionDB } from '../../domain/session';

export function createGetCommand(): Command {
  return new Command('get')
    .description('Get details for a specific session')
    .argument('<session>', 'Session identifier')
    .option('--json', 'Output session as JSON')
    .action(async (session: string, options: { json?: boolean }) => {
      const db = new SessionDB();
      const record = await db.getSession(session);
      if (!record) {
        if (options.json) {
          console.log(JSON.stringify(null));
        } else {
          console.error(`Session '${session}' not found.`);
        }
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(record, null, 2));
      } else {
        // Print a human-readable summary (mimic list output)
        console.log(`Session: ${record.session}`);
        console.log(`Repo: ${record.repoUrl}`);
        console.log(`Branch: ${record.branch || '(none)'}`);
        console.log(`Created: ${record.createdAt}`);
      }
    });
} 
