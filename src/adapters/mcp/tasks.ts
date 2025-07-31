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
  log.debug(
    "Exposing task commands via shared command integration (commands already registered during CLI init)"
  );

  // Use the bridge integration to expose already-registered task commands
  // Note: Shared commands are already registered during CLI initialization,
  // so we just need to expose them via MCP without re-registering
  registerTaskCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "tasks.list": {
        description: "List all tasks in the current repository",
      },
      "tasks.get": {
        description: "Get a specific task by ID",
      },
      "tasks.create": {
        description: "Create a new task",
      },
      "tasks.spec": {
        description: "Get the specification for a task",
      },
      "tasks.status.get": {
        description: "Get the status of a task",
      },
      "tasks.status.set": {
        description: "Set the status of a task",
      },
    },
  });

  log.debug("Task commands exposed successfully via shared integration");
}
