import { Command } from "commander";
import { TaskService, TASK_STATUS } from "../../domain/tasks";
import { resolveRepoPath } from "../../domain/repo-utils";
import { resolveWorkspacePath } from "../../domain/workspace";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export function createListCommand(): Command {
  return new Command("list")
    .description("List tasks")
    .option("-s, --status <status>", "Filter tasks by status")
    .option("--session <session>", "Session name to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--workspace <workspacePath>", "Path to main workspace (overrides repo and session)")
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output tasks as JSON")
    .option("--all", "Include DONE tasks in the output (by default, DONE tasks are hidden)")
    .action(async (options: { 
      status?: string, 
      backend?: string, 
      session?: string, 
      repo?: string, 
      workspace?: string,
      json?: boolean,
      all?: boolean 
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
          workspacePath: workspacePath,
          backend: options.backend
        });
        
        let tasks;
        
        // If status filter is explicitly provided, use it
        if (options.status) {
          tasks = await taskService.listTasks({
            status: options.status
          });
        } else {
          // Otherwise get all tasks first
          tasks = await taskService.listTasks();
          
          // Unless --all is provided, filter out DONE tasks
          if (!options.all) {
            tasks = tasks.filter(task => task.status !== TASK_STATUS.DONE);
          }
        }
        
        if (tasks.length === 0) {
          if (options.json) {
            console.log(JSON.stringify([]));
          } else {
            console.log("No tasks found.");
          }
          return;
        }
        
        if (options.json) {
          console.log(JSON.stringify(tasks, null, 2));
        } else {
          console.log("Tasks:");
          tasks.forEach(task => {
            console.log(`- ${task.id}: ${task.title} [${task.status}]`);
          });
        }
      } catch (error) {
        console.error("Error listing tasks:", error);
        process.exit(1);
      }
    });
} 
