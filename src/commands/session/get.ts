import { Command } from 'commander';
import { SessionDB } from '../../domain/session';

export function createGetCommand(): Command {
  return new Command('get')
    .description('Get details for a specific session or by task ID')
    .argument('[session]', 'Session identifier')
    .option('--task <taskId>', 'Find session by associated task ID')
    .option('--json', 'Output session as JSON')
    .action(async (session: string | undefined, options: { json?: boolean; task?: string }) => {
      const db = new SessionDB();
      // Error if both session and --task are provided
      if (session && options.task) {
        const msg = 'Provide either a session name or --task, not both.';
        if (options.json) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }
      let record;
      if (options.task) {
        record = await db.getSessionByTaskId(options.task);
        if (!record) {
          const msg = `No session found for task ID '${options.task}'.`;
          if (options.json) {
            console.log(JSON.stringify(null));
          } else {
            console.error(msg);
          }
          process.exit(1);
        }
      } else if (session) {
        record = await db.getSession(session);
        if (!record) {
          if (options.json) {
            console.log(JSON.stringify(null));
          } else {
            console.error(`Session '${session}' not found.`);
          }
          process.exit(1);
        }
      } else {
        const msg = 'You must provide either a session name or --task.';
        if (options.json) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(msg);
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
        if (record.taskId) {
          console.log(`Task ID: ${record.taskId}`);
        }
      }
    });
} 
