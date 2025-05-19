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
import { MinskyError, ValidationError } from "../../errors/index.js";
import * as p from "@clack/prompts";
import { log } from "../../utils/logger";
import { z } from "zod"; // Add import for z namespace
import { handleCliError, outputResult, isDebugMode } from "./utils/index.js";

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
    .option("--session <session>", "Session name to use for repository resolution")
    .option("--repo <repositoryUri>", "Repository URI (overrides session)")
    .option(
      "--upstream-repo <upstreamRepoUri>",
      "URI of the upstream repository (overrides repo and session)"
    )
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output tasks as JSON")
    .option("--all", "Include DONE tasks in the output (by default, DONE tasks are hidden)")
    .action(
      async (options: {
        status?: string;
        backend?: string;
        session?: string;
        repo?: string;
        "upstream-repo"?: string;
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
            workspace: options["upstream-repo"],
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
          handleCliError(error);
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
    .option("--session <session>", "Session name to use for repository resolution")
    .option("--repo <repositoryUri>", "Repository URI (overrides session)")
    .option(
      "--upstream-repo <upstreamRepoUri>",
      "URI of the upstream repository (overrides repo and session)"
    )
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output task as JSON")
    .action(
      async (
        taskId: string,
        options: {
          session?: string;
          repo?: string;
          "upstream-repo"?: string;
          backend?: string;
          json?: boolean;
        }
      ) => {
        try {
          // Normalize the task ID before passing to domain
          const normalizedTaskId = normalizeTaskId(taskId);
          if (!normalizedTaskId) {
            throw new ValidationError(
              `Invalid task ID: '${taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
            );
          }

          // Convert CLI options to domain parameters
          const params: TaskGetParams = {
            taskId: normalizedTaskId,
            session: options.session,
            repo: options.repo,
            workspace: options["upstream-repo"],
            backend: options.backend,
            json: options.json,
          };

          // Call the domain function
          const task = await getTaskFromParams(params);

          // Format and display the result
          outputResult(task, {
            json: options.json,
            formatter: (task) => {
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
          });
        } catch (error) {
          handleCliError(error);
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
    .option("--session <session>", "Session name to use for repository resolution")
    .option("--repo <repositoryUri>", "Repository URI (overrides session)")
    .option(
      "--upstream-repo <upstreamRepoUri>",
      "URI of the upstream repository (overrides repo and session)"
    )
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output status as JSON")
    .action(
      async (
        taskId: string,
        options: {
          session?: string;
          repo?: string;
          "upstream-repo"?: string;
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
            workspace: options["upstream-repo"],
            backend: options.backend,
            json: options.json,
          };

          // Call the domain function
          const status = await getTaskStatusFromParams(params);

          // Format and display the result
          outputResult({ taskId, status }, {
            json: options.json,
            formatter: (result) => {
              // Normalize the ID for display to ensure consistent formatting
              const displayId = normalizeTaskId(result.taskId) || result.taskId;
              log.cli(`Status of task ${displayId}: ${result.status}`);
            }
          });
        } catch (error) {
          handleCliError(error);
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
    .option("--session <session>", "Session name to use for repository resolution")
    .option("--repo <repositoryUri>", "Repository URI (overrides session)")
    .option(
      "--upstream-repo <upstreamRepoUri>",
      "URI of the upstream repository (overrides repo and session)"
    )
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output confirmation as JSON") // Added for consistency, might not be used by domain
    .action(
      async (
        taskId: string,
        status: string | undefined, // status comes as a string from commander or undefined if not provided
        options: {
          session?: string;
          repo?: string;
          "upstream-repo"?: string;
          backend?: string;
          json?: boolean;
        }
      ) => {
        // If status is not provided, prompt for it interactively
        if (!status) {
          // Check if we're in a non-interactive environment
          if (!process.stdout.isTTY) {
            throw new ValidationError(
              `Status is required in non-interactive mode.\nValid options are: ${Object.values(TASK_STATUS).join(", ")}`
            );
          }

          try {
            // Convert CLI options to domain parameters for getting task
            const getParams: TaskStatusGetParams = {
              taskId,
              session: options.session,
              repo: options.repo,
              workspace: options["upstream-repo"],
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
              process.exit(0);
            }

            // Set the chosen status
            status = statusChoice.toString();
          } catch (error) {
            handleCliError(error);
          }
        }

        // Validate status
        if (!Object.values(TASK_STATUS).includes(status as z.infer<typeof taskStatusSchema>)) {
          throw new ValidationError(
            `Invalid status: ${status}. Must be one of ${Object.values(TASK_STATUS).join(", ")}.`
          );
        }

        try {
          // Convert CLI options to domain parameters
          const params: TaskStatusSetParams = {
            taskId,
            status: status as z.infer<typeof taskStatusSchema>, // Cast to the specific string literal type for the domain
            session: options.session,
            repo: options.repo,
            workspace: options["upstream-repo"],
            backend: options.backend,
            json: options.json,
          };

          // Call the domain function
          await setTaskStatusFromParams(params);

          // Display success message
          outputResult(
            {
              taskId,
              status,
              success: true,
            },
            {
              json: options.json,
              formatter: (result) => {
                // Normalize the ID for display to ensure consistent formatting
                const displayId = normalizeTaskId(result.taskId) || result.taskId;
                log.cli(`Status of task ${displayId} set to ${result.status}`);
              }
            }
          );
        } catch (error) {
          handleCliError(error);
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

          outputResult(task, {
            json: options.json, 
            formatter: (task) => {
              log.cli(`Task ${task.id} created: ${task.title}`);
              p.note(task.specPath, "Specification file");
            }
          });
        } catch (error) {
          handleCliError(error);
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
