/**
 * MCP adapter for task commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerTaskCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";
import { z } from "zod";

/**
 * Registers task tools with the MCP command mapper
 */
export function registerTaskTools(commandMapper: CommandMapper): void {
  log.debug("Registering task commands via direct MCP implementation (temporary fix)");

  // Temporary direct implementation to avoid shared command integration issues
  commandMapper.addCommand({
    name: "tasks.create",
    description: "Create a new task",
    parameters: z.object({
      title: z.string(),
      description: z.string().optional(),
      force: z.boolean().default(false),
      backend: z.string().optional(),
      repo: z.string().optional(),
      workspace: z.string().optional(),
      session: z.string().optional(),
    }),
    handler: async (args: any) => {
      // Simple synchronous response to avoid any async hanging issues
      return {
        success: true,
        message: "Task creation temporarily disabled via MCP - use CLI instead",
        args: args,
        interface: "mcp",
      };
    },
  });

  commandMapper.addCommand({
    name: "tasks.list",
    description: "List all tasks in the current repository",
    parameters: z.object({
      all: z.boolean().default(false),
      status: z.string().optional(),
      filter: z.string().optional(),
      limit: z.number().optional(),
      backend: z.string().optional(),
      repo: z.string().optional(),
      workspace: z.string().optional(),
      session: z.string().optional(),
    }),
    handler: async (args: any) => {
      return {
        success: true,
        message: "Task listing temporarily disabled via MCP - use CLI instead",
        args: args,
        interface: "mcp",
      };
    },
  });

  log.debug("Task commands registered successfully via direct implementation");
}
