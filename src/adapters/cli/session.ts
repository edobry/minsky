/**
 * CLI adapter for session commands
 */
import { Command } from "commander";
import type {
  SessionListParams,
  SessionGetParams,
  SessionStartParams,
  SessionDirParams,
  SessionDeleteParams,
  SessionUpdateParams,
  SessionApproveParams,
} from "../../schemas/session.js";
import { MinskyError } from "../../errors/index.js";
import {
  listSessionsFromParams,
  getSessionFromParams,
  startSessionFromParams,
  getSessionDirFromParams,
  deleteSessionFromParams,
  updateSessionFromParams,
  approveSessionFromParams,
  preparePrFromParams,
} from "../../domain/index.js";

interface GetCurrentSessionConfig {
  getCurrentSession: () => Promise<string | null>;
}

/**
 * Creates the session list command
 */
export function createListCommand(): Command {
  return new Command("list")
    .description("List all sessions")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionListParams = {
          json: options.json,
        };

        // Call the domain function
        const result = await listSessionsFromParams(params);

        // Output result
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          result.forEach((session) => {
            console.log(`Session: ${session.session}`);
            console.log(`  Repo: ${session.repoPath}`);
            console.log(`  Created: ${session.createdAt}`);
            console.log();
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
    });
}

/**
 * Creates the session get command
 */
export function createGetCommand(): Command {
  return new Command("get")
    .description("Get session details")
    .argument("[name]", "Session name")
    .option("--task <taskId>", "Task ID to match")
    .option("--json", "Output as JSON")
    .action(async (name?: string, options?: { task?: string; json?: boolean }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionGetParams = {
          name,
          task: options?.task,
          json: options?.json,
        };

        // Call the domain function
        const result = await getSessionFromParams(params);

        // Format output
        if (options?.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result) {
          console.log(`Session: ${result.session}`);
          console.log(`Repo: ${result.repoPath}`);
          console.log(`Branch: ${result.branch}`);
          console.log(`Created: ${result.createdAt}`);
          if (result.taskId) {
            console.log(`Task ID: ${result.taskId}`);
          }
        } else {
          console.log("Session not found");
        }
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error}`);
        }
        process.exit(1);
      }
    });
}

/**
 * Creates the session start command
 */
export function createStartCommand(): Command {
  return new Command("start")
    .description("Start a new session")
    .argument("[name]", "Session name")
    .option("--repo <path>", "Repository path")
    .option("--task <taskId>", "Task ID to associate with this session")
    .option("--quiet", "Only output the session directory path")
    .action(async (name?: string, options?: { repo?: string; task?: string; quiet?: boolean }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionStartParams = {
          name,
          repo: options?.repo,
          task: options?.task,
          quiet: options?.quiet || false,
          noStatusUpdate: false,
        };

        // Call the domain function
        const result = await startSessionFromParams(params);

        // Access the properties from the session record
        const sessionRecord = result.sessionRecord;

        // Output result
        if (options?.quiet) {
          // Get the session repo path for the quiet output
          const sessionDB = new (await import("../../domain/session.js")).SessionDB();
          const repoPath = await sessionDB.getRepoPath(sessionRecord);
          console.log(repoPath);
        } else {
          console.log(`Session '${sessionRecord.session}' created successfully.`);
          console.log(
            `Session directory: ${await new (await import("../../domain/session.js")).SessionDB().getRepoPath(sessionRecord)}`
          );
          console.log(`Branch: ${sessionRecord.branch}`);
        }
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error}`);
        }
        process.exit(1);
      }
    });
}

/**
 * Creates the session dir command
 */
export function createDirCommand(): Command {
  return new Command("dir")
    .description("Get the session directory")
    .argument("[name]", "Session name (auto-detected if in a session workspace)")
    .option("--task <taskId>", "Task ID to match")
    .action(async (name?: string, options?: { task?: string }) => {
      try {
        // Auto-detect session if not provided
        let autoDetectedSession = false;
        if (!name && !options?.task) {
          try {
            // Import getCurrentSessionContext to auto-detect session
            const { getCurrentSessionContext } = await import("../../domain/workspace.js");
            const sessionContext = await getCurrentSessionContext(process.cwd());

            if (sessionContext?.sessionId) {
              name = sessionContext.sessionId;
              autoDetectedSession = true;
              console.log(`Auto-detected session: ${name}`);
            }
          } catch (error) {
            // Just log the error but continue - the domain function will handle missing session
            console.error(
              "Error auto-detecting session",
              error instanceof Error ? error.message : String(error)
            );
          }
        }

        // Convert CLI options to domain parameters
        const params: SessionDirParams = {
          name,
          task: options?.task,
        };

        // Call the domain function
        const result = await getSessionDirFromParams(params);

        // Output result - getSessionDirFromParams returns a string
        console.log(result);
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error}`);
        }
        process.exit(1);
      }
    });
}

/**
 * Creates the session delete command
 */
export function createDeleteCommand(): Command {
  return new Command("delete")
    .description("Delete a session")
    .argument("[name]", "Session name")
    .option("--task <taskId>", "Task ID to match")
    .option("--force", "Force deletion without confirmation")
    .action(async (name?: string, options?: { task?: string; force?: boolean }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionDeleteParams = {
          name: name || "", // Provide default empty string
          task: options?.task,
          force: options?.force || false,
        };

        // Call the domain function
        const result = await deleteSessionFromParams(params);

        // Output result - deleteSessionFromParams returns a boolean
        if (result) {
          console.log("Session deleted successfully.");
        } else {
          console.log("Session deletion failed.");
        }
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error}`);
        }
        process.exit(1);
      }
    });
}

