import { Command } from "commander";
import { createStartCommand } from "./start-command";
import { createToolsCommand } from "./tools-command";
import { createCallCommand } from "./call-command";
import { createInspectCommand } from "./inspect-command";
import { createRegisterCommand } from "./register-command";
import { createStatusCommand, createRestartCommand } from "./control-commands";
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
  // mt#4466: read and restart an ALREADY-RUNNING daemon. Until these, `minsky
  // mcp` could only ever START one, so a wedged daemon was operator-only to
  // recover — a human at the tray's menu bar. They are added HERE rather than
  // reaching the CLI via the shared registry because the MCP category is hidden
  // from auto-generation (see `control-commands.ts`).
  mcpCommand.addCommand(createStatusCommand());
  mcpCommand.addCommand(createRestartCommand());
  // stdio respawn proxy — transparent supervisor for staleness-exit absorption (mt#1714)
  mcpCommand.addCommand(createProxyCommand());

  return mcpCommand;
}
