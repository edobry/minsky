/**
 * CLI adapter for session commands
 */
import { Command } from "commander";
import type {
  SessionGetParams,
  SessionStartParams,
  SessionUpdateParams,
  SessionDirParams,
  SessionDeleteParams,
  SessionListParams,
} from "../../schemas/session.js";
import {
  getSessionFromParams,
  listSessionsFromParams,
  startSessionFromParams,
  updateSessionFromParams,
  getSessionDirFromParams,
  deleteSessionFromParams,
} from "../../domain/index.js";
import { MinskyError } from "../../errors/index.js";
import { getCurrentSession as defaultGetCurrentSession } from "../../domain/workspace.js";
import { GitService } from "../../domain/git.js";
import { SessionDB } from "../../domain/session.js";

// Add a dependencies parameter to allow dependency injection for testing
export interface SessionCommandDependencies {
  getCurrentSession?: typeof defaultGetCurrentSession;
  gitService?: GitService;
  sessionDb?: SessionDB;
}

/**
 * Creates the session list command
 */
export function createListCommand(): Command {
  return new Command("list")
    .description("List all sessions")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        json?: boolean;
      }) => {
        try {
          // Convert CLI options to domain parameters
          const params: SessionListParams = {
            json: options.json,
          };

          // Call the domain function
          const sessions = await listSessionsFromParams(params);

          // Format and display the results
          if (options.json) {
            console.log(JSON.stringify(sessions, null, 2));
          } else {
            if (sessions.length === 0) {
              console.log("No sessions found");
              return;
            }

            console.log("Sessions:");
            sessions.forEach((session) => {
              const taskInfo = session.taskId ? ` (task: ${session.taskId})` : "";
              console.log(`- ${session.session}${taskInfo}`);
            });
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error(`Unexpected error: ${error}`);
          }
          process.exit(1);
        }
      }
    );
}

/**
 * Creates the session get command
 */
export function createGetCommand(): Command {
  return new Command("get")
    .description("Get details for a specific session or by task ID")
    .argument("[session]", "Name of the session to get details for")
    .option("--task <task-id>", "Get session by task ID instead of name")
    .option("--json", "Output as JSON")
    .action(
      async (
        session: string | undefined,
        options: {
          task?: string;
          json?: boolean;
        }
      ) => {
        try {
          // Convert CLI options to domain parameters
          const params: SessionGetParams = {
            name: session,
            task: options.task,
            json: options.json,
          };

          // Call the domain function
          const sessionData = await getSessionFromParams(params);

          // Format and display the result
          if (options.json) {
            console.log(JSON.stringify(sessionData, null, 2));
          } else {
            if (!sessionData) {
              console.log("Session not found");
              return;
            }

            console.log(`Session: ${sessionData.session}`);
            console.log(`Repository: ${sessionData.repoUrl}`);
            console.log(`Created: ${sessionData.createdAt}`);
            
            if (sessionData.taskId) {
              console.log(`Task: ${sessionData.taskId}`);
            }
            
            // Display any additional metadata
            if (sessionData.repoPath) {
              console.log(`Repository Path: ${sessionData.repoPath}`);
            }
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error(`Unexpected error: ${error}`);
          }
          process.exit(1);
        }
      }
    );
}

/**
 * Creates the session dir command
 */
export function createDirCommand(): Command {
  return new Command("dir")
    .description("Print the workdir path for a session (for use with cd $(minsky session dir <session>)). If no session or task is provided, auto-detects the current session if run from a session workspace.")
    .argument("[session]", "Name of the session")
    .option("--task <task-id>", "Get directory by task ID instead of session name")
    .option("--repo <repo>", "Repository path (overrides autodetection)")
    .option("--ignore-workspace", "Ignore workspace auto-detection")
    .action(
      async (
        session: string | undefined,
        options: {
          task?: string;
          repo?: string;
          ignoreWorkspace?: boolean;
        }
      ) => {
        try {
          // Convert CLI options to domain parameters
          const params: SessionDirParams = {
            name: session,
            task: options.task,
            repo: options.repo,
            // We'll skip ignoreWorkspace for now since it might not be in the schema
          };

          // Call the domain function
          const sessionDir = await getSessionDirFromParams(params);

          // Just print the directory path (for use with cd $(minsky session dir ...))
          console.log(sessionDir);
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error(`Unexpected error: ${error}`);
          }
          process.exit(1);
        }
      }
    );
}

/**
 * Creates the session start command
 */
