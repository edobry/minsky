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
  TaskSpecContentParams,
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
  getTaskSpecContentFromParams,
} from "../../domain/tasks.js";
import { MinskyError, ValidationError } from "../../errors/index.js";
import * as p from "@clack/prompts";
import { log } from "../../utils/logger.js";
import { z } from "zod"; // Add import for z namespace
import { 
  handleCliError, 
  outputResult, 
  isDebugMode,
  addRepoOptions,
  addOutputOptions,
  addBackendOptions,
  normalizeTaskParams,
} from "./utils/index.js";

// Import task commands
import { createSpecCommand } from './tasks/index.js';

// Helper for exiting process consistently
function exit(code: number): never {
  process.exit(code);
}

/**
 * Creates the task list command
 */
export function createListCommand(): Command {
  const command = new Command("list")
    .description("List tasks")
    .option("-s, --status <status>", "Filter tasks by status")
    .option("--all", "Include DONE tasks in the output (by default, DONE tasks are hidden)");
  
  // Add shared options
  addRepoOptions(command);
  addOutputOptions(command);
  addBackendOptions(command);
  
  command.action(
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
        // Convert CLI options to domain parameters using normalization helper
        const normalizedParams = normalizeTaskParams(options);
        
        const params: TaskListParams = {
          ...normalizedParams,
          filter: options.status,
          all: options.all ?? false,
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
  
  return command;
}

/**
 * Creates the task get command
 */
export function createGetCommand(): Command {
  const command = new Command("get")
    .description("Get task details")
    .argument("[task-ids...]", "ID(s) of the task(s) to retrieve. Multiple IDs can be provided as separate arguments or as a comma-separated list.");
  
  // Add shared options
  addRepoOptions(command);
  addOutputOptions(command);
  addBackendOptions(command);
  
  command.action(
    async (
      taskIds: string[],
      options: {
        session?: string;
        repo?: string;
        "upstream-repo"?: string;
        backend?: string;
        json?: boolean;
      }
    ) => {
      try {
        // Handle case when no task IDs are provided
        if (!taskIds || taskIds.length === 0) {
          throw new ValidationError("Please provide at least one task ID.");
        }

        // Process potential comma-separated values
        const processedTaskIds: string[] = taskIds.flatMap(id => 
          id.includes(',') ? id.split(',') : id
        );

        // If we have only one task ID, handle it as before
        if (processedTaskIds.length === 1) {
          // Normalize the task ID before passing to domain
          const normalizedTaskId = normalizeTaskId(processedTaskIds[0]);
          if (!normalizedTaskId) {
            throw new ValidationError(
              `Invalid task ID: '${processedTaskIds[0]}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
            );
          }

          // Convert CLI options to domain parameters using normalization helper
          const normalizedParams = normalizeTaskParams(options);
          
          // Convert CLI options to domain parameters
          const params: TaskGetParams = {
            ...normalizedParams,
            taskId: normalizedTaskId,
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
            },
          });
        } else {
          // Handle multiple task IDs
          // Normalize all task IDs
          const normalizedTaskIds = processedTaskIds.map(id => {
            const normalized = normalizeTaskId(id);
            if (!normalized) {
              throw new ValidationError(
                `Invalid task ID: '${id}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
              );
            }
            return normalized;
          });

          // Convert CLI options to domain parameters
          const normalizedParams = normalizeTaskParams(options);
          
          // Create parameters with array of task IDs
          const params: TaskGetParams = {
            ...normalizedParams,
            taskId: normalizedTaskIds,
          };

          // Call the domain function
          const result = await getTaskFromParams(params);

          // Format and display the results
          outputResult(result, {
            json: options.json,
            formatter: (result) => {
              // Handle the case where we get a single task (backward compatibility)
              if (!result.tasks && !result.errors) {
                const task = result;
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
                return;
              }

              // Display successful results
              if (result.tasks && result.tasks.length > 0) {
                log.cli(`Found ${result.tasks.length} tasks:`);
                
                // Display each task with a separator
                result.tasks.forEach((task, index) => {
                  if (index > 0) {
                    log.cli('\n----------------------------------------\n');
                  }
                  
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
                });
              }

              // Display errors if any
              if (result.errors && result.errors.length > 0) {
                log.cli(
                  `\n${result.errors.length} task(s) could not be found or had errors:`
                );
                result.errors.forEach((error) => {
                  log.cli(`- Task ${error.taskId}: ${error.error}`);
                });
              }
            },
          });
        }
      } catch (error) {
        handleCliError(error);
      }
    }
  );
  
  return command;
}

/**
 * Creates the task status command
 */
export function createStatusCommand(): Command {
  const statusCommand = new Command("status").description("Task status operations");

  // Status get subcommand
  const getCommand = statusCommand
    .command("get")
    .description("Get the status of a task")
    .argument("<task-id>", "ID of the task");
  
  // Add shared options
  addRepoOptions(getCommand);
  addOutputOptions(getCommand);
  addBackendOptions(getCommand);
  
  getCommand.action(
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
        // Convert CLI options to domain parameters using normalization helper
        const normalizedParams = normalizeTaskParams(options);
        
        // Convert CLI options to domain parameters
        const params: TaskStatusGetParams = {
          ...normalizedParams,
          taskId,
        };

        // Call the domain function
        const status = await getTaskStatusFromParams(params);

        // Format and display the result
        outputResult(
          { taskId, status },
          {
            json: options.json,
            formatter: (result) => {
              // Normalize the ID for display to ensure consistent formatting
              const displayId = normalizeTaskId(result.taskId) || result.taskId;
              log.cli(`Status of task ${displayId}: ${result.status}`);
            },
          }
        );
      } catch (error) {
        handleCliError(error);
      }
    }
  );

  // Status set subcommand
  const setCommand = statusCommand
    .command("set")
    .description("Set the status of a task")
    .argument("<task-id>", "ID of the task")
    // The linter error for TASK_STATUS here seems incorrect, Object.values(TASK_STATUS) is a valid value usage.
    .argument("[status]", `New status for the task (${Object.values(TASK_STATUS).join(" | ")})`);
  
  // Add shared options
  addRepoOptions(setCommand);
  addOutputOptions(setCommand);
  addBackendOptions(setCommand);
  
  setCommand.action(
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
          // Convert CLI options to domain parameters using normalization helper
          const normalizedParams = normalizeTaskParams(options);
          
          // Convert CLI options to domain parameters for getting task
          const getParams: TaskStatusGetParams = {
            ...normalizedParams,
            taskId,
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
        // Convert CLI options to domain parameters using normalization helper
        const normalizedParams = normalizeTaskParams(options);
        
        // Convert CLI options to domain parameters
        const params: TaskStatusSetParams = {
          ...normalizedParams,
          taskId,
          status: status as z.infer<typeof taskStatusSchema>, // Cast to the specific string literal type for the domain
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
            },
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
  const command = new Command("create")
    .description("Create a new task from a specification file or URL")
    .argument("<spec-path>", "Path or URL to the task specification markdown file"); // Corrected argument name to spec-path
    
  // Add shared options
  addOutputOptions(command);
  command.option(
    "-f, --force",
    "Force creation even if a task with the same ID might exist (used by AI)"
  );
  
  command.action(async (specPath: string, options: { force?: boolean; json?: boolean }) => {
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
        },
      });
    } catch (error) {
      handleCliError(error);
    }
  });
  
  return command;
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
  tasksCommand.addCommand(createSpecCommand());
  // Future: tasksCommand.addCommand(createUpdateCommand());
  // Future: tasksCommand.addCommand(createDeleteCommand());

  return tasksCommand;
}
