/**
 * CLI subcommand for the Minsky stdio respawn proxy.
 *
 * Registers `minsky mcp proxy` alongside `minsky mcp start`.
 * Zero required args; optional `--child-command` and `--child-args`
 * for future flexibility (default: `minsky mcp start`).
 *
 * @see src/commands/mcp/index.ts — where this command is added
 * @see src/mcp/stdio-proxy/proxy.ts — core proxy implementation
 * @see docs/architecture/stdio-proxy.md — architecture reference
 */

import { Command } from "commander";
import { runProxy } from "./proxy";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import { exit } from "../../utils/process";

/**
 * Create the `mcp proxy` subcommand.
 *
 * Usage:
 *   minsky mcp proxy
 *   minsky mcp proxy --child-command minsky --child-args "mcp,start"
 *
 * Opt-in via ~/.claude/settings.json:
 *   {
 *     "mcpServers": {
 *       "minsky": {
 *         "command": "minsky",
 *         "args": ["mcp", "proxy"]
 *       }
 *     }
 *   }
 */
export function createProxyCommand(): Command {
  const proxyCommand = new Command("proxy");
  proxyCommand.description(
    "Start the Minsky stdio respawn proxy. " +
      "Transparently supervises the inner MCP server, absorbing clean exits from the " +
      "staleness mechanism (mt#1322) and respawning without Claude Code disconnecting. " +
      "Opt-in alternative to 'minsky mcp start' for stable long-running sessions."
  );

  proxyCommand
    .option("--child-command <command>", "Command to run as the inner MCP server (default: minsky)")
    .option(
      "--child-args <args>",
      "Comma-separated arguments for the inner MCP server (default: mcp,start)",
      (val: string) => val.split(",").map((s) => s.trim())
    )
    .action(async (options: { childCommand?: string; childArgs?: string[] }) => {
      try {
        const childArgs = options.childArgs ?? (options.childCommand ? [] : undefined);

        log.debug("[proxy-cli] Starting stdio respawn proxy", {
          childCommand: options.childCommand,
          childArgs,
        });

        await runProxy({
          childCommand: options.childCommand,
          childArgs,
        });
      } catch (error) {
        log.error("[proxy-cli] Proxy exited with error", {
          error: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        exit(1);
      }
    });

  return proxyCommand;
}
