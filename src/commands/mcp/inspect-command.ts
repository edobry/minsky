import { Command } from "commander";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import { exit } from "../../utils/process";
import { runInspectorCli } from "./inspector-utils";

/**
 * Create the MCP "inspect" subcommand for general CLI inspection.
 */
export function createInspectCommand(): Command {
  const inspectCommand = new Command("inspect");
  inspectCommand.description("Run MCP inspector CLI with custom method and arguments");
  inspectCommand
    .option(
      "--repo <path>",
      "Repository path for operations that require repository context (default: current directory)"
    )
    .option(
      "--method <method>",
      "MCP method to call (e.g., tools/list, resources/list, prompts/list)"
    )
    .option(
      "--arg <key=value>",
      "Method arguments in key=value format (can be used multiple times)",
      (value: string, previous: string[] = []) => {
        return [...previous, value];
      },
      []
    )
    .option("--tool-name <name>", "Tool name for tools/call method")
    .option(
      "--tool-arg <key=value>",
      "Tool arguments in key=value format (can be used multiple times)",
      (value: string, previous: string[] = []) => {
        return [...previous, value];
      },
      []
    )
    .addHelpText(
      "after",
      `
Examples:
  minsky mcp inspect --method tools/list
  minsky mcp inspect --method resources/list
  minsky mcp inspect --method tools/call --tool-name debug.echo --tool-arg message=test
  minsky mcp inspect --method prompts/list
`
    )
    .action(async (options) => {
      try {
        if (!options.method) {
          log.cliError("Method is required. Use --method to specify what to inspect.");
          log.cli("Common methods: tools/list, tools/call, resources/list, prompts/list");
          exit(1);
        }

        log.cli(`Inspecting MCP server with method: ${options.method}`);

        const inspectorArgs = ["--method", options.method];

        // Add tool-specific arguments for tools/call
        if (options.toolName) {
          inspectorArgs.push("--tool-name", options.toolName);
        }

        if (options.toolArg && options.toolArg.length > 0) {
          for (const arg of options.toolArg) {
            inspectorArgs.push("--tool-arg", arg);
          }
        }

        // Add generic method arguments (for compatibility)
        if (options.arg && options.arg.length > 0) {
          for (const arg of options.arg) {
            const [key, value] = arg.split("=", 2);
            if (value === undefined) {
              log.cliError(`Invalid argument format: ${arg}. Use key=value format.`);
              exit(1);
            }
            inspectorArgs.push(`--${key}`, value);
          }
        }

        await runInspectorCli(inspectorArgs, {
          repo: options.repo,
        });
      } catch (error) {
        log.cliError(`Failed to inspect MCP server: ${getErrorMessage(error)}`);
        exit(1);
      }
    });

  return inspectCommand;
}
