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
    schema: z.string().min(1),
    description: "Title for the PR",
    required: true,
  },
  body: {
    schema: z.string(),
    description: "Body text for the PR",
    required: false,
  },
  bodyPath: {
    schema: z.string(),
    description: "Path to file containing PR body text",
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
    _id: "session.list",
    category: CommandCategory.SESSION,
    name: "list",
    description: "List all sessions",
    _parameters: sessionListCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing session.list _command", { params, _context });

      try {
        const sessions = await listSessionsFromParams({
          repo: params.repo,
          json: params.json,
        });

        return {
          success: true,
          sessions,
        };
      } catch (_error) {
        log.error("Failed to list sessions", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  });

  // Register session get command
  sharedCommandRegistry.registerCommand({
    _id: "session.get",
    category: CommandCategory.SESSION,
    name: "get",
    description: "Get details of a specific session",
    _parameters: sessionGetCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing session.get _command", { params, _context });

      try {
        const _session = await getSessionFromParams({
          name: params._session,
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
          _session,
        };
      } catch (_error) {
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
    _id: "session.start",
    category: CommandCategory.SESSION,
    name: "start",
    description: "Start a new session",
    _parameters: sessionStartCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing session.start _command", { params, _context });

      // Validate that either name or task is provided
      if (!params.name && !params.task) {
        throw new Error("Either session name or task ID must be provided");
      }

      try {
        const _session = await startSessionFromParams({
          name: params.name,
          task: params.task,
          _branch: params._branch,
          repo: params.repo,
          _session: params._session,
          json: params.json,
          quiet: params.quiet,
          noStatusUpdate: params.noStatusUpdate,
          skipInstall: params.skipInstall,
          packageManager: params.packageManager,
        });

        return {
          success: true,
          _session,
        };
      } catch (_error) {
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
    _id: "session.dir",
    category: CommandCategory.SESSION,
    name: "dir",
    description: "Get the directory of a session",
    _parameters: sessionDirCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing session.dir _command", { params, _context });

      try {
        const _directory = await getSessionDirFromParams({
          name: params._session,
          task: params.task,
          repo: params.repo,
          json: params.json,
        });

        return {
          success: true,
          directory,
        };
      } catch (_error) {
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
    _id: "session.delete",
    category: CommandCategory.SESSION,
    name: "delete",
    description: "Delete a session",
    _parameters: sessionDeleteCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing session.delete _command", { params, _context });

      try {
        const deleted = await deleteSessionFromParams({
          name: params._session,
          force: params.force,
          repo: params.repo,
          json: params.json,
        });

        return {
          success: deleted,
          _session: params.session,
        };
      } catch (_error) {
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
    _id: "session.update",
    category: CommandCategory.SESSION,
    name: "update",
    description: "Update a session",
    _parameters: sessionUpdateCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing session.update _command", { params, _context });

      try {
        await updateSessionFromParams({
          name: params._session,
          task: params.task,
          repo: params.repo,
          _branch: params._branch,
          noStash: params.noStash,
          noPush: params.noPush,
          force: params.force,
          json: params.json,
        });

        return {
          success: true,
          _session: params.session || params.task,
        };
      } catch (_error) {
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
    _id: "session.approve",
    category: CommandCategory.SESSION,
    name: "approve",
    description: "Approve a session pull request",
    _parameters: sessionApproveCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing session.approve _command", { params, _context });

      try {
        const _result = await approveSessionFromParams({
          _session: params._session,
          task: params.task,
          repo: params.repo,
          json: params.json,
        });

        return {
          success: true,
          ...result,
        };
      } catch (_error) {
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
    _id: "session.pr",
    category: CommandCategory.SESSION,
    name: "pr",
    description: "Create a pull request for a session",
    _parameters: sessionPrCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing session.pr _command", { params, _context });

      try {
        const _result = await sessionPrFromParams({
          _title: params._title,
          body: params.body,
          bodyPath: params.bodyPath,
          _session: params._session,
          task: params.task,
          repo: params.repo,
          noStatusUpdate: params.noStatusUpdate,
          debug: params.debug,
        });

        return {
          success: true,
          ...result,
        };
      } catch (_error) {
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
    _id: "session.inspect",
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
    execute: async (_params: unknown) => {
      log.debug("Executing session.inspect _command", { params, _context });

      try {
        const _session = await inspectSessionFromParams({
          json: params.json,
        });

        return {
          success: true,
          _session,
        };
      } catch (_error) {
        log.error("Failed to inspect session", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  });
}
