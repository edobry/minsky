import { Command } from "commander";
import { TaskService, TASK_STATUS } from "../../domain/tasks";
import type { TaskStatus } from "../../domain/tasks";
import { resolveRepoPath, resolveWorkspacePath } from "../../domain";
import { exec } from "child_process";
import { promisify } from "util";
import { normalizeTaskId } from "../../utils/task-utils";
import * as p from "@clack/prompts";
import * as fs from "fs/promises";
import * as path from "path";
import { exit } from "../../utils/process";

const execAsync = promisify(exec);

interface GetStatusOptions {
  session?: string;
  repo?: string;
  task?: string;
  json?: boolean;
  check?: string;
}

interface SetStatusOptions {
  session?: string;
  repo?: string;
  json?: boolean;
}

export function createStatusCommand(): Command {
  const statusCommand = new Command("status").description("Manage task status");

  // Add the 'get' subcommand
  statusCommand
    .command("get")
    .description("Get status for a task")
    .argument("[task-id]", "Task ID to get status for")
    .option("--session <session>", "Session to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--json", "Output as JSON")
    .option(
      "--check <status>",
      "Check if status matches expected value (returns non-zero exit code if not)"
    )
    .action(async (taskId, options: GetStatusOptions) => {
      try {
        // Resolve repository path
        const workspacePath = await resolveRepoPath({
          session: options.session,
          repo: options.repo,
        });

        if (!workspacePath) {
          console.error(
            "Could not determine repository path. Please provide --repo or --session option."
          );
          exit(1);
        }

        // Create task service with resolved workspace path
        const taskService = new TaskService({ workspacePath });

        // Special case: if no task ID provided, get current task from session if possible
        if (!taskId && options.session) {
          // Logic to get task ID from session would go here
          // For now, just error
          console.error("No task ID provided. Please specify a task ID.");
          exit(1);
        }

        if (!taskId) {
          console.error("No task ID provided. Please specify a task ID.");
          exit(1);
        }

        // Get task details
        const task = await taskService.getTask(taskId);

        if (!task) {
          console.error(`Task ${taskId} not found.`);
          exit(1);
        }

        // If check option is used, verify status matches
        if (options.check) {
          if (task.status !== options.check) {
            if (options.json) {
              console.log(
                JSON.stringify({
                  task: task.id,
                  status: task.status,
                  expected: options.check,
                  match: false,
                })
              );
            } else {
              console.error(`Task ${task.id} status is ${task.status}, expected ${options.check}`);
            }
            exit(1);
          } else {
            if (options.json) {
              console.log(
                JSON.stringify({
                  task: task.id,
                  status: task.status,
                  expected: options.check,
                  match: true,
                })
              );
            } else {
              console.log(`Task ${task.id} status is ${options.check} (expected)`);
            }
          }
          return;
        }

        // Output the result
        if (options.json) {
          console.log(
            JSON.stringify({
              task: task.id,
              status: task.status,
            })
          );
        } else {
          console.log(`Task ${task.id} status: ${task.status}`);
        }
      } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : String(error));
        exit(1);
      }
    });

  // Add the 'set' subcommand
  statusCommand
    .command("set")
    .description("Set status for a task")
    .argument("<task-id>", "Task ID to set status for")
    .argument("<status>", "New status value (TODO, IN_PROGRESS, DONE, etc.)")
    .option("--session <session>", "Session to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--json", "Output as JSON")
    .action(async (taskId, status, options: SetStatusOptions) => {
      try {
        // Resolve repository path
        let workspacePath = options.repo;
        if (!workspacePath) {
          workspacePath = await resolveRepoPath({ session: options.session });
        }

        if (!workspacePath) {
          console.error(
            "Could not determine repository path. Please provide --repo or --session option."
          );
          exit(1);
        }

        // Create task service with resolved workspace path
        const taskService = new TaskService({ workspacePath });

        // Update the task status
        await taskService.setTaskStatus(taskId, status);

        // Get the updated task
        const task = await taskService.getTask(taskId);

        if (!task) {
          throw new Error(`Task ${taskId} not found after updating status.`);
        }

        // Output the result
        if (options.json) {
          console.log(
            JSON.stringify({
              task: task.id,
              status: task.status,
              success: true,
            })
          );
        } else {
          console.log(`Updated task ${task.id} status to ${task.status}`);
        }
      } catch (error) {
        if (options.json) {
          console.log(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              success: false,
            })
          );
        } else {
          console.error("Error:", error instanceof Error ? error.message : String(error));
        }
        exit(1);
      }
    });

  return statusCommand;
}
