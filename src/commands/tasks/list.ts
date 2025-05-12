import { Command } from "commander";
import { TaskService, resolveRepoPath, resolveWorkspacePath } from "../../domain";
import { promisify } from "util";
import { exec } from "child_process";
import { generateFilterMessages } from "../../utils/filter-messages";

const execAsync = promisify(exec);

interface ListOptions {
  session?: string;
  repo?: string;
  backend?: string;
  all?: boolean;
  json?: boolean;
  status?: string;
}

export function createListCommand(): Command {
  const listCommand = new Command("list")
    .description("List tasks")
    .option("--session <session>", "Session to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--backend <backend>", "Specify task backend (markdown, github)")
    .option("--all", "Include all tasks regardless of status")
    .option("--status <status>", "Filter by status: TODO, IN_PROGRESS, DONE, etc.")
    .option("--json", "Output as JSON")
    .action(async (options: ListOptions) => {
      try {
        // Resolve repository path
        let workspacePath = options.repo;
        if (!workspacePath) {
          workspacePath = await resolveRepoPath({
            session: options.session,
          });
        }
        if (!workspacePath) {
          throw new Error(
            "Could not determine repository path. Please provide --repo or --session option."
          );
        }

        // Create task service with resolved workspace path
        const taskService = new TaskService({
          workspacePath,
          backend: options.backend,
        });

        // Get tasks
        const tasks = await taskService.listTasks();

        // Filter tasks if needed
        let filteredTasks = tasks;
        if (options.status) {
          filteredTasks = tasks.filter((task) => task.status === options.status);
        } else if (!options.all) {
          // By default, exclude DONE tasks
          filteredTasks = tasks.filter((task) => task.status !== "DONE");
        }

        // Generate filter messages
        const filterMessages = generateFilterMessages({
          status: options.status,
          all: options.all,
        });

        // Output tasks
        if (options.json) {
          console.log(JSON.stringify(filteredTasks, null, 2));
        } else {
          // Display filter messages in non-JSON mode
          if (filterMessages.length > 0) {
            filterMessages.forEach((message) => console.log(message));
            console.log("");
          }

          if (filteredTasks.length === 0) {
            console.log("No tasks found.");
            return;
          }

          console.log(`Found ${filteredTasks.length} tasks:\n`);

          for (const task of filteredTasks) {
            console.log(`${task.id}: ${task.title} [${task.status}]`);
          }
        }
      } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return listCommand;
}
