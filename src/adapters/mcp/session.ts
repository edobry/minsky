/**
 * MCP adapter for session commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { registerSessionCommandsWithMcp } from "./shared-command-integration.js";
import { log } from "../../utils/logger.js";

/**
 * Registers session tools with the MCP command mapper
 */
export function registerSessionTools(commandMapper: CommandMapper): void {
  log.debug("Registering session commands via shared command integration");

  // Use the bridge integration to automatically register all session commands
  registerSessionCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      // MCP-specific optimizations
      "session.list": {
        description: "List all sessions (MCP optimized)",
      },
      "session.get": {
        description: "Get a specific session by name or task ID (MCP optimized)",
      },
      "session.start": {
        description: "Start a new session (MCP optimized)",
      },
      "session.delete": {
        description: "Delete a session (MCP optimized)",
      },
      "session.dir": {
        description: "Get the directory path for a session (MCP optimized)",
      },
      "session.update": {
        description: "Update a session with the latest changes (MCP optimized)",
      },
      "session.approve": {
        description: "Approve a session pull request (MCP optimized)",
      },
      "session.pr": {
        description: "Create a pull request for a session (MCP optimized)",
      },
      "session.inspect": {
        description: "Inspect the current session (MCP optimized)",
      },
    },
  });

  log.debug("Session commands registered successfully via shared integration");
}
