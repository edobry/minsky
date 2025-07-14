/**
 * MCP adapter for debug commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerDebugCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers debug tools with the MCP command mapper
 * These tools are primarily for development and debugging purposes
 */
export function registerDebugTools(commandMapper: CommandMapper): void {
  log.debug("Registering debug commands via shared command integration");

  // Use the bridge integration to automatically register all debug commands
  registerDebugCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      // MCP-specific optimizations
      "debug.listMethods": {
        description: "List all registered MCP methods for debugging (MCP optimized)",
      },
      "debug.echo": {
        description:
          "Echo back the provided parameters for testing MCP communication (MCP optimized)",
      },
      "debug.systemInfo": {
        description: "Get system information about the MCP server (MCP optimized)",
      },
    },
  });

  log.debug("Debug commands registered successfully via shared integration");
}
