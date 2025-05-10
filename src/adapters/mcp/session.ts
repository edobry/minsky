/**
 * MCP adapter for session commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";

// Import domain functions
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
  commandMapper.addSessionCommand("list", "List all sessions", z.object({}), async (args) => {
    const params = {
      ...args,
      json: true, // Always use JSON format for MCP
    };

    return await listSessionsFromParams(params);
  });

  // Session get command
  commandMapper.addSessionCommand(
    "get",
    "Get a specific session by name or task ID",
    z.object({
      name: z.string().optional().describe("Name of the session to retrieve"),
      task: z.string().optional().describe("Task ID associated with the session"),
    }),
    async (args) => {
      const params = {
        ...args,
        json: true, // Always use JSON format for MCP
      };

      const session = await getSessionFromParams(params);

      if (!session) {
        throw new Error(`Session not found.`);
      }

      return session;
    }
  );

  // Session start command
  commandMapper.addSessionCommand(
    "start",
    "Start a new session",
    z.object({
      name: z.string().optional().describe("Name for the new session"),
      task: z.string().optional().describe("Task ID to associate with the session"),
      repo: z.string().optional().describe("Repository to start the session in"),
      branch: z.string().optional().describe("Branch name to create"),
      quiet: z.boolean().optional().describe("Suppress output").default(true),
    }),
    async (args) => {
      // Always set quiet to true as required by project rules
      const params = {
        ...args,
        quiet: true,
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
      task: z.string().optional().describe("Task ID to delete session for"),
      force: z.boolean().optional().describe("Skip confirmation prompt"),
    }),
    async (args) => {
      const params = {
        ...args,
        json: true,
      };

      const deleted = await deleteSessionFromParams(params);

      // Format response for MCP
      return {
        success: deleted,
        message: deleted
          ? `Session ${args.name || `for task ${args.task}`} deleted successfully.`
          : `Session ${args.name || `for task ${args.task}`} could not be deleted.`,
      };
    }
  );

  // Session dir command
  commandMapper.addSessionCommand(
    "dir",
    "Get the directory path for a session",
    z.object({
      name: z.string().optional().describe("Name of the session"),
      task: z.string().optional().describe("Task ID associated with the session"),
    }),
    async (args) => {
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
      branch: z.string().optional().describe("Branch to merge from (defaults to main)"),
      remote: z.string().optional().describe("Remote name to pull from (defaults to origin)"),
      noStash: z.boolean().optional().describe("Skip stashing local changes"),
      noPush: z.boolean().optional().describe("Skip pushing changes to remote after update"),
    }),
    async (args) => {
      const params = {
        ...args,
      };

      await updateSessionFromParams(params);

      // Format response for MCP
      return {
        success: true,
        message: `Session ${args.name} updated successfully.`,
      };
    }
  );
}
