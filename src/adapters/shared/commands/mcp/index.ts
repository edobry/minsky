/**
 * Shared MCP Commands
 *
 * Registers all MCP-related commands in the shared command registry.
 */

import { registerMcpRegisterCommand } from "./register-command";
import { registerMcpStatusCommand, registerMcpRestartCommand } from "./control-commands";

export function registerMcpCommands(): void {
  registerMcpRegisterCommand();
  // mt#4466: the daemon's non-GUI control surface. Registering here is what
  // gives it BOTH `minsky mcp status`/`restart` and the `mcp_status`/
  // `mcp_restart` MCP tools from one definition.
  registerMcpStatusCommand();
  registerMcpRestartCommand();
}

export { registerMcpRegisterCommand, registerMcpStatusCommand, registerMcpRestartCommand };
