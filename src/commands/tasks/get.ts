import { Command } from 'commander';
import { TaskService } from '../../domain/tasks';
import { resolveRepoPath } from '../../domain/repo-utils';
import { resolveWorkspacePath } from '../../domain/workspace';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function createGetCommand(): Command {
  return new Command('get')
    .description('Get task details')
    .argument('<task-id>', 'ID of the task')
    .option('--session <session>', 'Session name to use for repo resolution')
    .option('--repo <repoPath>', 'Path to a git repository (overrides session)')
    .option('--workspace <workspacePath>', 'Path to main workspace (overrides repo and session)')
    .option('-b, --backend <backend>', 'Specify task backend (markdown, github)')
    .option('--json', 'Output task as JSON')
    .action(async (taskId: string, options: { 
      backend?: string, 
      session?: string, 
      repo?: string, 
      workspace?: string,
      json?: boolean 
    }) => {
      try {
        // First get the repo path (needed for workspace resolution)
        const repoPath = await resolveRepoPath({ session: options.session, repo: options.repo });
        
        // Then get the workspace path (main repo or session's main workspace)
        const workspacePath = await resolveWorkspacePath({ 
          workspace: options.workspace,
          sessionRepo: repoPath
        });
        
        const taskService = new TaskService({
          workspacePath,
          backend: options.backend
        });
        
        const task = await taskService.getTask(taskId);
        
        if (!task) {
          console.error(`Task with ID '${taskId}' not found.`);
          process.exit(1);
          return;
        }
        
        if (options.json) {
          console.log(JSON.stringify(task, null, 2));
        } else {
          console.log(`Task ID: ${task.id}`);
          console.log(`Title: ${task.title}`);
          console.log(`Status: ${task.status}`);
          if (task.description) {
            console.log('\nDescription:');
            console.log(task.description);
          }
        }
      } catch (error) {
        console.error('Error getting task:', error);
        process.exit(1);
      }
    });
} 
