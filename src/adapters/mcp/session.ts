/**
 * MCP adapter for session commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerSessionCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers session tools with the MCP command mapper
 */
export function registerSessionTools(commandMapper: CommandMapper): void {
  log.debug("Registering session commands via shared command integration");

  // Use the bridge integration to automatically register all session commands
  registerSessionCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "session.list": {
        description: "List all sessions",
      },
      "session.get": {
        description: "Get a specific session by name or task ID",
      },
      "session.start": {
        description: "Start a new session",
      },
      "session.delete": {
        description: "Delete a session",
      },
      "session.dir": {
        description: "Get the directory path for a session",
      },
      "session.update": {
        description: "Update a session with the latest changes",
      },
      "session.approve": {
        description: "Approve a session pull request",
      },
      "session.pr": {
        description: "Create a pull request for a session",
      },
      "session.inspect": {
        hidden: true, // Hide from MCP - no "current session" context in remote calls
      },
    },
  });

  log.debug("Session commands registered successfully via shared integration");
}
