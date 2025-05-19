/**
 * CLI adapter for task commands
 */
import { Command } from "commander";
import { generateFilterMessages } from "../../utils/filter-messages.js";
import { execSync } from "child_process";
import type {
  TaskListParams,
  TaskGetParams,
  TaskStatusGetParams,
  TaskStatusSetParams,
  TaskCreateParams,
} from "../../schemas/tasks.js";
import { taskStatusSchema } from "../../schemas/tasks.js"; // Import taskStatusSchema for type inference
import {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  createTaskFromParams,
  normalizeTaskId,
  TASK_STATUS,
} from "../../domain/tasks.js";
import { MinskyError } from "../../errors/index.js";
import * as p from "@clack/prompts";
import { log } from "../../utils/logger";
import { z } from "zod"; // Add import for z namespace

// Helper for exiting process consistently
function exit(code: number): never {
  process.exit(code);
}

/**
 * Creates the task list command
 */
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
    .action(
      async (options: {
        status?: string;
        backend?: string;
        session?: string;
        repo?: string;
        workspace?: string;
        json?: boolean;
        all?: boolean;
      }) => {
        try {
          // Convert CLI options to domain parameters
          const params: TaskListParams = {
            filter: options.status,
            backend: options.backend,
            session: options.session,
            repo: options.repo,
            workspace: options.workspace,
            all: options.all ?? false,
            json: options.json,
          };

          // Call the domain function
          const tasks = await listTasksFromParams(params);

          // Format and display the results
          if (tasks.length === 0) {
            if (options.json) {
              // For JSON output, write directly to stdout
              process.stdout.write(`${JSON.stringify([])}\n`);
            } else {
              // Generate and display filter messages in non-JSON mode
              const filterMessages = generateFilterMessages({
                status: options.status,
                all: options.all,
              });

              // Display filter messages if any exist
              if (filterMessages.length > 0) {
                filterMessages.forEach((message) => log.cli(message));
                log.cli("");
              }

              log.cli("No tasks found.");
            }
            return;
          }

          if (options.json) {
            // For JSON output, write directly to stdout
            process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
          } else {
            // Generate and display filter messages in non-JSON mode
            const filterMessages = generateFilterMessages({
              status: options.status,
              all: options.all,
            });

            // Display filter messages if any exist
            if (filterMessages.length > 0) {
              filterMessages.forEach((message) => log.cli(message));
              log.cli("");
            }

            log.cli("Tasks:");
            tasks.forEach((task) => {
              log.cli(`- ${task.id}: ${task.title} [${task.status}]`);
            });
          }
        } catch (error) {
          log.cliError("Error listing tasks:");
          log.error("Error details for listing tasks", error as Error);
          exit(1);
        }
      }
    );
}

/**
 * Creates the task get command
 */
