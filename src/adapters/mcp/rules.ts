/**
 * MCP adapter for rules commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerRulesCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers rules tools with the MCP command mapper
 */
export function registerRulesTools(commandMapper: CommandMapper): void {
  log.debug("Registering rules commands via shared command integration");

  // Use the bridge integration to automatically register all rules commands
  registerRulesCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "rules.list": {
        description: "List all rules in the workspace",
      },
      "rules.get": {
        description: "Get a specific rule by ID",
      },
      "rules.create": {
        description: "Create a new rule",
      },
      "rules.update": {
        description: "Update an existing rule",
      },
      "rules.search": {
        description: "Search for rules by content or metadata",
      },
    },
  });

  log.debug("Rules commands registered successfully via shared integration");
}
