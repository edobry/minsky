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
  sessionPrFromParams,
} from "../../domain/index.js";

interface GetCurrentSessionConfig {
  getCurrentSession: () => Promise<string | null>;
}

/**
 * Creates the session list command
 */
export function createListCommand(): Command {
  return new Command("list")
    .description("List available sessions")
    .option("--repo <path>", "Repository path")
    .option("--json", "Output sessions as JSON")
    .action(async (options?: { repo?: string; json?: boolean }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionListParams = {
          repo: options?.repo,
          json: options?.json,
        };

        // Call the domain function
        const sessions = await listSessionsFromParams(params);

        // Format and display the results
        if (options?.json) {
          process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
        } else {
          if (sessions.length === 0) {
            console.log("No sessions found.");
            return;
          }
          console.log("Sessions:");
          sessions.forEach((session) => {
            console.log(`- ${session.session}: ${session.branch}`);
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
    .option("--repo <path>", "Repository path")
    .option("--json", "Output session as JSON")
    .action(async (name?: string, options?: { repo?: string; json?: boolean }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionGetParams = {
          name,
          repo: options?.repo,
          json: options?.json,
        };

        // Call the domain function
        const session = await getSessionFromParams(params);

        // Format and display the result
        if (options?.json) {
          process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
        } else {
          console.log(`Session: ${session.session}`);
          console.log(`Branch: ${session.branch}`);
          if (session.taskId) {
            console.log(`Task: ${session.taskId}`);
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
    });
}

/**
 * Creates the session start command
 */
export function createStartCommand(): Command {
  return (
    new Command("start")
      .description("Start a new session")
      .argument("[name]", "Session name")
      .option("--repo <path>", "Repository path")
      .option("--task <taskId>", "Task ID to associate with this session")
      .option("--quiet", "Only output the session directory path")
      // Backend type option
      .option("--backend <type>", "Repository backend type (local, remote, github)")
      // Remote Git specific options
      .option("--repo-url <url>", "Remote repository URL for remote/github backends")
      .option(
        "--auth-method <method>",
        "Authentication method for remote repository (ssh, https, token)"
      )
      .option("--clone-depth <depth>", "Clone depth for remote repositories", (val: string) =>
        parseInt(val, 10)
      )
      // GitHub specific options
      .option("--github-token <token>", "GitHub access token for authentication")
      .option("--github-owner <owner>", "GitHub repository owner/organization")
      .option("--github-repo <repo>", "GitHub repository name")
      .action(
        async (
          name?: string,
          options?: {
            repo?: string;
            task?: string;
            quiet?: boolean;
            backend?: "local" | "remote" | "github";
            repoUrl?: string;
            authMethod?: "ssh" | "https" | "token";
            cloneDepth?: number;
            githubToken?: string;
            githubOwner?: string;
            githubRepo?: string;
          }
        ) => {
          try {
            // Convert CLI options to domain parameters
            const params = {
              name,
              repo: options?.repo,
              task: options?.task,
              quiet: options?.quiet || false,
              noStatusUpdate: false,
            } as SessionStartParams;

            // Add backend-specific parameters if provided
            if (options?.backend) {
              (params as any).backend = options.backend;
            }
            if (options?.repoUrl) {
              (params as any).repoUrl = options.repoUrl;
            }
            if (options?.authMethod) {
              (params as any).authMethod = options.authMethod;
            }
            if (options?.cloneDepth) {
              (params as any).cloneDepth = options.cloneDepth;
            }
            if (options?.githubToken) {
              (params as any).githubToken = options.githubToken;
            }
            if (options?.githubOwner) {
              (params as any).githubOwner = options.githubOwner;
            }
            if (options?.githubRepo) {
              (params as any).githubRepo = options.githubRepo;
            }

            // Call the domain function
            const result = await startSessionFromParams(params);

            // Output result
            if (options?.quiet) {
              // Get the session repo path for the quiet output
              const sessionDB = new (await import("../../domain/session.js")).SessionDB();
              const repoPath = await sessionDB.getRepoPath(result);
              console.log(repoPath);
            } else {
              console.log(`Session '${result.session}' created successfully.`);
              console.log(
                `Session directory: ${await new (await import("../../domain/session.js")).SessionDB().getRepoPath(result)}`
              );
              console.log(`Branch: ${result.branch}`);

              // Output backend-specific information if applicable
              if ((result as any).backendType) {
                console.log(`Backend type: ${(result as any).backendType}`);
              }
            }
          } catch (error) {
            if (error instanceof MinskyError) {
              // Only show the error message without the full JSON or stack trace
              console.error(`Error: ${error.message}`);
            } else {
              console.error(
                `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            process.exit(1);
          }
        }
      )
  );
}

/**
 * Creates the session dir command
 */
export function createDirCommand(): Command {
  return new Command("dir")
    .description("Get session directory")
    .argument("[name]", "Session name")
    .option("--repo <path>", "Repository path")
    .action(async (name?: string, options?: { repo?: string }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionDirParams = {
          name,
          repo: options?.repo,
        };

        // Call the domain function
        const result = await getSessionDirFromParams(params);

        // Output the session directory
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
    .argument("<name>", "Session name")
    .option("--repo <path>", "Repository path")
    .option("--force", "Force deletion even if session has uncommitted changes")
    .action(async (name: string, options?: { repo?: string; force?: boolean }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionDeleteParams = {
          name,
          repo: options?.repo,
          force: options?.force || false,
        };

        // Call the domain function
        await deleteSessionFromParams(params);

        // Output success message
        console.log(`Session '${name}' deleted successfully.`);
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
    .description("Update session metadata")
    .argument("[name]", "Session name")
    .option("--repo <path>", "Repository path")
    .option("--task <taskId>", "Task ID to associate with this session")
    .action(async (name?: string, options?: { repo?: string; task?: string }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionUpdateParams = {
          name,
          repo: options?.repo,
          task: options?.task,
          noStash: false,
          noPush: false,
        };

        // Call the domain function
        const result = await updateSessionFromParams(params);

        // Output success message
        console.log(`Session '${result.session}' updated successfully.`);
        if (result.task) {
          console.log(`Associated with task: ${result.task}`);
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
    .description("Approve a session")
    .argument("[name]", "Session name")
    .option("--repo <path>", "Repository path")
    .option("--no-status-update", "Skip updating task status")
    .action(async (name?: string, options?: { repo?: string; statusUpdate?: boolean }) => {
      try {
        // Convert CLI options to domain parameters
        const params = {
          session: name,
          repo: options?.repo,
          noStatusUpdate: options?.statusUpdate === false,
        };

        // Call the domain function
        const result = await approveSessionFromParams(params);

        // Output success message
        console.log(`Session '${result.session}' approved successfully.`);
        console.log(`Merged branch '${result.branch}' into main.`);
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
 * Creates the session PR command
 */
export function createPrCommand(): Command {
  return new Command("pr")
    .description("Create a PR for a session")
    .argument("[name]", "Session name")
    .option("--task <taskId>", "Task ID to match")
    .option("--title <title>", "PR title (if not provided, will be generated)")
    .option("--body <body>", "PR body (if not provided, will be generated)")
    .option("--base-branch <branch>", "Base branch for PR (defaults to main)")
    .option("--debug", "Enable debug output")
    .option("--no-status-update", "Skip updating task status")
    .action(
      async (
        name?: string,
        options?: {
          task?: string;
          title?: string;
          body?: string;
          baseBranch?: string;
          debug?: boolean;
          statusUpdate?: boolean;
        }
      ) => {
        try {
          // Convert CLI options to domain parameters
          const params = {
            session: name,
            task: options?.task,
            title: options?.title,
            body: options?.body,
            baseBranch: options?.baseBranch,
            debug: options?.debug || false,
            noStatusUpdate: options?.statusUpdate === false,
          };

          // Call the domain function
          const result = await sessionPrFromParams(params);

          // Output result
          console.log(`Created PR branch ${result.prBranch} from base ${result.baseBranch}`);
          console.log("PR branch pushed to origin");
          console.log("PR is ready for review");
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
  sessionCommand.addCommand(createPrCommand());

  return sessionCommand;
}
