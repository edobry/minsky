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
  inspectSessionFromParams,
  sessionReviewFromParams,
} from "../../domain/index.js";
import {
  handleCliError,
  outputResult,
  addRepoOptions,
  addOutputOptions,
  addTaskOptions,
  normalizeSessionParams,
} from "./utils/index.js";

interface GetCurrentSessionConfig {
  getCurrentSession: () => Promise<string | null>;
}

/**
 * Creates the session list command
 */
export function createListCommand(): Command {
  const command = new Command("list").description("List available sessions");

  // Add shared options
  addRepoOptions(command);
  addOutputOptions(command);

  command.action(
    async (options?: {
      repo?: string;
      json?: boolean;
      session?: string;
      "upstream-repo"?: string;
    }) => {
      try {
        // Convert CLI options to domain parameters using normalization helper
        const normalizedParams = normalizeSessionParams(options || {});

        // Convert CLI options to domain parameters
        const params: SessionListParams = {
          ...normalizedParams,
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
              console.log(`- ${session.session}: ${session.branch || "undefined"}`);
            });
          },
        });
      } catch (error) {
        handleCliError(error);
      }
    }
  );

  return command;
}

/**
 * Creates the session get command
 */
export function createGetCommand(): Command {
  const command = new Command("get")
    .description("Get session details")
    .argument("[name]", "Session name");

  // Add shared options
  addOutputOptions(command);
  addTaskOptions(command);

  command.action(async (name?: string, options?: { task?: string; json?: boolean }) => {
    try {
      // Convert CLI options to domain parameters using normalization helper
      const normalizedParams = normalizeSessionParams(options || {});

      // Convert CLI options to domain parameters
      const params: SessionGetParams = {
        ...normalizedParams,
        name,
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

  return command;
}

/**
 * Creates the session start command
 */
export function createStartCommand(): Command {
  const command = new Command("start")
    .description("Start a new session for a task")
    .argument("[name]", "Session name")
    .option("--quiet", "Suppress output and only print the session directory")
    .option("--no-status-update", "Don't update task status to IN-PROGRESS")
    .option("--skip-install", "Skip automatic dependency installation")
    .option(
      "--package-manager <manager>",
      "Override the detected package manager (bun, npm, yarn, pnpm)"
    )
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
    .option("--github-repo <repo>", "GitHub repository name");

  // Add shared options
  addRepoOptions(command);
  addTaskOptions(command);

  command.action(
    async (
      name?: string,
      options?: {
        task?: string;
        repo?: string;
        session?: string;
        "upstream-repo"?: string;
        quiet?: boolean;
        statusUpdate?: boolean;
        skipInstall?: boolean;
        packageManager?: string;
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
        // Convert CLI options to domain parameters using normalization helper
        const normalizedParams = normalizeSessionParams(options || {});

        // Convert CLI options to domain parameters
        const params = {
          ...normalizedParams,
          name,
          quiet: options?.quiet || false,
          noStatusUpdate: options?.statusUpdate === false, // Note the inverted logic
          skipInstall: options?.skipInstall || false,
          packageManager: options?.packageManager as any // will be validated by zod schema
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
        console.log(`Session '${result.session}' created successfully.`);

        // Get the session directory path
        const { createSessionProvider } = await import("../../domain/session.js");
        const sessionDB = createSessionProvider();
        console.log(`Session directory: ${await sessionDB.getSessionWorkdir(result.session)}`);

        console.log(`Branch: ${result.branch}`);

        // If task ID is associated, log it
        if (result.taskId) {
          console.log(`Associated with task: ${result.taskId}`);
        }
      } catch (error) {
        handleCliError(error);
      }
    }
  );

  return command;
}

/**
 * Creates the session dir command
 */
export function createDirCommand(): Command {
  const command = new Command("dir")
    .description("Get the session directory")
    .argument("[name]", "Session name (auto-detected if in a session workspace)");

  // Add shared options
  addTaskOptions(command);

  command.action(async (name?: string, options?: { task?: string }) => {
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

      // Convert CLI options to domain parameters using normalization helper
      const normalizedParams = normalizeSessionParams(options || {});

      // Convert CLI options to domain parameters
      const params: SessionDirParams = {
        ...normalizedParams,
        name,
      };

      // Call the domain function
      const result = await getSessionDirFromParams(params);

      // Output result
      console.log(result);
    } catch (error) {
      handleCliError(error);
    }
  });

  return command;
}

/**
 * Creates the session delete command
 */
export function createDeleteCommand(): Command {
  const command = new Command("delete")
    .description("Delete a session")
    .argument("[name]", "Session name")
    .option("--force", "Force deletion even if session has uncommitted changes");

  // Add shared options
  addRepoOptions(command);
  addTaskOptions(command);

  command.action(
    async (
      name?: string,
      options?: {
        task?: string;
        repo?: string;
        session?: string;
        "upstream-repo"?: string;
        force?: boolean;
      }
    ) => {
      try {
        // Convert CLI options to domain parameters using normalization helper
        const normalizedParams = normalizeSessionParams(options || {});

        // Convert CLI options to domain parameters
        const params: SessionDeleteParams = {
          ...normalizedParams,
          name: name || "", // Ensure this is a string even if undefined
          force: options?.force || false,
        };

        // Call the domain function
        const deleted = await deleteSessionFromParams(params);

        // Output result
        console.log(`Session deleted successfully.`);
      } catch (error) {
        handleCliError(error);
      }
    }
  );

  return command;
}

/**
 * Creates the session update command
 */
export function createUpdateCommand(): Command {
  const command = new Command("update")
    .description("Update session with latest changes from upstream repository")
    .argument("[name]", "Session name")
    .option("--force", "Force update even if the session workspace is dirty");

  // Add shared options
  addRepoOptions(command);
  addTaskOptions(command);

  command.action(
    async (
      name?: string,
      options?: {
        task?: string;
        repo?: string;
        session?: string;
        "upstream-repo"?: string;
        force?: boolean;
        stash?: boolean;
        push?: boolean;
      }
    ) => {
      try {
        // Convert CLI options to domain parameters using normalization helper
        const normalizedParams = normalizeSessionParams(options || {});

        // Convert CLI options to domain parameters
        const params: Partial<SessionUpdateParams> = {
          ...normalizedParams,
          name: name || "", // Ensure this is a string even if undefined
          noStash: options?.force || options?.stash === false,
          noPush: options?.push === false,
        };

        // Call the domain function
        const updatedSession = await updateSessionFromParams(params as SessionUpdateParams);

        // Output result using session information
        if (updatedSession) {
          // If updateSessionFromParams returns a session, use it
          console.log(`Session ${updatedSession.session} updated successfully.`);
          
          if (updatedSession.branch) {
            console.log(`Branch: ${updatedSession.branch}`);
          }
          
          if (updatedSession.taskId) {
            console.log(`Associated with task: ${updatedSession.taskId}`);
          }
          
          if (updatedSession.repoPath) {
            console.log(`Session directory: ${updatedSession.repoPath}`);
          }
        } else {
          // Fall back to fetching the session if updateSessionFromParams returns void
          const session = await getSessionFromParams({ name: name || "" });
          
          if (session) {
            console.log(`Session ${session.session} updated successfully.`);
            if (session.branch) {
              console.log(`Branch: ${session.branch}`);
            }
            if (session.taskId) {
              console.log(`Associated with task: ${session.taskId}`);
            }
          } else {
            console.log("Session update completed, but could not retrieve session details.");
          }
        }
      } catch (error) {
        handleCliError(error);
      }
    }
  );

  return command;
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
          const params = {
            session: name, // API expects 'session' not 'name'
            task: options?.task,
            repo: options?.repo,
            json: false // Add only properties that exist in the schema
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
    .option("--base-branch <branch>", "Base branch for PR (defaults to main)")
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
 * Creates the session inspect command
 */
export function createInspectCommand(): Command {
  const command = new Command("inspect")
    .description("Inspect the current session (auto-detected from workspace)");
  
  // Add shared options
  addOutputOptions(command);
  
  command.action(async (options?: { json?: boolean }) => {
    try {
      // Call the domain function with the CLI options
      const session = await inspectSessionFromParams(options || {});

      // Format output using the utility function
      outputResult(session, {
        json: options?.json,
        formatter: (formattedSession: any) => {
          console.log(`Current Session: ${formattedSession.session}`);
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
  
  return command;
}

/**
 * Creates the session review command
 */
export function createReviewCommand(): Command {
  const command = new Command("review")
    .description("Review a session PR with consolidated view of task, PR description, and changes")
    .argument("[name]", "Session name")
    .option("--task <taskId>", "Task ID to match")
    .option("--output <file>", "Output the review to a file")
    .option("--pr-branch <branch>", "PR branch name (defaults to 'pr/<session>')")
    .option("--repo <path>", "Repository path");

  // Add shared options
  addOutputOptions(command);

  command.action(
    async (
      name?: string,
      options?: {
        task?: string;
        repo?: string;
        output?: string;
        prBranch?: string;
        json?: boolean;
      }
    ) => {
      try {
        // Call the domain function with the parameters
        const result = await sessionReviewFromParams({
          session: name,
          task: options?.task,
          repo: options?.repo,
          output: options?.output,
          prBranch: options?.prBranch,
          json: options?.json,
        });

        // Format and output the result
        if (options?.json) {
          // If JSON output is requested, use the output utility
          outputResult(result, { json: true });
          return;
        }

        // For text output, format it nicely
        const lines: string[] = [];
        
        // Session information
        lines.push(`# Session Review: ${result.session}`);
        lines.push("");
        
        // PR Description
        if (result.prDescription) {
          const titleMatch = result.prDescription.match(/^([^\n]+)/);
          const title = titleMatch ? titleMatch[1] : "No title found";
          
          lines.push(`## PR Information`);
          lines.push("");
          lines.push(`Title: ${title}`);
          lines.push("");
          lines.push(`Branch: ${result.prBranch}`);
          lines.push(`Base: ${result.baseBranch}`);
          lines.push("");
          
          // Extract body by removing the title and any separator lines
          const body = result.prDescription
            .replace(/^[^\n]+\n+/, "") // Remove title line
            .replace(/^-+\s*\n+/m, ""); // Remove separator line if any
          
          if (body.trim()) {
            lines.push(`### Description`);
            lines.push("");
            lines.push(body);
            lines.push("");
          }
        } else {
          lines.push(`## PR Information`);
          lines.push("");
          lines.push(`No PR description found. PR may not have been created yet.`);
          lines.push("");
          lines.push(`Expected branch: ${result.prBranch}`);
          lines.push(`Base branch: ${result.baseBranch}`);
          lines.push("");
        }
        
        // Task Specification
        if (result.taskSpec) {
          lines.push(`## Task Specification`);
          lines.push("");
          lines.push(result.taskSpec);
          lines.push("");
        }
        
        // Diff Statistics
        if (result.diffStats) {
          lines.push(`## Changes`);
          lines.push("");
          lines.push(`Files changed: ${result.diffStats.filesChanged}`);
          if (result.diffStats.insertions) {
            lines.push(`Insertions: ${result.diffStats.insertions}`);
          }
          if (result.diffStats.deletions) {
            lines.push(`Deletions: ${result.diffStats.deletions}`);
          }
          lines.push("");
        }
        
        // Full Diff
        if (result.diff) {
          lines.push(`## Diff`);
          lines.push("```diff");
          lines.push(result.diff);
          lines.push("```");
        }
        
        // Generate output text
        const outputText = lines.join("\n");
        
        // Write to file if output path is provided
        if (options?.output) {
          try {
            const fs = await import("fs/promises");
            await fs.writeFile(options.output, outputText);
            console.log(`Review saved to: ${options.output}`);
          } catch (error) {
            console.error(`Error writing to file: ${error instanceof Error ? error.message : String(error)}`);
            // Still output to console if file write fails
            console.log(outputText);
          }
        } else {
          // Output to console
          console.log(outputText);
        }
      } catch (error) {
        handleCliError(error);
      }
    }
  );

  return command;
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
  sessionCommand.addCommand(createInspectCommand());
  sessionCommand.addCommand(createReviewCommand());

  return sessionCommand;
}
