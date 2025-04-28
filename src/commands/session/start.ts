import { Command } from 'commander';
import { GitService } from '../../domain/git';
import { SessionDB } from '../../domain/session';
import { TaskService } from '../../domain/tasks';
import fs from 'fs';
import path from 'path';
import { resolveRepoPath } from '../../domain/repo-utils';
import { startSession } from './startSession';

export function createStartCommand(): Command {
  const gitService = new GitService();
  const sessionDB = new SessionDB();

  return new Command('start')
    .description('Start a new session with a cloned repository')
    .argument('<session>', 'Session identifier')
    .option('-r, --repo <repo>', 'Repository URL or local path to clone (optional)')
    .option('-t, --task <taskId>', 'Task ID to associate with the session (uses task ID as session name if provided)')
    .action(async (sessionArg: string, options: { repo?: string, task?: string }) => {
      try {
        const repoPath = options.repo ? options.repo : await resolveRepoPath({}).catch(err => {
          throw new Error(`--repo is required (not in a git repo and no --repo provided): ${err.message}`);
        });

        // Handle the task ID if provided
        let session = sessionArg;
        let taskId: string | undefined = undefined;

        if (options.task) {
          taskId = options.task;
          
          // Normalize the task ID format
          if (!taskId.startsWith('#')) {
            taskId = `#${taskId}`;
          }
          
          // Verify the task exists
          const taskService = new TaskService({
            repoPath,
            backend: 'markdown' // Default to markdown backend
          });
          
          const task = await taskService.getTask(taskId);
          if (!task) {
            throw new Error(`Task ${taskId} not found`);
          }
          
          // Use the task ID as the session name
          session = `task${taskId}`;
          
          // Check if a session already exists for this task
          const existingSessions = await sessionDB.listSessions();
          const taskSession = existingSessions.find(s => s.taskId === taskId);
          
          if (taskSession) {
            throw new Error(`A session for task ${taskId} already exists: '${taskSession.session}'`);
          }
        }

        const result = await startSession({ 
          session, 
          repo: options.repo,
          taskId
        });
        
        console.log(`Session '${session}' started.`);
        console.log(`Repository cloned to: ${result.cloneResult.workdir}`);
        console.log(`Branch '${result.branchResult.branch}' created.`);
        if (taskId) {
          console.log(`Associated with task: ${taskId}`);
        }
        console.log(`\nTo navigate to this session's directory, run:`);
        console.log(`cd $(minsky session dir ${session})`);
        // Return just the path so it can be used in scripts
        console.log(`\n${result.cloneResult.workdir}`);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error('Error starting session:', err.message);
        process.exit(1);
      }
    });
} 
