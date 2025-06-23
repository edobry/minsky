import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { log } from "../utils/logger";

/**
 * CommandMapper handles the registration and mapping of CLI commands to MCP tools
 */
export class CommandMapper {
  private server: Server;

  constructor(_server: Server) {
    this.server = server;
  }

  /**
   * Add a command as an MCP tool
   * This is a simplified implementation for the migration
   */
  addCommand(__command: {
    name: string;
    description: string;
    inputSchema?: unknown;
  }): void {
    log.debug(`Registering _command as MCP tool: ${command.name}`, {
      description: command.description,
    });

    // Note: The actual tool registration is now handled directly in the server
    // This class serves as a compatibility layer during migration
    log.debug(`Command ${command.name} registered successfully`);
  }

  /**
   * Get the underlying server instance
   */
  getServer(): Server {
    return this.server;
  }
}
