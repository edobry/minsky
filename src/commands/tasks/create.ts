import { Command } from 'commander';
import { TaskService } from '../../domain/tasks';
import { resolveRepoPath } from '../../domain/repo-utils';
import { SessionDB } from '../../domain/session';

export const createCommand = new Command('create')
  .description('Create a new task from a specification document')
  .argument('<spec-path>', 'Path to the task specification document')
  .option('--session <session>', 'Session name to use for repo resolution')
  .option('--repo <repoPath>', 'Path to a git repository (overrides session)')
  .option('--backend <backend>', 'Specify task backend (markdown, github)')
  .option('--json', 'Output task as JSON')
  .action(async (specPath: string, options: any) => {
    try {
      // Resolve repository path
      let workspacePath = options.repo;
      if (!workspacePath && options.session) {
        const sessionDB = new SessionDB();
        const session = await sessionDB.getSession(options.session);
        if (!session) {
          throw new Error(`Session "${options.session}" not found`);
        }
        workspacePath = await sessionDB.getRepoPath(session);
      }
      if (!workspacePath) {
        workspacePath = await resolveRepoPath({});
      }
      if (!workspacePath) {
        throw new Error('Could not determine repository path. Please provide --repo or --session option.');
      }

      // Create task service with resolved workspace path
      const taskService = new TaskService({
        workspacePath,
        backend: options.backend
      });

      // Create the task
      const task = await taskService.createTask(specPath);

      // Output the result
      if (options.json) {
        console.log(JSON.stringify(task, null, 2));
      } else {
        console.log(`Task ${task.id} created: ${task.title}`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }); 
