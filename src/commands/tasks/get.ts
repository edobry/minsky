import { Command } from 'commander';
import { TaskService } from '../../domain/tasks';
import { resolveRepoPath } from '../../domain/repo-utils';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function createGetCommand(): Command {
  return new Command('get')
    .description('Get task details by ID')
    .argument('<task-id>', 'ID of the task to get')
    .option('--session <session>', 'Session name to use for repo resolution')
    .option('--repo <repoPath>', 'Path to a git repository (overrides session)')
    .option('-b, --backend <backend>', 'Specify task backend (markdown, github)')
    .action(async (taskId: string, options: { backend?: string, session?: string, repo?: string }) => {
      try {
        const repoPath = await resolveRepoPath({ session: options.session, repo: options.repo });
        const taskService = new TaskService({
          repoPath,
          backend: options.backend
        });
        const task = await taskService.getTask(taskId);
        if (!task) {
          console.error(`Task with ID '${taskId}' not found.`);
          process.exit(1);
          return;
        }
        console.log(`Task ${task.id}: ${task.title}`);
        console.log(`Status: ${task.status}`);
        console.log(`Description: ${task.description}`);
      } catch (error) {
        console.error('Error getting task:', error);
        process.exit(1);
      }
    });
} 
