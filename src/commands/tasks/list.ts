import { Command } from 'commander';
import { TaskService } from '../../domain/tasks';
import { resolveRepoPath } from '../../domain/repo-utils';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function createListCommand(): Command {
  return new Command('list')
    .description('List tasks')
    .option('-s, --status <status>', 'Filter tasks by status')
    .option('--session <session>', 'Session name to use for repo resolution')
    .option('--repo <repoPath>', 'Path to a git repository (overrides session)')
    .option('-b, --backend <backend>', 'Specify task backend (markdown, github)')
    .action(async (options: { status?: string, backend?: string, session?: string, repo?: string }) => {
      try {
        const repoPath = await resolveRepoPath({ session: options.session, repo: options.repo });
        const taskService = new TaskService({
          repoPath,
          backend: options.backend
        });
        const tasks = await taskService.listTasks({
          status: options.status
        });
        if (tasks.length === 0) {
          console.log('No tasks found.');
          return;
        }
        console.log('Tasks:');
        tasks.forEach(task => {
          console.log(`- ${task.id}: ${task.title} [${task.status}]`);
        });
      } catch (error) {
        console.error('Error listing tasks:', error);
        process.exit(1);
      }
    });
} 
