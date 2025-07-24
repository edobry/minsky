/**
 * Shared Session Commands (Simple Direct Registration)
 *
 * This module provides a simple direct approach to registering session commands
 * in the shared command registry, avoiding the complex circular dependency issues.
 */

import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import { z } from "zod";

/**
 * Register session commands directly in the shared command registry
 * This bypasses the complex modular architecture to solve the registration issue
 */
export function registerSessionCommands(): void {
  // Register session list command
  sharedCommandRegistry.registerCommand({
    id: "session.list",
    category: CommandCategory.SESSION,
    name: "list",
    description: "List all available sessions",
    parameters: {
      verbose: {
        schema: z.boolean().optional(),
        description: "Show detailed session information",
        required: false,
      },
    },
    execute: async (params, context) => {
      const { listSessionsFromParams } = await import("../../../domain/session");
      return listSessionsFromParams(params);
    },
  });

  // Register session get command
  sharedCommandRegistry.registerCommand({
    id: "session.get",
    category: CommandCategory.SESSION,
    name: "get",
    description: "Get information about a specific session",
    parameters: {
      session: {
        schema: z.string().optional(),
        description: "Session name or ID",
        required: false,
      },
      task: {
        schema: z.string().optional(),
        description: "Task ID to find session for",
        required: false,
      },
    },
    execute: async (params, context) => {
      const { getSessionFromParams } = await import("../../../domain/session");
      return getSessionFromParams(params);
    },
  });

  // Register session start command
  sharedCommandRegistry.registerCommand({
    id: "session.start",
    category: CommandCategory.SESSION,
    name: "start",
    description: "Start a new session",
    parameters: {
      name: {
        schema: z.string().optional(),
        description: "Session name",
        required: false,
      },
      task: {
        schema: z.string().optional(),
        description: "Task ID to associate with session",
        required: false,
      },
      description: {
        schema: z.string().optional(),
        description: "Description for auto-created task",
        required: false,
      },
    },
    execute: async (params, context) => {
      const { startSessionFromParams } = await import("../../../domain/session");
      return startSessionFromParams(params);
    },
  });

  // Register session delete command
  sharedCommandRegistry.registerCommand({
    id: "session.delete",
    category: CommandCategory.SESSION,
    name: "delete",
    description: "Delete a session",
    parameters: {
      session: {
        schema: z.string().optional(),
        description: "Session name or ID",
        required: false,
      },
      task: {
        schema: z.string().optional(),
        description: "Task ID to find session for",
        required: false,
      },
      force: {
        schema: z.boolean().optional(),
        description: "Force deletion without confirmation",
        required: false,
      },
    },
    execute: async (params, context) => {
      const { deleteSessionFromParams } = await import("../../domain/session");
      return deleteSessionFromParams(params);
    },
  });

  // Register session update command
  sharedCommandRegistry.registerCommand({
    id: "session.update",
    category: CommandCategory.SESSION,
    name: "update",
    description: "Update a session",
    parameters: {
      session: {
        schema: z.string().optional(),
        description: "Session name or ID",
        required: false,
      },
      task: {
        schema: z.string().optional(),
        description: "Task ID to find session for",
        required: false,
      },
      force: {
        schema: z.boolean().optional(),
        description: "Force update even if workspace is dirty",
        required: false,
      },
    },
    execute: async (params, context) => {
      const { updateSessionFromParams } = await import("../../domain/session");
      return updateSessionFromParams(params);
    },
  });

  // Register session approve command
  sharedCommandRegistry.registerCommand({
    id: "session.approve",
    category: CommandCategory.SESSION,
    name: "approve",
    description: "Approve and merge a session",
    parameters: {
      session: {
        schema: z.string().optional(),
        description: "Session name or ID",
        required: false,
      },
      task: {
        schema: z.string().optional(),
        description: "Task ID to find session for",
        required: false,
      },
    },
    execute: async (params, context) => {
      const { approveSessionFromParams } = await import("../../domain/session");
      return approveSessionFromParams(params);
    },
  });

  // Register session pr command
  sharedCommandRegistry.registerCommand({
    id: "session.pr",
    category: CommandCategory.SESSION,
    name: "pr",
    description: "Create a pull request for a session",
    parameters: {
      session: {
        schema: z.string().optional(),
        description: "Session name or ID",
        required: false,
      },
      task: {
        schema: z.string().optional(),
        description: "Task ID to find session for",
        required: false,
      },
      title: {
        schema: z.string().optional(),
        description: "Pull request title",
        required: false,
      },
      body: {
        schema: z.string().optional(),
        description: "Pull request body",
        required: false,
      },
    },
    execute: async (params, context) => {
      const { sessionPrFromParams } = await import("../../domain/session");
      return sessionPrFromParams(params);
    },
  });

  // Register session dir command
  sharedCommandRegistry.registerCommand({
    id: "session.dir",
    category: CommandCategory.SESSION,
    name: "dir",
    description: "Get the directory path for a session",
    parameters: {
      session: {
        schema: z.string().optional(),
        description: "Session name or ID",
        required: false,
      },
      task: {
        schema: z.string().optional(),
        description: "Task ID to find session for",
        required: false,
      },
    },
    execute: async (params, context) => {
      const { getSessionDirFromParams } = await import("../../../domain/session");
      return getSessionDirFromParams(params);
    },
  });

  // Register session inspect command
  sharedCommandRegistry.registerCommand({
    id: "session.inspect",
    category: CommandCategory.SESSION,
    name: "inspect",
    description: "Inspect current session information",
    parameters: {},
    execute: async (params, context) => {
      const { inspectSessionFromParams } = await import("../../../domain/session");
      return inspectSessionFromParams(params);
    },
  });
}
