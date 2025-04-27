import { Command } from 'commander';
import { TaskService, TASK_STATUS } from '../../domain/tasks';
import type { TaskStatus } from '../../domain/tasks';
import { resolveRepoPath } from '../../domain/repo-utils';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

function createStatusGetCommand(): Command {
  return new Command('get')
    .description('Get the status of a task')
    .argument('<task-id>', 'ID of the task')
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
        const status = await taskService.getTaskStatus(taskId);
        if (status === null) {
          console.error(`Task with ID '${taskId}' not found.`);
          process.exit(1);
          return;
        }
        console.log(`Status for task ${taskId}: ${status}`);
      } catch (error) {
        console.error('Error getting task status:', error);
        process.exit(1);
      }
    });
}

function createStatusSetCommand(): Command {
  return new Command('set')
    .description('Set the status of a task')
    .argument('<task-id>', 'ID of the task')
    .argument('<status>', `New status (${Object.values(TASK_STATUS).join(', ')})`)
    .option('--session <session>', 'Session name to use for repo resolution')
    .option('--repo <repoPath>', 'Path to a git repository (overrides session)')
    .option('-b, --backend <backend>', 'Specify task backend (markdown, github)')
    .action(async (taskId: string, status: string, options: { backend?: string, session?: string, repo?: string }) => {
      try {
        if (!Object.values(TASK_STATUS).includes(status)) {
          console.error(`\nInvalid status: '${status}'.\nValid options are: ${Object.values(TASK_STATUS).join(', ')}\nExample: minsky tasks status set #001 DONE\n`);
          process.exit(1);
        }
        const repoPath = await resolveRepoPath({ session: options.session, repo: options.repo });
        const taskService = new TaskService({
          repoPath,
          backend: options.backend
        });
        // First verify task exists
        const task = await taskService.getTask(taskId);
        if (!task) {
          console.error(`Task with ID '${taskId}' not found.`);
          process.exit(1);
          return;
        }
        await taskService.setTaskStatus(taskId, status as TaskStatus);
        console.log(`Status for task ${taskId} updated to: ${status}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('Error setting task status:', msg);
        process.exit(1);
      }
    });
}

export function createStatusCommand(): Command {
  const statusCommand = new Command('status')
    .description('Manage task status');
    
  statusCommand.addCommand(createStatusGetCommand());
  statusCommand.addCommand(createStatusSetCommand());
  
  return statusCommand;
} 
