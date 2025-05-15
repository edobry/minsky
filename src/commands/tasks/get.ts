import { Command } from "commander";
import { TaskService, resolveRepoPath, resolveWorkspacePath, SessionDB } from "../../domain";
import { normalizeTaskId } from "../../domain/tasks/utils";
import { getCurrentSessionContext } from "../../domain/workspace.js";
import { promisify } from "util";
import { exec } from "child_process";
import { join } from "path";
import { log } from "../../utils/logger.js";

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
    .argument("[task-id]", "Task ID to get details for (optional, auto-detects if in session)")
    .option("--session <session>", "Session to use for repo resolution")
    .option("--repo <repoPath>", "Path to a git repository (overrides session)")
    .option("--backend <backend>", "Specify task backend (markdown, github)")
    .option("--json", "Output task as JSON")
    .option("--config", "Include task configuration in output")
    .action(async (taskIdArgument: string | undefined, options: GetOptions) => {
      try {
        let taskIdToUse: string | null = null;
        let originalInputForError: string = "auto-detected";

        if (taskIdArgument) {
          originalInputForError = taskIdArgument;
          taskIdToUse = normalizeTaskId(taskIdArgument);
          if (!taskIdToUse) {
            log.cliError(`Error: Invalid Task ID format provided: "${taskIdArgument}"`);
            process.exit(1);
            return;
          }
        } else {
          const sessionContext = await getCurrentSessionContext();
          if (sessionContext && sessionContext.taskId) {
            const contextTaskId = sessionContext.taskId.startsWith("#") ? sessionContext.taskId : `#${sessionContext.taskId}`;
            taskIdToUse = normalizeTaskId(contextTaskId);
            originalInputForError = contextTaskId;
            if (!taskIdToUse) {
              log.cliError(`Error: Invalid Task ID format from session context: "${contextTaskId}"`);
              process.exit(1);
              return;
            }
            if (!options.json) {
              log.cli(`Auto-detected task ID: ${taskIdToUse} (from current session)`);
            }
          } else {
            log.cliError(
              "Task ID not provided and could not auto-detect from the current session. " +
                "Please provide a task ID or run this command from within a session associated with a task."
            );
            process.exit(1);
            return;
          }
        }

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

        const taskService = new TaskService({
          workspacePath,
          backend: options.backend,
        });

        const task = await taskService.getTask(taskIdToUse);

        if (!task) {
          log.cliError(`Task with ID originating from "${originalInputForError}" (normalized to "${taskIdToUse}") not found.`);
          process.exit(1);
        }

        const config: Record<string, string> = {};
        if (options.config && task.specPath) {
          config.specPath = await resolveWorkspacePath({
            workspace: join(workspacePath, task.specPath),
          });
        }

        if (options.json) {
          log.agent(JSON.stringify({ ...task, config }, null, 2));
        } else {
          log.cli(`Task ${task.id}: ${task.title}`);
          log.cli(`Status: ${task.status}`);
          log.cli(`Spec: ${task.specPath}`);

          if (options.config && Object.keys(config).length > 0) {
            log.cli("\nConfiguration:");
            log.cli(`  Spec file: ${config.specPath}`);
          }

          if (task.worklog && task.worklog.length > 0) {
            log.cli("\nWorklog:");
            log.cli(
              task.worklog
                .map(
                  (entry: { timestamp: string; message: string }) =>
                    `  ${entry.timestamp} - ${entry.message}`
                )
                .join("\n")
            );
          }
        }
      } catch (error) {
        log.cliError(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  return getCommand;
}
