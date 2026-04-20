/**
 * Shared MCP Commands
 *
 * Registers all MCP-related commands in the shared command registry.
 */

import { registerMcpRegisterCommand } from "./register-command";

export function registerMcpCommands(): void {
  registerMcpRegisterCommand();
}

export { registerMcpRegisterCommand };
