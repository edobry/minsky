/**
 * MCP adapter for config commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerConfigCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers config tools with the MCP command mapper
 */
export function registerConfigTools(commandMapper: CommandMapper): void {
  log.debug("Registering config commands via shared command integration");

  // Use the bridge integration to automatically register all config commands
  registerConfigCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "config.list": {
        description: "Show all configuration from all sources",
      },
      "config.show": {
        description: "Show the final resolved configuration",
      },
    },
  });

  log.debug("Config commands registered successfully via shared integration");
}
