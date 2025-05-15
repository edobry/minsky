import { Command } from "commander";
import { TaskService, TASK_STATUS } from "../../domain/tasks";
import type { TaskStatus } from "../../domain/tasks";
import { resolveRepoPath, resolveWorkspacePath } from "../../domain";
import { exec } from "child_process";
import { promisify } from "util";
import { normalizeTaskId } from "../../domain/tasks";
import * as p from "@clack/prompts";
import * as fs from "fs/promises";
import * as path from "path";
import { exit } from "../../utils/process";
import { log } from "../../utils/logger.js";

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
          log.cliError(
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
          log.cliError("No task ID provided. Please specify a task ID.");
          exit(1);
        }

        if (!taskId) {
          log.cliError("No task ID provided. Please specify a task ID.");
          exit(1);
        }

        // Get task details
        const task = await taskService.getTask(taskId);

        if (!task) {
          log.cliError(`Task ${taskId} not found.`);
          exit(1);
        }

        // If check option is used, verify status matches
        if (options.check) {
          if (task.status !== options.check) {
            if (options.json) {
              log.agent(
                JSON.stringify({
                  task: task.id,
                  status: task.status,
                  expected: options.check,
                  match: false,
                })
              );
            } else {
              log.cliError(`Task ${task.id} status is ${task.status}, expected ${options.check}`);
            }
            exit(1);
          } else {
            if (options.json) {
              log.agent(
                JSON.stringify({
                  task: task.id,
                  status: task.status,
                  expected: options.check,
                  match: true,
                })
              );
            } else {
              log.cli(`Task ${task.id} status is ${options.check} (expected)`);
            }
          }
          return;
        }

        // Output the result
        if (options.json) {
          log.agent(
            JSON.stringify({
              task: task.id,
              status: task.status,
            })
          );
        } else {
          log.cli(`Task ${task.id} status: ${task.status}`);
        }
      } catch (error) {
        log.cliError(`Error: ${error instanceof Error ? error.message : String(error)}`);
        exit(1);
      }
    });

  // Add the 'set' subcommand
  statusCommand
    .command("set")
    .description("Set status for a task")
    .argument("<task-id>", "Task ID to set status for")
    .argument("[status]", "New status (TODO, IN_PROGRESS, DONE, etc.)")
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
          log.cliError(
            "Could not determine repository path. Please provide --repo or --session option."
          );
          exit(1);
        }

        // Create task service with resolved workspace path
        const taskService = new TaskService({ workspacePath });

        // If status is not provided, prompt for it in interactive mode
        if (!status) {
          // Check if we're in a non-interactive environment
          if (!process.stdout.isTTY) {
            log.cliError(
              `\nStatus is required in non-interactive mode.\nValid options are: ${Object.values(
                TASK_STATUS
              ).join(", ")}\nExample: minsky tasks status set #071 DONE\n`
            );
            exit(1);
          }

          // Get current status for the task
          const task = await taskService.getTask(taskId);
          if (!task) {
            log.cliError(`Task ${taskId} not found.`);
            exit(1);
          }

          const currentStatus = task.status;

          // Prompt for status using @clack/prompts
          const statusOptions = Object.entries(TASK_STATUS).map(([key, value]) => ({
            value: value,
            label: value,
          }));

          const statusChoice = await p.select({
            message: `Select new status for task ${taskId}:`,
            options: statusOptions,
            initialValue: currentStatus || TASK_STATUS.TODO,
          });

          // Handle cancellation
          if (p.isCancel(statusChoice)) {
            p.cancel("Operation cancelled");
            exit(0);
          }

          // Set the chosen status
          status = statusChoice as string;
        }

        // Update the task status
        await taskService.setTaskStatus(taskId, status);

        // Get the updated task
        const task = await taskService.getTask(taskId);

        if (!task) {
          throw new Error(`Task ${taskId} not found after updating status.`);
        }

        // Output the result
        if (options.json) {
          log.agent(
            JSON.stringify({
              task: task.id,
              status: task.status,
              success: true,
            })
          );
        } else {
          log.cli(`Updated task ${task.id} status to ${task.status}`);
        }
      } catch (error) {
        if (options.json) {
          log.agent(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              success: false,
            })
          );
        } else {
          log.cliError(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        exit(1);
      }
    });

  return statusCommand;
}
