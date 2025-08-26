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
export function registerTaskTools(commandMapper: CommandMapper): void {
  log.debug(
    "Exposing task commands via shared command integration (commands already registered during CLI init)"
  );

  // Register new task-specific editing tools (tasks.edit_file, tasks.search_replace)
  registerTaskEditTools(commandMapper);

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
      "tasks.edit": {
        description: "Edit task title and/or specification content with basic operations. Supports: title updates, complete spec replacement from content or file. For advanced editing with patterns, use tasks.spec.edit instead.",
      },
      "tasks.spec.edit": {
        description: "Edit task specification using familiar file editing patterns. Works exactly like session.edit_file but operates on task specs in-memory with backend delegation. Use '// ... existing code ...' markers for precise edits.",
      },
      "tasks.spec.search_replace": {
        description: "Replace a single occurrence of text in a task specification. Works exactly like session.search_replace but operates on task specs in-memory with backend delegation.",
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
