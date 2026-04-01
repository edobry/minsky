import { Command } from "commander";
import { spawn } from "child_process";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import { exit } from "../../utils/process";

/**
 * Create the MCP "tools" subcommand for listing available tools.
 */
export function createToolsCommand(): Command {
  const toolsCommand = new Command("tools");
  toolsCommand.description("List all available MCP tools on the server");
  toolsCommand
    .option(
      "--repo <path>",
      "Repository path for operations that require repository context (default: current directory)"
    )
    .option("--json", "Output full JSON response instead of just tool names")
    .action(async (options) => {
      try {
        if (!options.json) {
          log.cli("Listing available MCP tools...");
        }

        await new Promise<void>((resolve, reject) => {
          const child = spawn("minsky", ["mcp", "start"], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: options.repo || process.cwd(),
            env: { ...process.env },
          });

          // Send initialization and tools/list requests
          const initRequest = `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-01-07",
              capabilities: {},
              clientInfo: { name: "minsky-cli", version: "1.0.0" },
            },
          })}\n`;

          const toolsRequest = `${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          })}\n`;

          child.stdin.write(initRequest);
          child.stdin.write(toolsRequest);
          child.stdin.end();

          let output = "";
          child.stdout.on("data", (data) => {
            output += data.toString();
          });

          child.on("close", (code) => {
            try {
              // Find the tools/list response in the output
              const lines = output.split("\n").filter((line) => line.trim());
              const toolsResponse = lines.find((line) => {
                try {
                  const parsed = JSON.parse(line);
                  return parsed.id === 2 && parsed.result && parsed.result.tools;
                } catch {
                  return false;
                }
              });

              if (toolsResponse) {
                const parsed = JSON.parse(toolsResponse);

                if (options.json) {
                  // Output full JSON response
                  log.cli(JSON.stringify(parsed.result, null, 2));
                } else {
                  // Output just tool names
                  const tools = parsed.result.tools || [];
                  for (const tool of tools) {
                    log.cli(tool.name);
                  }
                }
                resolve();
              } else {
                reject(new Error("No tools response found in server output"));
              }
            } catch (error) {
              reject(error);
            }
          });

          child.on("error", (error) => {
            reject(error);
          });
        });
      } catch (error) {
        log.cliError(`Failed to list tools: ${getErrorMessage(error)}`);
        exit(1);
      }
    });

  return toolsCommand;
}
