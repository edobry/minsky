import { Command } from "commander";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import { exit } from "../../utils/process";
import { callMcpToolDirectly } from "./direct-client";
import { runInspectorCli, type McpInspectorError } from "./inspector-utils";

/**
 * Create the MCP "call" subcommand for calling a specific tool.
 */
export function createCallCommand(): Command {
  const callCommand = new Command("call");
  callCommand.description("Call a specific MCP tool");
  callCommand
    .argument("<tool-name>", "Name of the tool to call")
    .option(
      "--repo <path>",
      "Repository path for operations that require repository context (default: current directory)"
    )
    .option(
      "--arg <key=value>",
      "Tool arguments in key=value format (can be used multiple times)",
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
