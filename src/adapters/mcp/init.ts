/**
 * MCP adapter for init commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { registerInitCommandsWithMcp } from "./shared-command-integration.js";
import { log } from "../../utils/logger.js";

/**
 * Registers initialization tools with the MCP command mapper
 */
export function registerInitTools(commandMapper: CommandMapper): void {
  log.debug("Registering init commands via shared command integration");

  // Use the bridge integration to automatically register all init commands
  registerInitCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      // MCP-specific optimizations
      init: {
        description: "Initialize a project for Minsky (MCP optimized)",
      },
    },
  });

  log.debug("Init commands registered successfully via shared integration");
}
