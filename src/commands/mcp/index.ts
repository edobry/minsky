import { Command } from "commander";
import { createStartCommand } from "./start-command";
import { createToolsCommand } from "./tools-command";
import { createCallCommand } from "./call-command";
import { createInspectCommand } from "./inspect-command";

/**
 * Create the MCP command
 * @returns The MCP command
 */
export function createMCPCommand(): Command {
  const mcpCommand = new Command("mcp");
  mcpCommand.description("Model Context Protocol (MCP) server commands");

  // Add all subcommands
  mcpCommand.addCommand(createStartCommand());
  mcpCommand.addCommand(createToolsCommand());
  mcpCommand.addCommand(createCallCommand());
  mcpCommand.addCommand(createInspectCommand());

  return mcpCommand;
}
