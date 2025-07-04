/**
 * MCP adapter for session commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";

// Import centralized descriptions
import {
  SESSION_DESCRIPTION,
  REPO_DESCRIPTION,
  TASK_ID_DESCRIPTION,
  GIT_BRANCH_DESCRIPTION,
  SESSION_QUIET_DESCRIPTION,
  FORCE_DESCRIPTION,
  GIT_REMOTE_DESCRIPTION,
} from "../../utils/option-descriptions.js";

// Import domain functions from domain/index.js as required by linter

import {
  listSessionsFromParams,
  getSessionFromParams,
  startSessionFromParams,
  deleteSessionFromParams,
  getSessionDirFromParams,
  updateSessionFromParams,
  createSessionProvider,
} from "../../domain/index.js";

/**
 * Registers session tools with the MCP command mapper
 */
export function registerSessionTools(commandMapper: CommandMapper): void {
  // Session list command
  (commandMapper as any).addSessionCommand(
    "list",
    "List all sessions",
    z.object({}),
    async (args): Promise<Record<string, unknown>> => {
      const params = {
        ...args,
        json: true, // Always use JSON format for MCP
      };

      const sessions = await listSessionsFromParams(params as any);
      // Return sessions as a record
      return { sessions };
    }
  );

  // Session get command
  (commandMapper as any).addSessionCommand(
    "get",
    "Get a specific session by name or task ID",
    z.object({
      name: z.string().optional().describe("Name of the session to retrieve"),
      task: z.string().optional().describe(TASK_ID_DESCRIPTION),
    }),
    async (args): Promise<Record<string, unknown>> => {
      const params = {
        ...args,
        json: true, // Always use JSON format for MCP
      };

      const session = await getSessionFromParams(params as any);

      if (!session) {
        throw new Error(`
🔍 Session Not Found

Unable to find a session with the provided criteria.

What you tried:
${(args as any).name ? `• Session name: "${(args as any).name}"` : ""}
${args.task ? `• Task ID: "${args.task}"` : ""}

💡 How to fix this:

📋 List all available sessions:
   minsky sessions list

🔍 Check specific session:
   minsky sessions get --name "session-name"

🆕 Create a new session:
   minsky session start new-session-name

🎯 Find session by task:
   minsky sessions list | grep "#123"  (replace 123 with your task ID)

🔗 Link task to session:
   minsky session start --task "123"

Need help? Run: minsky sessions --help
`);
      }

      // Convert session to Record<string, unknown> safely
      return { ...session } as Record<string, unknown>;
    }
  );

  // Session start command
  (commandMapper as any).addSessionCommand(
    "start",
    "Start a new session",
    z.object({
      name: z.string().optional().describe("Name for the new session"),
      task: z.string().optional().describe(TASK_ID_DESCRIPTION),
      description: z.string().optional().describe("Description for auto-created task"),
      repo: z.string().optional().describe(REPO_DESCRIPTION),
      branch: z.string().optional().describe(GIT_BRANCH_DESCRIPTION),
      quiet: (z.boolean().optional().describe(SESSION_QUIET_DESCRIPTION) as any).default(true),
    }),
    async (args): Promise<Record<string, unknown>> => {
      // Validate that either task or description is provided
      if (!args.task && !(args as any).description) {
        throw new Error(`
🚫 Task Association Required

To start a session, you must provide either:

🎯 Associate with existing task:
   --task "123"

📝 Create new task automatically:
   --description "Brief description of the work"

Examples:
   minsky session start --task "123"
   minsky session start --description "Fix login issue" --name "my-session"

💡 Task association is required for proper tracking and project management.
`);
      }

      // Always set quiet to true as required by project rules
      const params = {
        ...args,
        quiet: true,
        noStatusUpdate: false, // Default value for required parameter
        skipInstall: false, // Default value for required parameter
      };

      const session = await startSessionFromParams(params as any);

      // Get the repo path using the session provider
      const sessionProvider = createSessionProvider();
      const sessionRecord = await (sessionProvider as any).getSession((session as any).session);
      const repoPath = sessionRecord ? await (sessionProvider as any).getRepoPath(sessionRecord) : undefined;

      // Format response for MCP
      return {
        success: true,
        session: (session as any).session,
        directory: repoPath,
        taskId: (session as any).taskId,
        repoName: (session as any).repoName,
      };
    }
  );

  // Session delete command
  (commandMapper as any).addSessionCommand(
    "delete",
    "Delete a session",
    z.object({
      name: z.string().optional().describe("Name of the session to delete"),
      task: z.string().optional().describe(TASK_ID_DESCRIPTION),
      force: (z.boolean().optional() as any).describe(FORCE_DESCRIPTION),
    }),
    async (args): Promise<Record<string, unknown>> => {
      // Must provide either name or task
      if (!(args as any).name && !args.task) {
        throw new Error(`
🚫 Missing Required Information

To delete a session, you need to specify which session to target.

Please provide one of:

📝 Session name:
   minsky session delete --name "my-session"

🎯 Task ID:
   minsky session delete --task "123"

💡 Need to find your session?

📋 List all sessions:
   minsky sessions list

🔍 Show session details:
   minsky sessions get --name "session-name"

Example commands:
   minsky session delete --name "feature-branch"
   minsky session delete --task "42"
`);
      }

      // Special handling for task-based deletion
      if (args.task && !(args as any).name) {
        // Find the session by task ID first using getSessionFromParams
        const taskParams = {
          task: args.task,
          json: true,
        };

        const session = await getSessionFromParams(taskParams);
        if (!session) {
          throw new Error(`No session found for task ${args.task}`);
        }

        // Now we can delete with the session name
        const deleteParams = {
          name: (session as any).session,
          force: args.force || false,
          json: true,
        };

        const deleted = await deleteSessionFromParams(deleteParams);
        return {
          success: deleted,
          message: deleted
            ? `Session for task ${args.task} deleted successfully.`
            : `Session for task ${args.task} could not be deleted.`,
        };
      }

      // Regular name-based deletion
      const deleteParams = {
        name: (args as any).name as string, // We've verified it exists above
        force: args.force || false,
        json: true,
      };

      const deleted = await deleteSessionFromParams(deleteParams);
      return {
        success: deleted,
        message: deleted
          ? `Session ${(args as any).name} deleted successfully.`
          : `Session ${(args as any).name} could not be deleted.`,
      };
    }
  );

  // Session dir command
  (commandMapper as any).addSessionCommand(
    "dir",
    "Get the directory path for a session",
    z.object({
      name: z.string().optional().describe("Name of the session"),
      task: z.string().optional().describe(TASK_ID_DESCRIPTION),
    }),
    async (args): Promise<Record<string, unknown>> => {
      const params = {
        ...args,
        json: true,
      };

      const dir = await getSessionDirFromParams(params as any);

      // Format response for MCP
      return {
        session: (args as any).name || `task#${(args.task as any).replace(/^#/, "")}`,
        directory: dir,
      };
    }
  );

  // Session update command
  (commandMapper as any).addSessionCommand(
    "update",
    "Update a session with the latest changes from the main branch",
    z.object({
      name: z.string().optional().describe("Name of the session to update"),
      task: z.string().optional().describe(TASK_ID_DESCRIPTION),
      branch: z.string().optional().describe(GIT_BRANCH_DESCRIPTION),
      remote: z.string().optional().describe(GIT_REMOTE_DESCRIPTION),
      noStash: (z.boolean().optional() as any).describe("Skip stashing local changes"),
      noPush: (z.boolean().optional() as any).describe("Skip pushing changes to remote after update"),
      force: (z.boolean().optional() as any).describe(FORCE_DESCRIPTION),
    }),
    async (args): Promise<Record<string, unknown>> => {
      // Must provide either name or task
      if (!(args as any).name && !args.task) {
        throw new Error(`
🚫 Missing Required Information

To update a session, you need to specify which session to update.

Please provide one of:

📝 Session name:
   minsky session update --name "my-session"

🎯 Task ID:
   minsky session update --task "123"

💡 Additional options:

🔧 Update with specific branch:
   minsky session update --name "my-session" --branch "main"

🚀 Skip stashing local changes:
   minsky session update --name "my-session" --no-stash

📋 List available sessions:
   minsky sessions list

Example commands:
   minsky session update --name "feature-branch"
   minsky session update --task "42" --branch "develop"
`);
      }

      const params = {
        ...args,
        noStash: args.noStash || false,
        noPush: args.noPush || false,
        force: args.force || false,
        skipConflictCheck: false,
        autoResolveDeleteConflicts: false,
        dryRun: false,
        skipIfAlreadyMerged: false,
      };

      const updatedSession = await updateSessionFromParams(params as any);

      // Format response for MCP with session details
      return {
        success: true,
        session: (updatedSession as any).session,
        branch: (updatedSession as any).branch,
        taskId: (updatedSession as any).taskId,
        message: `Session ${(updatedSession as any).session} updated successfully.`,
      };
    }
  );
}