export function createGetCommand(): Command {
  return new Command("get")
    .description("Get task details")
    .argument("<task-id>", "ID of the task to retrieve")
    .option("--session <session>", "Session name to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--workspace <workspacePath>", "Path to main workspace (overrides repo and session)")
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output task as JSON")
    .action(
      async (
        taskId: string,
        options: {
          session?: string;
          repo?: string;
          workspace?: string;
          backend?: string;
          json?: boolean;
        }
      ) => {
        try {
          // Normalize the task ID before passing to domain
          const normalizedTaskId = normalizeTaskId(taskId);
          if (!normalizedTaskId) {
            log.cliError(
              `Invalid task ID: '${taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
            );
            exit(1);
          }

          // Convert CLI options to domain parameters
          const params: TaskGetParams = {
            taskId: normalizedTaskId,
            session: options.session,
            repo: options.repo,
            workspace: options.workspace,
            backend: options.backend,
            json: options.json,
          };

          // Call the domain function
          const task = await getTaskFromParams(params);

          // Format and display the result
          if (options.json) {
            // For JSON output, write directly to stdout
            process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
          } else {
            log.cli(`Task ${task.id}:`);
            log.cli(`Title: ${task.title}`);
            log.cli(`Status: ${task.status}`);
            if (task.specPath) {
              log.cli(`Spec: ${task.specPath}`);
            }
            if (task.description) {
              log.cli("\nDescription:");
              log.cli(task.description);
            }
          }
        } catch (error) {
          log.cliError("Error getting task:");
          log.error("Error details for getting task", error as Error);
          exit(1);
        }
      }
    );
}

/**
 * Creates the task status command
 */
export function createStatusCommand(): Command {
  const statusCommand = new Command("status").description("Task status operations");

  // Status get subcommand
  statusCommand
    .command("get")
    .description("Get the status of a task")
    .argument("<task-id>", "ID of the task")
    .option("--session <session>", "Session name to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--workspace <workspacePath>", "Path to main workspace (overrides repo and session)")
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output status as JSON")
    .action(
      async (
        taskId: string,
        options: {
          session?: string;
          repo?: string;
          workspace?: string;
          backend?: string;
          json?: boolean;
        }
      ) => {
        try {
          // Convert CLI options to domain parameters
          const params: TaskStatusGetParams = {
            taskId,
            session: options.session,
            repo: options.repo,
            workspace: options.workspace,
            backend: options.backend,
            json: options.json,
          };

          // Call the domain function
          const status = await getTaskStatusFromParams(params);

          // Format and display the result
          if (options.json) {
            // For JSON output, write directly to stdout
            process.stdout.write(`${JSON.stringify({ taskId, status }, null, 2)}\n`);
          } else {
            // Normalize the ID for display to ensure consistent formatting
            const displayId = normalizeTaskId(taskId) || taskId;
            log.cli(`Status of task ${displayId}: ${status}`);
          }
        } catch (error) {
          log.cliError("Error getting task status:");
          log.error("Error details for getting task status", error as Error);
          exit(1);
        }
      }
    );

  // Status set subcommand
  statusCommand
    .command("set")
    .description("Set the status of a task")
    .argument("<task-id>", "ID of the task")
    // The linter error for TASK_STATUS here seems incorrect, Object.values(TASK_STATUS) is a valid value usage.
    .argument("[status]", `New status for the task (${Object.values(TASK_STATUS).join(" | ")})`)
    .option("--session <session>", "Session name to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--workspace <workspacePath>", "Path to main workspace (overrides repo and session)")
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output confirmation as JSON") // Added for consistency, might not be used by domain
    .action(
      async (
        taskId: string,
        status: string | undefined, // status comes as a string from commander or undefined if not provided
        options: {
          session?: string;
          repo?: string;
          workspace?: string;
          backend?: string;
          json?: boolean;
        }
      ) => {
        // If status is not provided, prompt for it interactively
        if (!status) {
          // Check if we're in a non-interactive environment
          if (!process.stdout.isTTY) {
            log.cliError(
              `Status is required in non-interactive mode.\nValid options are: ${Object.values(TASK_STATUS).join(", ")}`
            );
            exit(1);
          }

          try {
            // Convert CLI options to domain parameters for getting task
            const getParams: TaskStatusGetParams = {
              taskId,
              session: options.session,
              repo: options.repo,
              workspace: options.workspace,
              backend: options.backend,
              json: false,
            };

            // Get current status for task context
            const currentStatus = await getTaskStatusFromParams(getParams);

            // Prompt for status using @clack/prompts
            const statusOptions = Object.values(TASK_STATUS).map((value) => ({
              value,
              label: value,
            }));

            const statusChoice = await p.select({
              message: `Select new status for task ${normalizeTaskId(taskId) || taskId}:`,
              options: statusOptions,
              initialValue: currentStatus || TASK_STATUS.TODO,
            });

            // Handle cancellation
            if (p.isCancel(statusChoice)) {
              p.cancel("Operation cancelled");
              exit(0);
            }

            // Set the chosen status
            status = statusChoice.toString();
          } catch (error) {
            log.cliError("Error getting task status for prompt:");
            log.error("Error details for getting task status", error as Error);
            exit(1);
          }
        }

        // Validate status
        if (!Object.values(TASK_STATUS).includes(status as z.infer<typeof taskStatusSchema>)) {
          log.cliError(
            `Invalid status: ${status}. Must be one of ${Object.values(TASK_STATUS).join(", ")}.`
          );
          exit(1);
        }

        try {
          // Convert CLI options to domain parameters
          const params: TaskStatusSetParams = {
            taskId,
            status: status as z.infer<typeof taskStatusSchema>, // Cast to the specific string literal type for the domain
            session: options.session,
            repo: options.repo,
            workspace: options.workspace,
            backend: options.backend,
            json: options.json,
          };

          // Call the domain function
          await setTaskStatusFromParams(params);

          // Display success message
          if (options.json) {
            // For JSON output, write directly to stdout
            process.stdout.write(
              `${JSON.stringify(
                {
                  taskId,
                  status,
                  success: true,
                },
                null,
                2
              )}\n`
            );
          } else {
            // Normalize the ID for display to ensure consistent formatting
            const displayId = normalizeTaskId(taskId) || taskId;
            log.cli(`Status of task ${displayId} set to ${status}`);
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            log.cliError(`Error: ${error.message}`);
            log.error("Error details for MinskyError", error);
          } else {
            log.cliError("Error setting task status:");
            log.error("Error details for setting task status", error as Error);
          }
          exit(1);
        }
      }
    );

  return statusCommand;
}

/**
 * Creates the task create command
 */
export function createCreateCommand(): Command {
  return (
    new Command("create")
      .description("Create a new task from a specification file or URL")
      .argument("<spec-path>", "Path or URL to the task specification markdown file") // Corrected argument name to spec-path
      .option(
        "-f, --force",
        "Force creation even if a task with the same ID might exist (used by AI)"
      )
      .option("--json", "Output created task as JSON")
      // Session/repo/workspace options are implicitly handled by the domain if needed for backend resolution
      .action(async (specPath: string, options: { force?: boolean; json?: boolean }) => {
        // Corrected parameter name to specPath
        try {
          const params: TaskCreateParams = {
            specPath, // Corrected to use specPath
            force: options.force ?? false,
            json: options.json,
          };

          const task = await createTaskFromParams(params); // Corrected domain function call

          if (options.json) {
            // For JSON output, write directly to stdout
            process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
          } else {
            log.cli(`Task ${task.id} created: ${task.title}`);
            p.note(task.specPath, "Specification file");
          }
        } catch (error) {
          log.cliError(`Error creating task from spec: ${specPath}`);
          if (error instanceof MinskyError) {
            // Log the error object directly; logger will handle stack if available
            log.error(error.message, error);
          } else {
            log.error("Unexpected error during task creation", error as Error);
          }
          exit(1);
        }
      })
  );
}

/**
 * Creates the main tasks command and adds subcommands
 */
export function createTasksCommand(): Command {
  const tasksCommand = new Command("tasks").description("Manage tasks");

  tasksCommand.addCommand(createListCommand());
  tasksCommand.addCommand(createGetCommand());
  tasksCommand.addCommand(createStatusCommand());
  tasksCommand.addCommand(createCreateCommand());
  // Future: tasksCommand.addCommand(createUpdateCommand());
  // Future: tasksCommand.addCommand(createDeleteCommand());

  return tasksCommand;
}
