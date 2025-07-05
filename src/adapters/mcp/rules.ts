/**
 * MCP adapter for rules commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { registerRulesCommandsWithMcp } from "./shared-command-integration.js";
import { log } from "../../utils/logger.js";

/**
 * Registers rules tools with the MCP command mapper
 */
export function registerRulesTools(commandMapper: CommandMapper): void {
  log.debug("Registering rules commands via shared command integration");

  // Use the bridge integration to automatically register all rules commands
  registerRulesCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      // MCP-specific optimizations
      "rules.list": {
        description: "List all rules in the workspace (MCP optimized)",
      },
      "rules.get": {
        description: "Get a specific rule by ID (MCP optimized)",
      },
      "rules.create": {
        description: "Create a new rule (MCP optimized)",
      },
      "rules.update": {
        description: "Update an existing rule (MCP optimized)",
      },
      "rules.search": {
        description: "Search for rules by content or metadata (MCP optimized)",
      },
    },
  });

  log.debug("Rules commands registered successfully via shared integration");
}
