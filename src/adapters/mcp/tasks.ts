/**
 * MCP adapter for task commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerTaskCommandsWithMcp } from "./shared-command-integration";
import { registerTaskEditTools } from "./task-edit-tools";
import { log } from "../../utils/logger";

/**
 * Registers task tools with the MCP command mapper
 */
export function registerTaskTools(
  commandMapper: CommandMapper,
  container?: import("../../composition/types").AppContainerInterface
): void {
  log.debug(
    "Exposing task commands via shared command integration (commands already registered during CLI init)"
  );

  // Register task spec editing tools (tasks.spec.patch, tasks.spec.search_replace)
  registerTaskEditTools(commandMapper, container);

  // Expose shared-registry task commands via MCP
  registerTaskCommandsWithMcp(commandMapper, {
    container,
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
      "tasks.edit": {
        description:
          "Edit task title and/or specification content with basic operations. Supports: title updates, complete spec replacement from content or file. For marker-based patching, use tasks.spec.patch instead.",
      },
      "tasks.spec.get": {
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

  log.debug("Task commands and editing tools registered successfully");
}
