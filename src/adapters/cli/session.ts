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
  sessionPrFromParams,
} from "../../domain/index.js";
import { handleCliError, outputResult } from "./utils/index.js";

interface GetCurrentSessionConfig {
  getCurrentSession: () => Promise<string | null>;
}

/**
 * Creates the session list command
 */
export function createListCommand(): Command {
  return new Command("list")
    .description("List available sessions")
    .option("--repo <repositoryUri>", "Repository URI")
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

        // Output result using the utility function
        outputResult(sessions, {
          json: options?.json,
          formatter: (formattedSessions: any[]) => {
            if (formattedSessions.length === 0) {
              console.log("No sessions found.");
              return;
            }
            console.log("Sessions:");
            formattedSessions.forEach((session: any) => {
              console.log(`- ${session.session}: ${session.branch}`);
            });
          },
        });
      } catch (error) {
        handleCliError(error);
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
        const session = await getSessionFromParams(params);

        // Format output using the utility function
        outputResult(session, {
          json: options?.json,
          formatter: (formattedSession: any) => {
            console.log(`Session: ${formattedSession.session}`);
            console.log(`Branch: ${formattedSession.branch}`);
            if (formattedSession.taskId) {
              console.log(`Task: ${formattedSession.taskId}`);
            }
          },
        });
      } catch (error) {
        handleCliError(error);
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
      .option("--repo <repositoryUri>", "Repository URI")
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
              const { SessionDB } = await import("../../domain/session.js");
              const sessionDB = new SessionDB();
              const repoPath = await sessionDB.getRepoPath(result as any);
              console.log(repoPath);
            } else {
              console.log(`Session '${result.session}' created successfully.`);
              const { SessionDB } = await import("../../domain/session.js");
              const sessionDB = new SessionDB();
              console.log(`Session directory: ${await sessionDB.getRepoPath(result as any)}`);
              console.log(`Branch: ${result.branch}`);

              // Output backend-specific information if applicable
              if ((result as any).backendType) {
                console.log(`Backend type: ${(result as any).backendType}`);
              }
            }
          } catch (error) {
            handleCliError(error);
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

        // Output result
        console.log(result);
      } catch (error) {
        handleCliError(error);
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
    .option("--repo <repositoryUri>", "Repository URI")
    .option("--force", "Force deletion even if session has uncommitted changes")
    .action(async (name?: string, options?: { task?: string; repo?: string; force?: boolean }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionDeleteParams = {
          name: name || "", // Ensure this is a string even if undefined
          task: options?.task,
          repo: options?.repo,
          force: options?.force || false,
        };

        // Call the domain function
        const deleted = await deleteSessionFromParams(params);

        // Output result
        console.log(`Session deleted successfully.`);
      } catch (error) {
        handleCliError(error);
      }
    });
}

/**
 * Creates the session update command
 */
export function createUpdateCommand(): Command {
  return new Command("update")
    .description("Update session with latest changes from upstream branch")
    .argument("[name]", "Session name")
    .option("--task <taskId>", "Task ID to match")
    .option("--repo <repositoryUri>", "Repository URI")
    .option("--force", "Force update even if the session workspace is dirty")
    .action(async (name?: string, options?: { task?: string; repo?: string; force?: boolean }) => {
      try {
        // Convert CLI options to domain parameters
        const params: SessionUpdateParams = {
          name: name || "", // Ensure this is a string even if undefined
          task: options?.task,
          repo: options?.repo,
          force: options?.force || false,
        };

        // Call the domain function
        const updateResult = await updateSessionFromParams(params);

        // Output result
        if (updateResult) {
          console.log(`Session ${updateResult.session} updated successfully.`);
          console.log(`Branch: ${updateResult.branch}`);
          if ((updateResult as any).task) {
            console.log(`Associated with task: ${(updateResult as any).task}`);
          }
        } else {
          console.log("Session update failed or no result returned.");
        }
      } catch (error) {
        handleCliError(error);
      }
    });
}

/**
 * Creates the session approve command
 */
export function createApproveCommand(): Command {
  return new Command("approve")
    .description("Approve a session's PR and merge it into the upstream branch")
    .argument("[name]", "Session name")
    .option("--task <taskId>", "Task ID to match")
    .option("--repo <repositoryUri>", "Repository URI")
    .option("--task-status <status>", "Task status to set after merge (default: DONE)")
    .option("--yes", "Automatically confirm all prompts")
    .option("--no-cleanup", "Don't cleanup the session after merging")
    .option("--no-push", "Don't push changes to the remote repository")
    .option("--no-status-update", "Don't update the task status")
    .option("--title <title>", "Title for the merge commit")
    .option(
      "--message <message>",
      "Message for the merge commit (will be combined with title if provided)"
    )
    .action(
      async (
        name?: string,
        options?: {
          task?: string;
          repo?: string;
          taskStatus?: string;
          yes?: boolean;
          cleanup?: boolean;
          push?: boolean;
          statusUpdate?: boolean;
          title?: string;
          message?: string;
        }
      ) => {
        try {
          // Build a proper merge message from title and message if provided
          let mergeMessage: string | undefined;
          if (options?.title || options?.message) {
            mergeMessage = [options.title, options.message].filter(Boolean).join("\n\n");
          }

          // Convert CLI options to domain parameters
          const params: SessionApproveParams = {
            name, // API should handle the optional name
            task: options?.task,
            repo: options?.repo,
            taskStatus: options?.taskStatus,
            autoConfirm: options?.yes || false,
            cleanup: options?.cleanup !== false,
            push: options?.push !== false,
            updateTaskStatus: options?.statusUpdate !== false,
            mergeMessage,
          };

          // Call the domain function with the parameters
          const result = await approveSessionFromParams(params);

          // Output result
          console.log(`Session ${result.session} approved and merged successfully.`);
          console.log(`Merged into: ${result.baseBranch}`);
          console.log(`Merge commit: ${result.commitHash}`);
        } catch (error) {
          handleCliError(error);
        }
      }
    );
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
    .option("--base-branch <branch>", "Base branch for PR (defaults to upstream branch)")
    .option("--debug", "Enable debug output")
    .option("--no-status-update", "Don't update the task status")
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
          const params = {
            session: name,
            task: options?.task,
            title: options?.title,
            body: options?.body,
            baseBranch: options?.baseBranch,
            debug: options?.debug || false,
            noStatusUpdate: !(options?.statusUpdate !== false), // Convert to the required format
          };

          // Call the domain function
          const result = await sessionPrFromParams(params);

          // Generate a PR description from the result
          const prDescription = `# Pull Request: ${result.title || `Merge ${result.prBranch} into ${result.baseBranch}`}

${result.body || ""}

## Base Branch: ${result.baseBranch}
## PR Branch: ${result.prBranch}`;

          // Output the PR description
          console.log(prDescription);
        } catch (error) {
          handleCliError(error);
        }
      }
    );
}

/**
 * Creates the session command
 */
export function createSessionCommand(config?: GetCurrentSessionConfig): Command {
  const sessionCommand = new Command("session").description("Session management operations");

  // Add all the session subcommands
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
