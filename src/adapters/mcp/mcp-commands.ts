/**
 * MCP adapter for MCP management commands (e.g., mcp.register)
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerMcpCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers MCP management tools with the MCP command mapper
 */
export function registerMcpManagementTools(commandMapper: CommandMapper): void {
  log.debug("Registering MCP management commands via shared command integration");

  registerMcpCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "mcp.register": {
        description: "Register Minsky as an MCP server with a supported client",
      },
    },
  });

  log.debug("MCP management commands registered successfully via shared integration");
}
