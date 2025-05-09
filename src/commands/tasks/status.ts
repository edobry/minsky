import { Command } from "commander";
import { TaskService, TASK_STATUS } from "../../domain/tasks";
import type { TaskStatus } from "../../domain/tasks";
import { resolveRepoPath } from "../../domain/repo-utils";
import { resolveWorkspacePath } from "../../domain/workspace";
import { exec } from "child_process";
import { promisify } from "util";
import { normalizeTaskId } from "../../utils/task-utils";
import * as p from "@clack/prompts";

const execAsync = promisify(exec);

function createStatusGetCommand(): Command {
  return new Command("get")
    .description("Get the status of a task")
    .argument("<task-id>", "ID of the task")
    .option("--session <session>", "Session name to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--workspace <workspacePath>", "Path to main workspace (overrides repo and session)")
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .action(async (taskId: string, options: { 
      backend?: string, 
      session?: string, 
      repo?: string, 
      workspace?: string 
    }) => {
      try {
        // Normalize the task ID format
        const normalizedTaskId = normalizeTaskId(taskId);
        
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
        
        const status = await taskService.getTaskStatus(normalizedTaskId);
        if (status === null) {
          console.error(`Task with ID '${normalizedTaskId}' not found.`);
          process.exit(1);
          return;
        }
        console.log(`Status for task ${normalizedTaskId}: ${status}`);
      } catch (error) {
        console.error("Error getting task status:", error);
        process.exit(1);
      }
    });
}

function createStatusSetCommand(): Command {
  return new Command("set")
    .description("Set the status of a task")
    .argument("<task-id>", "ID of the task")
    .argument("[status]", `New status (${Object.values(TASK_STATUS).join(", ")})`)
    .option("--session <session>", "Session name to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--workspace <workspacePath>", "Path to main workspace (overrides repo and session)")
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .action(async (taskId: string, status: string | undefined, options: { 
      backend?: string, 
      session?: string, 
      repo?: string, 
      workspace?: string 
    }) => {
      try {
        // Normalize the task ID format
        const normalizedTaskId = normalizeTaskId(taskId);
        
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
        
        // First verify task exists
        const task = await taskService.getTask(normalizedTaskId);
        if (!task) {
          console.error(`Task with ID '${normalizedTaskId}' not found.`);
          process.exit(1);
          return;
        }
        
        // If status is not provided, prompt for it in interactive mode
        if (!status) {
          // Check if we're in a non-interactive environment
          if (!process.stdout.isTTY) {
            console.error(`\nStatus is required in non-interactive mode.\nValid options are: ${Object.values(TASK_STATUS).join(", ")}\nExample: minsky tasks status set #001 DONE\n`);
            process.exit(1);
            return;
          }
          
          // Prompt for status using @clack/prompts
          const statusOptions = Object.entries(TASK_STATUS).map(([key, value]) => ({
            value: value,
            label: value
          }));
          
          const currentStatus = await taskService.getTaskStatus(normalizedTaskId);
          
          const statusChoice = await p.select({
            message: `Select new status for task ${normalizedTaskId}:`,
            options: statusOptions,
            initialValue: currentStatus as string || TASK_STATUS.TODO
          });
          
          // Handle cancellation
          if (p.isCancel(statusChoice)) {
            p.cancel("Operation cancelled");
            process.exit(0);
            return;
          }
          
          status = String(statusChoice);
        }
        
        // Validate the status value
        if (!Object.values(TASK_STATUS).includes(status as TaskStatus)) {
          console.error(`\nInvalid status: '${status}'.\nValid options are: ${Object.values(TASK_STATUS).join(", ")}\nExample: minsky tasks status set #001 DONE\n`);
          process.exit(1);
        }
        
        // Display the selected status before applying the change
        console.log(`Setting status for task ${normalizedTaskId} to: ${status}`);
        
        await taskService.setTaskStatus(normalizedTaskId, status as TaskStatus);
        console.log(`Status for task ${normalizedTaskId} updated to: ${status}`);
      } catch (error) {
        console.error("Error setting task status:", error);
        process.exit(1);
      }
    });
}

export function createStatusCommand(): Command {
  const status = new Command("status")
    .description("Task status operations");

  status.addCommand(createStatusGetCommand());
  status.addCommand(createStatusSetCommand());

  return status;
} 
