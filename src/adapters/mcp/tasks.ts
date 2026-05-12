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
        description:
          "List active tasks (TODO/PLANNING/READY/IN-PROGRESS/IN-REVIEW). " +
          "Default: up to 50 tasks; pass `limit` to override. Pass " +
          "`all: true` to include DONE/CLOSED history — when `all: true` is " +
          "set the default limit is lifted so the full history is returned. " +
          "Use `status` to filter to a single status.",
        // mt#1786: MCP-only defaults. The full active-task list is ~440 rows
        // and ~84KB serialized — too large for a default tool response in a
        // fresh Claude Desktop / Claude Code session. The CLI's default
        // behavior is intentionally unchanged (the field is only consumed by
        // the MCP adapter); CLI users page via the terminal.
        //
        // PR R2: the limit default is conditional on `all`. When the caller
        // passes `all: true`, they have explicitly opted into the historical
        // full-history view (spec criterion #2), so the limit default is
        // skipped and the call returns all matching tasks. Callers who want
        // both `all: true` AND a cap can still pass `limit: N` explicitly.
        argDefaults: {
          limit: (args: Record<string, unknown>) => (args.all === true ? undefined : 50),
        },
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
