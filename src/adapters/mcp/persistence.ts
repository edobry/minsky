/**
 * MCP adapter for persistence commands (formerly sessiondb)
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerPersistenceCommandsWithMcp } from "./shared-command-integration";
import { log } from "../../utils/logger";

/**
 * Registers persistence tools with the MCP command mapper
 */
export function registerPersistenceTools(commandMapper: CommandMapper): void {
  log.debug("Registering persistence commands via shared command integration");

  // Use the bridge integration to automatically register all persistence commands
  registerPersistenceCommandsWithMcp(commandMapper, {
    debug: true,
    commandOverrides: {
      "persistence.migrate": {
        description: "Migrate session database between backends",
      },
      "persistence.check": {
        description: "Check database integrity and detect issues",
      },
    },
  });

  log.debug("Persistence commands registered successfully via shared integration");
}

/**
 * Legacy sessiondb tools registration (for backward compatibility)
 */
export function registerSessiondbTools(commandMapper: CommandMapper): void {
  // Forward to persistence tools for backward compatibility
  registerPersistenceTools(commandMapper);
}
