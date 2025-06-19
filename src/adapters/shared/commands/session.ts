/**
 * Shared Session Commands
 *
 * This module contains shared session command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../shared/command-registry.js";
import {
  getSessionFromParams,
  listSessionsFromParams,
  startSessionFromParams,
  deleteSessionFromParams,
  getSessionDirFromParams,
  updateSessionFromParams,
  approveSessionFromParams,
  sessionPrFromParams,
  inspectSessionFromParams,
} from "../../../domain/session.js";
import { log } from "../../../utils/logger.js";

/**
 * Parameters for the session list command
 */
const sessionListCommandParams: CommandParameterMap = {
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the session get command
 */
const sessionGetCommandParams: CommandParameterMap = {
  session: {
    schema: z.string().min(1),
    description: "Session name",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the session start command
 */
const sessionStartCommandParams: CommandParameterMap = {
  name: {
    schema: z.string().min(1),
    description: "Name for the new session",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID to associate with the session",
    required: false,
  },
  branch: {
    schema: z.string(),
    description: "Branch name to create (defaults to session name)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Deprecated: use name parameter instead",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  quiet: {
    schema: z.boolean(),
    description: "Suppress output except for the session directory path",
    required: false,
    defaultValue: false,
  },
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status when starting a session with a task",
    required: false,
    defaultValue: false,
  },
  skipInstall: {
    schema: z.boolean(),
    description: "Skip automatic dependency installation",
    required: false,
    defaultValue: false,
  },
  packageManager: {
    schema: z.enum(["bun", "npm", "yarn", "pnpm"]),
    description: "Override the detected package manager",
    required: false,
  },
};

/**
 * Parameters for the session dir command
 */
const sessionDirCommandParams: CommandParameterMap = {
  session: {
    schema: z.string().min(1),
    description: "Session name",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the session delete command
 */
const sessionDeleteCommandParams: CommandParameterMap = {
  session: {
    schema: z.string().min(1),
    description: "Session name to delete",
    required: true,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  force: {
    schema: z.boolean(),
    description: "Skip confirmation prompt",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the session update command
 */
const sessionUpdateCommandParams: CommandParameterMap = {
  session: {
    schema: z.string(),
    description: "Session name to update",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  branch: {
    schema: z.string(),
    description: "Update branch name",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  noStash: {
    schema: z.boolean(),
    description: "Skip stashing local changes",
    required: false,
    defaultValue: false,
  },
  noPush: {
    schema: z.boolean(),
    description: "Skip pushing changes to remote after update",
    required: false,
    defaultValue: false,
  },
  force: {
    schema: z.boolean(),
    description: "Force update even if the session workspace is dirty",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the session approve command
 */
const sessionApproveCommandParams: CommandParameterMap = {
  session: {
    schema: z.string(),
    description: "Session name to approve",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the session pr command
 */
const sessionPrCommandParams: CommandParameterMap = {
  title: {
    schema: z.string(),
    description: "Title for the PR",
    required: false,
  },
  body: {
    schema: z.string(),
    description: "Body text for the PR",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session name",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
  },
};

/**
 * Register the session commands in the shared command registry
 */
export function registerSessionCommands(): void {
  // Register session list command
  sharedCommandRegistry.registerCommand({
    id: "session.list",
    category: CommandCategory.SESSION,
    name: "list",
    description: "List all sessions",
    parameters: sessionListCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.list command", { params, context });

      try {
        const sessions = await listSessionsFromParams({
          repo: params.repo,
          json: params.json,
        });

        return {
          success: true,
          sessions,
        };
      } catch (error) {
        log.error("Failed to list sessions", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  });

  // Register session get command
  sharedCommandRegistry.registerCommand({
    id: "session.get",
    category: CommandCategory.SESSION,
    name: "get",
    description: "Get details of a specific session",
    parameters: sessionGetCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.get command", { params, context });

      try {
        const session = await getSessionFromParams({
          name: params.session,
          task: params.task,
          repo: params.repo,
          json: params.json,
        });

        if (!session) {
          const identifier = params.session || `task #${params.task}`;
          throw new Error(`Session '${identifier}' not found`);
        }

        return {
          success: true,
          session,
        };
      } catch (error) {
        log.error("Failed to get session", {
          error: error instanceof Error ? error.message : String(error),
          session: params.session,
          task: params.task,
        });
        throw error;
      }
    },
  });

  // Register session start command
  sharedCommandRegistry.registerCommand({
    id: "session.start",
    category: CommandCategory.SESSION,
    name: "start",
    description: "Start a new session",
    parameters: sessionStartCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.start command", { params, context });

      // Validate that either name or task is provided
      if (!params.name && !params.task) {
        throw new Error("Either session name or task ID must be provided");
      }

      try {
        const session = await startSessionFromParams({
          name: params.name,
          task: params.task,
          branch: params.branch,
          repo: params.repo,
          session: params.session,
          json: params.json,
          quiet: params.quiet,
          noStatusUpdate: params.noStatusUpdate,
          skipInstall: params.skipInstall,
          packageManager: params.packageManager,
        });

        return {
          success: true,
          session,
        };
      } catch (error) {
        log.error("Failed to start session", {
          error: error instanceof Error ? error.message : String(error),
          session: params.name,
          task: params.task,
        });
        throw error;
      }
    },
  });

  // Register session dir command
  sharedCommandRegistry.registerCommand({
    id: "session.dir",
    category: CommandCategory.SESSION,
    name: "dir",
    description: "Get the directory of a session",
    parameters: sessionDirCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.dir command", { params, context });

      try {
        const directory = await getSessionDirFromParams({
          name: params.session,
          task: params.task,
          repo: params.repo,
          json: params.json,
        });

        return {
          success: true,
          directory,
        };
      } catch (error) {
        log.error("Failed to get session directory", {
          error: error instanceof Error ? error.message : String(error),
          session: params.session,
          task: params.task,
        });
        throw error;
      }
    },
  });

  // Register session delete command
  sharedCommandRegistry.registerCommand({
    id: "session.delete",
    category: CommandCategory.SESSION,
    name: "delete",
    description: "Delete a session",
    parameters: sessionDeleteCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.delete command", { params, context });

      try {
        const deleted = await deleteSessionFromParams({
          name: params.session,
          force: params.force,
          repo: params.repo,
          json: params.json,
        });

        return {
          success: deleted,
          session: params.session,
        };
      } catch (error) {
        log.error("Failed to delete session", {
          error: error instanceof Error ? error.message : String(error),
          session: params.session,
        });
        throw error;
      }
    },
  });

  // Register session update command
  sharedCommandRegistry.registerCommand({
    id: "session.update",
    category: CommandCategory.SESSION,
    name: "update",
    description: "Update a session",
    parameters: sessionUpdateCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.update command", { params, context });

      try {
        await updateSessionFromParams({
          name: params.session,
          task: params.task,
          repo: params.repo,
          branch: params.branch,
          noStash: params.noStash,
          noPush: params.noPush,
          force: params.force,
          json: params.json,
        });

        return {
          success: true,
          session: params.session || params.task,
        };
      } catch (error) {
        log.error("Failed to update session", {
          error: error instanceof Error ? error.message : String(error),
          session: params.session,
          task: params.task,
        });
        throw error;
      }
    },
  });

  // Register session approve command
  sharedCommandRegistry.registerCommand({
    id: "session.approve",
    category: CommandCategory.SESSION,
    name: "approve",
    description: "Approve a session pull request",
    parameters: sessionApproveCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.approve command", { params, context });

      try {
        const result = await approveSessionFromParams({
          session: params.session,
          task: params.task,
          repo: params.repo,
          json: params.json,
        });

        return {
          success: true,
          ...result,
        };
      } catch (error) {
        log.error("Failed to approve session", {
          error: error instanceof Error ? error.message : String(error),
          session: params.session,
          task: params.task,
        });
        throw error;
      }
    },
  });

  // Register session pr command
  sharedCommandRegistry.registerCommand({
    id: "session.pr",
    category: CommandCategory.SESSION,
    name: "pr",
    description: "Create a pull request for a session",
    parameters: sessionPrCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.pr command", { params, context });

      try {
        const result = await sessionPrFromParams({
          title: params.title,
          body: params.body,
          session: params.session,
          task: params.task,
          repo: params.repo,
          noStatusUpdate: params.noStatusUpdate,
          debug: params.debug,
        });

        return {
          success: true,
          ...result,
        };
      } catch (error) {
        log.error("Failed to create session PR", {
          error: error instanceof Error ? error.message : String(error),
          session: params.session,
          task: params.task,
        });
        throw error;
      }
    },
  });

  // Register session inspect command
  sharedCommandRegistry.registerCommand({
    id: "session.inspect",
    category: CommandCategory.SESSION,
    name: "inspect",
    description: "Inspect the current session (auto-detected from workspace)",
    parameters: {
      json: {
        schema: z.boolean(),
        description: "Output in JSON format",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.inspect command", { params, context });

      try {
        const session = await inspectSessionFromParams({
          json: params.json,
        });

        return {
          success: true,
          session,
        };
      } catch (error) {
        log.error("Failed to inspect session", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  });
}
