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
import {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
} from "../../domain/index.js";
import { MinskyError } from "../../errors/index.js";
import { TASK_STATUS } from "../../domain/tasks.js";
import * as p from "@clack/prompts";

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
              console.log(JSON.stringify([]));
            } else {
              // Generate and display filter messages in non-JSON mode
              const filterMessages = generateFilterMessages({
                status: options.status,
                all: options.all,
              });

              // Display filter messages if any exist
              if (filterMessages.length > 0) {
                filterMessages.forEach((message) => console.log(message));
                console.log("");
              }

              console.log("No tasks found.");
            }
            return;
          }

          if (options.json) {
            console.log(JSON.stringify(tasks, null, 2));
          } else {
            // Generate and display filter messages in non-JSON mode
            const filterMessages = generateFilterMessages({
              status: options.status,
              all: options.all,
            });

            // Display filter messages if any exist
            if (filterMessages.length > 0) {
              filterMessages.forEach((message) => console.log(message));
              console.log("");
            }

            console.log("Tasks:");
            tasks.forEach((task) => {
              console.log(`- ${task.id}: ${task.title} [${task.status}]`);
            });
          }
        } catch (error) {
          console.error("Error listing tasks:", error);
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
          // Convert CLI options to domain parameters
          const params: TaskGetParams = {
            taskId,
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
            console.log(JSON.stringify(task, null, 2));
          } else {
            console.log(`Task #${task.id}:`);
            console.log(`Title: ${task.title}`);
            console.log(`Status: ${task.status}`);
            if (task.specPath) {
              console.log(`Spec: ${task.specPath}`);
            }
            if (task.description) {
              console.log("\nDescription:");
              console.log(task.description);
            }
          }
        } catch (error) {
          console.error("Error getting task:", error);
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
            console.log(JSON.stringify({ taskId, status }, null, 2));
          } else {
            console.log(`Status of task #${taskId}: ${status}`);
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error(`Unexpected error: ${error}`);
          }
          exit(1);
        }
      }
    );

  // Status set subcommand
  statusCommand
    .command("set")
    .description("Set the status of a task")
    .argument("<task-id>", "ID of the task")
    .argument("[status]", "New status for the task (TODO, IN-PROGRESS, IN-REVIEW, DONE)")
    .option("--session <session>", "Session name to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--workspace <workspacePath>", "Path to main workspace (overrides repo and session)")
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .action(
      async (
        taskId: string,
        status: string | undefined,
        options: {
          session?: string;
          repo?: string;
          workspace?: string;
          backend?: string;
        }
      ) => {
        try {
          // If status is not provided, try to prompt interactively
          if (!status) {
            // Check if we're in an interactive environment
            if (!process.stdout.isTTY) {
              console.error("Error: Status is required in non-interactive environments");
              exit(1);
              return;
            }

            // Show interactive prompt for status
            p.intro("Task Status Update");

            const selectedStatus = await p.select({
              message: `Select a status for task ${taskId}:`,
              options: Object.values(TASK_STATUS).map((s) => ({ value: s, label: s })),
            });

            // Handle cancellation
            if (p.isCancel(selectedStatus)) {
              p.cancel("Status update cancelled");
              exit(0);
              return;
            }

            status = selectedStatus as string;
            p.log.success(`Selected status: ${status}`);
            p.outro("Updating task status...");
          }

          // Convert CLI options to domain parameters
          const params: TaskStatusSetParams = {
            taskId,
            status: status as any, // We'll let the domain function validate this
            session: options.session,
            repo: options.repo,
            workspace: options.workspace,
            backend: options.backend,
          };

          // Call the domain function
          await setTaskStatusFromParams(params);

          // Display success message
          console.log(`Status of task #${taskId} set to ${status}`);
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error(`Unexpected error: ${error}`);
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
  return new Command("create")
    .description("Create a new task from a specification document")
    .argument("<spec-path>", "Path to the task specification document")
    .option("--session <session>", "Session name to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--workspace <workspacePath>", "Path to main workspace (overrides repo and session)")
    .option("-b, --backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output created task as JSON")
    .option("--force", "Force creation even if task already exists")
    .action(
      async (
        specPath: string,
        options: {
          session?: string;
          repo?: string;
          workspace?: string;
          backend?: string;
          json?: boolean;
          force?: boolean;
        }
      ) => {
        try {
          // This will be replaced with direct domain function call
          const params: TaskCreateParams = {
            specPath,
            session: options.session,
            repo: options.repo,
            workspace: options.workspace,
            json: options.json,
            force: options.force ?? false,
            // Note: backend will be handled by the domain function
          };

          // Placeholder for direct domain function call
          // const task = await createTaskFromParams(params);

          // Temporary - using existing CLI command until we refactor the domain
          let command = `bun src/cli.ts tasks create ${specPath}`;
          if (options.session) command += ` --session ${options.session}`;
          if (options.repo) command += ` --repo ${options.repo}`;
          if (options.workspace) command += ` --workspace ${options.workspace}`;
          if (options.backend) command += ` -b ${options.backend}`;
          if (options.json) command += " --json";
          if (options.force) command += " --force";

          const output = execSync(command).toString();
          console.log(output);
        } catch (error) {
          console.error("Error creating task:", error);
          exit(1);
        }
      }
    );
}

/**
 * Creates the main tasks command with all subcommands
 */
export function createTasksCommand(): Command {
  const tasksCommand = new Command("tasks").description("Task management operations");

  tasksCommand.addCommand(createListCommand());
  tasksCommand.addCommand(createGetCommand());
  tasksCommand.addCommand(createStatusCommand());
  tasksCommand.addCommand(createCreateCommand());

  return tasksCommand;
}
