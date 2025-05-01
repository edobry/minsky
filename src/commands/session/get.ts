import { Command } from 'commander';
import { SessionDB } from '../../domain/session';
import { normalizeTaskId } from '../../utils/task-utils';
import { getCurrentSession } from '../../domain/workspace';

export function createGetCommand(): Command {
  return new Command('get')
    .description('Get details for a specific session or by task ID')
    .argument('[session]', 'Session identifier')
    .option('--task <taskId>', 'Find session by associated task ID')
    .option('--json', 'Output session as JSON')
    .option('--ignore-workspace', 'Ignore auto-detection from workspace')
    .action(async (session: string | undefined, options: { 
      json?: boolean; 
      task?: string;
      ignoreWorkspace?: boolean;
    }) => {
      try {
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
          // Normalize the task ID format
          const normalizedTaskId = normalizeTaskId(options.task);
          
          record = await db.getSessionByTaskId(normalizedTaskId);
          if (!record) {
            const msg = `No session found for task ID '${normalizedTaskId}'.`;
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
        } else if (!options.ignoreWorkspace) {
          // Auto-detect current session from workspace
          const currentSession = await getCurrentSession();
          if (currentSession) {
            record = await db.getSession(currentSession);
            if (!record) {
              const msg = `Current session '${currentSession}' not found in session database.`;
              if (options.json) {
                console.log(JSON.stringify({ error: msg }));
              } else {
                console.error(msg);
              }
              process.exit(1);
            }
          } else {
            const msg = 'Not in a session workspace. Please provide a session name or --task option.';
            if (options.json) {
              console.log(JSON.stringify({ error: msg }));
            } else {
              console.error(msg);
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
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const msg = `Error getting session: ${err.message}`;
        if (options.json) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }
    });
} 
