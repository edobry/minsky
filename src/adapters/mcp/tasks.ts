/**
 * MCP adapter for task commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerTaskCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers task tools with the MCP command mapper
 */
export function registerTaskTools(commandMapper: CommandMapper): void {
  log.debug("Registering task commands via shared command integration");

  // Use the bridge integration to automatically register all task commands
  registerTaskCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "tasks.list": {
        description: "List all tasks in the current repository",
      },
      "tasks.get": {
        description: "Get a task by ID",
      },
      "tasks.create": {
        description: "Create a new task",
      },
      "tasks.delete": {
        description: "Delete a task by ID",
      },
      "tasks.status.get": {
        description: "Get the status of a task",
      },
      "tasks.status.set": {
        description: "Set the status of a task",
      },
      "tasks.spec": {
        description: "Get task specification content",
      },
    },
  });

  log.debug("Task commands registered successfully via shared integration");
}
