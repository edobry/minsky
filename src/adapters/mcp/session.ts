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
} from "../../domain/index.js";

/**
 * Registers session tools with the MCP command mapper
 */
export function registerSessionTools(commandMapper: CommandMapper): void {
  // Session list command
  commandMapper.addSessionCommand(
    "list",
    "List all sessions",
    z.object({}),
    async (args): Promise<Record<string, unknown>> => {
      const params = {
        ...args,
        json: true, // Always use JSON format for MCP
      };

      const sessions = await listSessionsFromParams(params);
      // Return sessions as a record
      return { sessions };
    }
  );

  // Session get command
  commandMapper.addSessionCommand(
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

      const session = await getSessionFromParams(params);

      if (!session) {
        throw new Error("Session not found.");
      }

      // Convert session to Record<string, unknown> safely
      return { ...session } as Record<string, unknown>;
    }
  );

  // Session start command
  commandMapper.addSessionCommand(
    "start",
    "Start a new session",
    z.object({
      name: z.string().optional().describe("Name for the new session"),
      task: z.string().optional().describe(TASK_ID_DESCRIPTION),
      repo: z.string().optional().describe(REPO_DESCRIPTION),
      branch: z.string().optional().describe(GIT_BRANCH_DESCRIPTION),
      quiet: z.boolean().optional().describe(SESSION_QUIET_DESCRIPTION).default(true),
    }),
    async (args): Promise<Record<string, unknown>> => {
      // Always set quiet to true as required by project rules
      const params = {
        ...args,
        quiet: true,
        noStatusUpdate: false, // Default value for required parameter
      };

      const session = await startSessionFromParams(params);

      // Format response for MCP
      return {
        success: true,
        session: session.session,
        directory: session.repoPath,
        taskId: session.taskId,
        repoName: session.repoName,
      };
    }
  );

  // Session delete command
  commandMapper.addSessionCommand(
    "delete",
    "Delete a session",
    z.object({
      name: z.string().optional().describe("Name of the session to delete"),
      task: z.string().optional().describe(TASK_ID_DESCRIPTION),
      force: z.boolean().optional().describe(FORCE_DESCRIPTION),
    }),
    async (args): Promise<Record<string, unknown>> => {
      // Must provide either name or task
      if (!args.name && !args.task) {
        throw new Error("Either session name or task ID must be provided");
      }

      // Special handling for task-based deletion
      if (args.task && !args.name) {
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
          name: session.session,
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
        name: args.name as string, // We've verified it exists above
        force: args.force || false,
        json: true,
      };

      const deleted = await deleteSessionFromParams(deleteParams);
      return {
        success: deleted,
        message: deleted
          ? `Session ${args.name} deleted successfully.`
          : `Session ${args.name} could not be deleted.`,
      };
    }
  );

  // Session dir command
  commandMapper.addSessionCommand(
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

      const dir = await getSessionDirFromParams(params);

      // Format response for MCP
      return {
        session: args.name || `task#${args.task?.replace(/^#/, "")}`,
        directory: dir,
      };
    }
  );

  // Session update command
  commandMapper.addSessionCommand(
    "update",
    "Update a session with the latest changes from the main branch",
    z.object({
      name: z.string().describe("Name of the session to update"),
      branch: z.string().optional().describe(GIT_BRANCH_DESCRIPTION),
      remote: z.string().optional().describe(GIT_REMOTE_DESCRIPTION),
      noStash: z.boolean().optional().describe("Skip stashing local changes"),
      noPush: z.boolean().optional().describe("Skip pushing changes to remote after update"),
      force: z.boolean().optional().describe(FORCE_DESCRIPTION),
    }),
    async (args): Promise<Record<string, unknown>> => {
      const params = {
        ...args,
        noStash: args.noStash || false,
        noPush: args.noPush || false,
        force: args.force || false,
      };

      const updatedSession = await updateSessionFromParams(params);

      // Format response for MCP with session details
      return {
        success: true,
        session: updatedSession.session,
        branch: updatedSession.branch,
        taskId: updatedSession.taskId,
        repoPath: updatedSession.repoPath,
        message: `Session ${updatedSession.session} updated successfully.`,
      };
    }
  );
}
