import { Command } from "commander";
import { TaskService, resolveRepoPath, resolveWorkspacePath, SessionDB } from "../../domain";
import { promisify } from "util";
import { exec } from "child_process";
import { join } from "path";

const execAsync = promisify(exec);

interface GetOptions {
  session?: string;
  repo?: string;
  backend?: string;
  json?: boolean;
  config?: boolean;
}

export function createGetCommand(): Command {
  const getCommand = new Command("get")
    .description("Get details for a specific task")
    .argument("<task-id>", "Task ID to get details for")
    .option("--session <session>", "Session to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output task as JSON")
    .option("--config", "Include task configuration in output")
    .action(async (taskId: string, options: GetOptions) => {
      try {
        // Resolve repository path
        let workspacePath = options.repo;
        if (!workspacePath && options.session) {
          const sessionDB = new SessionDB();
          const session = await sessionDB.getSession(options.session);
          if (!session) {
            throw new Error(`Session "${options.session}" not found`);
          }
          workspacePath = session.repoUrl;
        }
        if (!workspacePath) {
          workspacePath = await resolveRepoPath({});
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

        // Get task details
        const task = await taskService.getTask(taskId);

        if (!task) {
          console.error(`Task ${taskId} not found.`);
          process.exit(1);
        }

        // Create absolute paths for config files
        const config: Record<string, string> = {};
        if (options.config && task.specPath) {
          config.specPath = await resolveWorkspacePath({
            workspace: join(workspacePath, task.specPath),
          });
        }

        // Output the result
        if (options.json) {
          console.log(JSON.stringify({ ...task, config }, null, 2));
        } else {
          console.log(`Task ${task.id}: ${task.title}`);
          console.log(`Status: ${task.status}`);
          console.log(`Spec: ${task.specPath}`);

          if (options.config && Object.keys(config).length > 0) {
            console.log("\nConfiguration:");
            console.log(`  Spec file: ${config.specPath}`);
          }

          // Display worklog entries if available
          if (task.worklog && task.worklog.length > 0) {
            console.log("\nWorklog:");
            console.log(
              task.worklog.map((entry: { timestamp: string; message: string }) => `  ${entry.timestamp} - ${entry.message}`).join("\n")
            );
          }
        }
      } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return getCommand;
}
