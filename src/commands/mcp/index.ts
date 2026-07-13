import { Command } from "commander";
import { createStartCommand } from "./start-command";
import { createToolsCommand } from "./tools-command";
import { createCallCommand } from "./call-command";
import { createInspectCommand } from "./inspect-command";
import { createRegisterCommand } from "./register-command";
import { createProxyCommand } from "../../mcp/stdio-proxy/cli";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

/**
 * Create the MCP command
 * @returns The MCP command
 */
export function createMCPCommand(container?: AppContainerInterface): Command {
  const mcpCommand = new Command("mcp");
  mcpCommand.description("Model Context Protocol (MCP) server commands");

  // Add all subcommands
  mcpCommand.addCommand(createStartCommand(container));
  mcpCommand.addCommand(createToolsCommand());
  mcpCommand.addCommand(createCallCommand());
  mcpCommand.addCommand(createInspectCommand());
  mcpCommand.addCommand(createRegisterCommand());
  // stdio respawn proxy — transparent supervisor for staleness-exit absorption (mt#1714)
  mcpCommand.addCommand(createProxyCommand());

  return mcpCommand;
}