export function createStartCommand(): Command {
  return new Command("start")
    .description("Start a new session with a cloned repository")
    .argument("[name]", "Name for the new session")
    .option("--task <task-id>", "Associate session with a task")
    .option("--repo <repo>", "Path or URL to repository")
    .option("--quiet", "Only output session directory path")
    .option("--no-status-update", "Skip updating task status when creating session")
    .option("--branch <branch>", "Branch to use for the session")
    .option("--json", "Output as JSON")
    .action(
      async (
        name: string | undefined,
        options: {
          task?: string;
          repo?: string;
          quiet?: boolean;
          statusUpdate?: boolean;
          branch?: string;
          json?: boolean;
        }
      ) => {
        try {
          // Convert CLI options to domain parameters
          const params: SessionStartParams = {
            name,
            task: options.task,
            repo: options.repo,
            quiet: options.quiet ?? false,
            noStatusUpdate: options.statusUpdate === false, // Invert the CLI flag
            branch: options.branch,
            json: options.json,
          };

          // Call the domain function
          const result = await startSessionFromParams(params);

          // Format and display the result
          if (options.quiet) {
            // Only output the session directory path
            console.log(result.sessionRecord.repoPath);
          } else if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Started session: ${result.sessionRecord.session}`);
            console.log(`Repository: ${result.sessionRecord.repoUrl}`);
            console.log(`Directory: ${result.sessionRecord.repoPath}`);

            if (result.sessionRecord.taskId) {
              console.log(`Task: ${result.sessionRecord.taskId}`);
            }

            if (result.statusUpdateResult) {
              const { taskId, previousStatus, newStatus } = result.statusUpdateResult;
              console.log(
                `\nTask ${taskId} status updated: ${previousStatus || "none"} → ${newStatus}`
              );
            }
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error(`Unexpected error: ${error}`);
          }
          process.exit(1);
        }
      }
    );
}

/**
 * Creates the session delete command
 */
export function createDeleteCommand(): Command {
  return new Command("delete")
    .description("Delete a session and its repository")
    .argument("[session-name]", "Name of the session to delete")
    .option("--task <task-id>", "Delete session by task ID")
    .option("--force", "Skip confirmation prompt")
    .option("--json", "Output as JSON")
    .action(
      async (
        name: string | undefined,
        options: {
          task?: string;
          force?: boolean;
          json?: boolean;
        }
      ) => {
        try {
          // Convert CLI options to domain parameters
          const params: SessionDeleteParams = {
            name: name ?? "",  // Ensure we provide a string, default to empty string
            task: options.task,
            force: options.force ?? false,
            json: options.json,
          };

          // Call the domain function
          const result = await deleteSessionFromParams(params);

          // Format and display the result
          if (options.json) {
            console.log(JSON.stringify({ success: result }, null, 2));
          } else {
            console.log(`Session ${name || `for task ${options.task}`} was deleted successfully.`);
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error(`Unexpected error: ${error}`);
          }
          process.exit(1);
        }
      }
    );
}

/**
 * Creates the session update command
 */
export function createUpdateCommand(): Command {
  return new Command("update")
    .description("Update a session with the latest changes from the main branch. If no session is provided, auto-detects the current session if run from a session workspace.")
    .argument("[session]", "Name of the session to update")
    .option("--task <task-id>", "Update session by task ID")
    .option("--repo <repo>", "Repository path (overrides autodetection)")
    .option("--branch <branch>", "Branch to pull from (defaults to main)")
    .option("--no-stash", "Skip stashing changes")
    .option("--no-push", "Skip pushing changes after update")
    .option("--json", "Output as JSON")
    .action(
      async (
        session: string | undefined,
        options: {
          task?: string;
          repo?: string;
          branch?: string;
          stash?: boolean;
          push?: boolean;
          json?: boolean;
        }
      ) => {
        try {
          // Convert CLI options to domain parameters
          const params: SessionUpdateParams = {
            name: session ?? "", // Ensure we provide a string, default to empty string 
            task: options.task,
            repo: options.repo,
            branch: options.branch,
            noStash: options.stash === false,
            noPush: options.push === false,
            json: options.json,
          };

          // Call the domain function
          const result = await updateSessionFromParams(params);

          // Format and display the result
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            if (!result) {
              console.log("Session update failed.");
              return;
            }

            console.log(`Updated session: ${result.session}`);
            console.log(`Repository: ${result.repoUrl}`);
            
            if (result.taskId) {
              console.log(`Task: ${result.taskId}`);
            }
          }
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error(`Unexpected error: ${error}`);
          }
          process.exit(1);
        }
      }
    );
}

/**
 * Creates the session commit command
 */
export function createCommitCommand(): Command {
  return new Command("commit")
    .description("Stage, commit, and optionally push all changes for a session")
    .argument("[session]", "Name of the session")
    .requiredOption("-m, --message <message>", "Commit message")
    .option("--no-push", "Skip pushing changes after commit")
    .option("--repo <repo>", "Repository path (if not in a session or to override)")
    .option("--json", "Output as JSON")
    .action(
      async (
        session: string | undefined,
        options: {
          message: string;
          push?: boolean;
          repo?: string;
          json?: boolean;
        }
      ) => {
        try {
          // This command will be implemented using the git adapter commit functionality
          // with session awareness. For now, just use the temporary implementation
          console.log("Session commit functionality not yet implemented in the adapter.");
          console.log("Implement this by using the Git adapter commit functionality with session awareness.");
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error(`Unexpected error: ${error}`);
          }
          process.exit(1);
        }
      }
    );
}

/**
 * Creates the main session command with all subcommands
 */
export function createSessionCommand(dependencies: SessionCommandDependencies = {}): Command {
  // Use provided dependencies or fall back to defaults
  const gitService = dependencies?.gitService || new GitService();
  const sessionDb = dependencies?.sessionDb || new SessionDB();
  const getCurrentSession = dependencies?.getCurrentSession || defaultGetCurrentSession;

  const commandDeps = {
    getCurrentSession,
  };

  const sessionCommand = new Command("session").description("Session management commands");

  // Using the command creators without passing dependencies for now
  // In the future, these could be updated to accept dependencies similar to the original implementation
  sessionCommand.addCommand(createListCommand());
  sessionCommand.addCommand(createGetCommand());
  sessionCommand.addCommand(createDirCommand());
  sessionCommand.addCommand(createStartCommand());
  sessionCommand.addCommand(createDeleteCommand());
  sessionCommand.addCommand(createUpdateCommand());
  sessionCommand.addCommand(createCommitCommand());

  return sessionCommand;
} 
