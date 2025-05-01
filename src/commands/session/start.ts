import { Command } from 'commander';
import { GitService } from '../../domain/git';
import { SessionDB } from '../../domain/session';
import { TaskService } from '../../domain/tasks';
import fs from 'fs';
import path from 'path';
import { resolveRepoPath } from '../../domain/repo-utils';
import { startSession } from './startSession';
import { normalizeTaskId } from '../../utils/task-utils';

export function createStartCommand(): Command {
  const gitService = new GitService();
  const sessionDB = new SessionDB();

  return new Command('start')
    .description('Start a new session with a cloned repository')
    .argument('[session]', 'Session identifier (optional if --task is provided)')
    .option('-r, --repo <repo>', 'Repository URL or local path to clone (optional)')
    .option('-t, --task <taskId>', 'Task ID to associate with the session (uses task ID as session name if provided)')
    .option('-q, --quiet', 'Output only the session directory path (for programmatic use)')
    .option('-b, --backend <type>', 'Repository backend to use (local or github)', 'local')
    .option('--github-token <token>', 'GitHub access token for authentication')
    .option('--github-owner <owner>', 'GitHub repository owner')
    .option('--github-repo <repo>', 'GitHub repository name')
    .action(async (sessionArg: string | undefined, options: {
      repo?: string;
      task?: string;
      quiet?: boolean;
      backend?: 'local' | 'github';
      githubToken?: string;
      githubOwner?: string;
      githubRepo?: string;
    }) => {
      try {
        const repoPath = options.repo ? options.repo : await resolveRepoPath({}).catch(err => {
          throw new Error(`--repo is required (not in a git repo and no --repo provided): ${err.message}`);
        });

        // Handle the task ID if provided
        let session = sessionArg;
        let taskId: string | undefined = undefined;

        if (options.task) {
          // Normalize the task ID format
          taskId = normalizeTaskId(options.task);
          
          // Verify the task exists
          const taskService = new TaskService({
            workspacePath: repoPath,
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

        // Configure GitHub options
        const github = options.backend === 'github' ? {
          token: options.githubToken,
          owner: options.githubOwner,
          repo: options.githubRepo
        } : undefined;

        const result = await startSession({ 
          session, 
          repo: repoPath,
          taskId,
          backend: options.backend as 'local' | 'github',
          github
        });
        
        if (options.quiet) {
          // In quiet mode, output only the session directory path
          console.log(result.cloneResult.workdir);
        } else {
          // Standard verbose output for interactive use
          console.log(`Session '${result.sessionRecord.session}' started.`);
          console.log(`Repository cloned to: ${result.cloneResult.workdir}`);
          console.log(`Branch '${result.branchResult.branch}' created.`);
          console.log(`Backend: ${result.sessionRecord.backendType || 'local'}`);
          if (taskId) {
            console.log(`Associated with task: ${taskId}`);
          }
          console.log(`\nTo navigate to this session's directory, run:`);
          console.log(`cd $(minsky session dir ${result.sessionRecord.session})`);
          console.log('');
          console.log(result.cloneResult.workdir);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error('Error starting session:', err.message);
        process.exit(1);
      }
    });
} 
