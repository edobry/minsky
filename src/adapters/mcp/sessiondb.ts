/**
 * MCP adapter for sessiondb commands
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerSessiondbCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers sessiondb tools with the MCP command mapper
 */
export function registerSessiondbTools(commandMapper: CommandMapper): void {
  log.debug("Registering sessiondb commands via shared command integration");

  // Use the bridge integration to automatically register all sessiondb commands
  registerSessiondbCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "sessiondb.search": {
        description:
          "Search sessions by query string across multiple fields (returns raw SessionRecord objects from database)",
      },
      "sessiondb.migrate": {
        description: "Migrate session database between backends",
      },
      "sessiondb.check": {
        description: "Check database integrity and detect issues",
      },
    },
  });

  log.debug("SessionDB commands registered successfully via shared integration");
}
