/**
 * MCP adapter for task commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { registerTaskCommandsWithMcp } from "./shared-command-integration.js";
import { log } from "../../utils/logger.js";

/**
 * Registers task tools with the MCP command mapper
 */
export function registerTaskTools(commandMapper: CommandMapper): void {
  log.debug("Registering task commands via shared command integration");

  // Use the bridge integration to automatically register all task commands
  registerTaskCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      // MCP-specific optimizations
      "tasks.list": {
        description: "List all tasks in the current repository (MCP optimized)",
      },
      "tasks.get": {
        description: "Get a task by ID (MCP optimized)",
      },
      "tasks.create": {
        description: "Create a new task (MCP optimized)",
      },
      "tasks.delete": {
        description: "Delete a task by ID (MCP optimized)",
      },
      "tasks.status.get": {
        description: "Get the status of a task (MCP optimized)",
      },
      "tasks.status.set": {
        description: "Set the status of a task (MCP optimized)",
      },
      "tasks.spec": {
        description: "Get task specification content (MCP optimized)",
      },
    },
  });

  log.debug("Task commands registered successfully via shared integration");
}