/**
 * Creates the session update command
 */
export function createUpdateCommand(): Command {
  return new Command("update")
    .description("Update session with latest changes from main branch")
    .argument("[name]", "Session name (auto-detected if in a session workspace)")
    .option("--json", "Output as JSON")
    .action(async (name?: string, options?: { json?: boolean }) => {
      try {
        // Auto-detect session if not provided
        let autoDetectedSession = false;
        if (!name) {
          try {
            // Import getCurrentSessionContext to auto-detect session
            const { getCurrentSessionContext } = await import("../../domain/workspace.js");
            const sessionContext = await getCurrentSessionContext(process.cwd());

            if (sessionContext?.sessionId) {
              name = sessionContext.sessionId;
              autoDetectedSession = true;
              if (!options?.json) {
                console.log(`Auto-detected session: ${name}`);
              }
            }
          } catch (error) {
            // Just log the error but continue - the domain function will handle missing session
            console.error(
              "Error auto-detecting session",
              error instanceof Error ? error.message : String(error)
            );
          }
        }

        // Convert CLI options to domain parameters
        const params: SessionUpdateParams = {
          name: name || "", // Provide default empty string
          json: options?.json,
          noStash: false, // Default values for required properties
          noPush: false, // Default values for required properties
          branch: "main", // Default value
          remote: "origin", // Default value
        };

        // Call the domain function
        const result = await updateSessionFromParams(params);

        // Output result
        if (options?.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result) {
          console.log(`Session '${result.session}' updated successfully.`);
          console.log(`Merged from main to ${result.branch}`);
          console.log(`Status: Success`);
        } else {
          console.log("Session update failed or no result returned.");
        }
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error}`);
        }
        process.exit(1);
      }
    });
}

/**
 * Creates the session approve command
 */
export function createApproveCommand(): Command {
  return new Command("approve")
    .description("Approve a session's PR and merge it into the main branch")
    .argument("[name]", "Session name")
    .option("--task <taskId>", "Task ID to match")
    .option("--repo <path>", "Repository path")
    .option("--json", "Output as JSON")
    .action(async (name?: string, options?: { task?: string; repo?: string; json?: boolean }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionApproveParams = {
          session: name,
          task: options?.task,
          repo: options?.repo,
          json: options?.json,
        };

        // Call the domain function
        const result = await approveSessionFromParams(params);

        // Output result
        if (options?.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Session '${result.session}' PR was successfully approved and merged.`);
          console.log(`Merge commit: ${result.commitHash}`);
          console.log(`Merged by: ${result.mergedBy}`);
          console.log(`Merged on: ${result.mergeDate}`);
          console.log(`Base branch: ${result.baseBranch}`);
          console.log(`PR branch: ${result.prBranch}`);
          if (result.taskId) {
            console.log(`Task ID: ${result.taskId} (status set to DONE)`);
          }
        }
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        } else {
          console.error(
            `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
          );
          process.exit(1);
        }
      }
    });
}

/**
 * Creates the main session command with all subcommands
 * Accepts an optional getCurrentSession function for testing
 */
export function createSessionCommand(config?: GetCurrentSessionConfig): Command {
  const sessionCommand = new Command("session").description("Session management operations");

  sessionCommand.addCommand(createListCommand());
  sessionCommand.addCommand(createGetCommand());
  sessionCommand.addCommand(createStartCommand());
  sessionCommand.addCommand(createDirCommand());
  sessionCommand.addCommand(createDeleteCommand());
  sessionCommand.addCommand(createUpdateCommand());
  sessionCommand.addCommand(createApproveCommand());

  return sessionCommand;
}
