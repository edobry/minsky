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
 * Parse a --child-args option value into an array of argument strings.
 *
 * Accepted forms (in order of preference):
 *
 *   1. JSON array  (preferred)  — `--child-args '["mcp","start"]'`
 *      Supports arbitrary argument values including commas and spaces.
 *
 *   2. Comma-separated string  (legacy / deprecated) — `--child-args "mcp,start"`
 *      Cannot represent args that contain commas. Emits a deprecation warning
 *      to stderr when used so operators know to migrate to JSON form.
 *
 * @param val - Raw string value from the CLI option.
 * @returns Parsed argument array.
 */
function parseChildArgs(val: string): string[] {
  const trimmed = val.trim();

  // Try JSON-array form first.
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed as string[];
      }
      // Valid JSON but not a string array — fall through to comma-split.
      process.stderr.write(
        "[proxy-cli] WARNING: --child-args JSON value is not a string array; " +
          'falling back to comma-split. Example of correct form: \'["mcp","start"]\'\n'
      );
    } catch {
      // JSON.parse failed — fall through to comma-split.
      process.stderr.write(
        "[proxy-cli] WARNING: --child-args value starts with '[' but is not valid JSON; " +
          'falling back to comma-split. Example of correct form: \'["mcp","start"]\'\n'
      );
    }
  }

  // Comma-split fallback. Emit a deprecation notice when multiple segments are
  // present (single-arg values are unambiguous and need no warning).
  const parts = val.split(",").map((s) => s.trim());
  if (parts.length > 1) {
    const jsonEquiv = `'["${parts.join('","')}"]'`;
    process.stderr.write(
      `[proxy-cli] DEPRECATION: comma-separated --child-args is deprecated. ` +
        `Use JSON-array form instead: --child-args ${jsonEquiv}\n`
    );
  }
  return parts;
}

/**
 * Create the `mcp proxy` subcommand.
 *
 * Usage:
 *   minsky mcp proxy
 *   minsky mcp proxy --child-command minsky --child-args '["mcp","start"]'
 *   minsky mcp proxy --child-command minsky --child-args mcp,start   (deprecated)
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
      "Arguments for the inner MCP server as a JSON array (preferred) or " +
        "comma-separated string (deprecated). " +
        'JSON form: --child-args \'["mcp","start"]\'. ' +
        'Default when --child-command is provided: ["mcp","start"].',
      parseChildArgs
    )
    .action(async (options: { childCommand?: string; childArgs?: string[] }) => {
      try {
        // When --child-command is provided without --child-args, default to
        // ["mcp", "start"] — the standard inner-server invocation. Previously
        // this defaulted to [] (no args), which would invoke most CLIs without
        // the subcommand they require (NON-BLOCKING 1, PR #1039 R1).
        const childArgs =
          options.childArgs ?? (options.childCommand !== undefined ? ["mcp", "start"] : undefined);

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
