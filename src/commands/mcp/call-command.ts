import { Command } from "commander";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "@minsky/domain/errors/index";
import { exit } from "@minsky/shared/process";
import { callMcpToolDirectly } from "./direct-client";
import { runInspectorCli, type McpInspectorError } from "./inspector-utils";

/**
 * Create the MCP "call" subcommand for calling a specific tool.
 */
export function createCallCommand(): Command {
  const callCommand = new Command("call");
  callCommand.description(
    "Call a specific MCP tool.\n\n" +
      "Argument marshalling: --arg splits on the FIRST '=' only, so a value may itself " +
      "contain '=' characters and is passed through whole. Every value is sent as a STRING, " +
      "so a tool parameter typed as a number or boolean will fail schema validation " +
      "(e.g. --arg 'limit=8' is rejected as \"expected number, received string\"); omit such " +
      "parameters or use a native CLI command instead.\n" +
      "For long or structured content, prefer a native command with real options " +
      "(e.g. 'minsky memory update <id> --content \"$(cat body.md)\"'). Run " +
      "'minsky <noun> --help' to see whether one exists before falling back to 'mcp call'."
  );
  callCommand
    .argument("<tool-name>", "Name of the tool to call")
    .option(
      "--repo <path>",
      "Repository path for operations that require repository context (default: current directory)"
    )
    .option(
      "--arg <key=value>",
      "Tool arguments in key=value format (can be used multiple times). Splits on the first " +
        "'=' only; the value keeps any later '=' characters. Values are always sent as strings.",
      (value: string, previous: string[] = []) => {
        return [...previous, value];
      },
      []
    )
    .option(
      "--timeout <seconds>",
      "Timeout in seconds (default: 10s for most tools, 60s for session operations)",
      (value: string) => parseInt(value, 10)
    )
    .option("--inspector", "Use MCP inspector CLI (legacy, slower)")
    .action(async (toolName: string, options) => {
      try {
        log.cli(`Calling tool: ${toolName}`);

        if (options.inspector) {
          // Use inspector CLI (legacy, known to hang)
          const inspectorArgs = ["--method", "tools/call", "--tool-name", toolName];

          // Add tool arguments
          if (options.arg && options.arg.length > 0) {
            for (const arg of options.arg) {
              inspectorArgs.push("--tool-arg", arg);
            }
          }

          await runInspectorCli(inspectorArgs, {
            repo: options.repo,
          });
        } else {
          // Use direct MCP client (default, faster, more reliable)
          await callMcpToolDirectly(toolName, options.arg || [], {
            repo: options.repo,
            timeout: options.timeout ? options.timeout * 1000 : undefined,
          });
        }
      } catch (error: unknown) {
        // Check if this is an enhanced MCP error
        const err = error as { mcpError?: McpInspectorError };
        if (err.mcpError) {
          const mcpError = err.mcpError;

          // Provide user-friendly error messages based on error type
          switch (mcpError.type) {
            case "validation":
              log.cliError(`❌ ${mcpError.message}`);
              if (mcpError.suggestion) {
                log.cli(`💡 ${mcpError.suggestion}`);
              }
              if (mcpError.missingParam) {
                log.cli(
                  `📋 To see all parameters for ${toolName}, run: minsky mcp inspect --method tools/list`
                );
              }
              break;

            case "timeout":
              log.cliError(`⏱️  ${mcpError.message}`);
              if (mcpError.suggestion) {
                log.cli(`💡 ${mcpError.suggestion}`);
              }
              log.cli(`🚀 Try: minsky mcp call ${toolName} --direct (faster, more reliable)`);
              log.cli(`🔄 Alternative: minsky ${toolName.replace(".", " ")} --json`);
              break;

            case "execution":
              log.cliError(`🚫 ${mcpError.message}`);
              if (mcpError.suggestion) {
                log.cli(`💡 ${mcpError.suggestion}`);
              }
              break;

            default:
              log.cliError(`❌ ${mcpError.message}`);
              if (mcpError.suggestion) {
                log.cli(`💡 ${mcpError.suggestion}`);
              }
          }
        } else {
          // Fallback for non-MCP errors
          log.cliError(`Failed to call tool '${toolName}': ${getErrorMessage(error)}`);
        }
        exit(1);
      }
    });

  return callCommand;
}
