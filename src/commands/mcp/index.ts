import { Command } from "commander";
import { MinskyMCPServer } from "../../mcp/server.js";
import { CommandMapper } from "../../mcp/command-mapper.js";
import { log } from "../../utils/logger.js";

// Import adapter-based tool registrations
import { registerSessionTools } from "../../adapters/mcp/session.js";
import { registerTaskTools } from "../../adapters/mcp/tasks.js";
import { registerGitTools } from "../../adapters/mcp/git.js";
import { registerInitTools } from "../../adapters/mcp/init.js";
import { registerRulesTools } from "../../adapters/mcp/rules.js";

/**
 * Create the MCP command
 * @returns The MCP command
 */
export function createMCPCommand(): Command {
  const mcpCommand = new Command("mcp");
  mcpCommand.description("Model Context Protocol (MCP) server commands");

  // Start command
  const startCommand = new Command("start");
  startCommand.description("Start the MCP server");
  startCommand
    .option("--stdio", "Use stdio transport (default)")
    .option("--sse", "Use SSE transport")
    .option("--http-stream", "Use HTTP Stream transport")
    .option("-p, --port <port>", "Port for SSE or HTTP Stream server", "8080")
    .option("-h, --host <host>", "Host for SSE or HTTP Stream server", "localhost")
    .action(async (options) => {
      try {
        // Determine transport type based on options
        let transportType: "stdio" | "sse" | "httpStream" = "stdio";
        if (options.sse) {
          transportType = "sse";
        } else if (options.httpStream) {
          transportType = "httpStream";
        }

        // Set port (used for both SSE and HTTP Stream)
        const port = parseInt(options.port, 10);

        log.debug("Starting MCP server", {
          transportType,
          port,
          host: options.host
        });

        // Create server with appropriate options
        const server = new MinskyMCPServer({
          name: "Minsky MCP Server",
          version: "1.0.0", // TODO: Import from package.json
          transportType,
          sse: {
            endpoint: "/sse",
            port,
          },
          httpStream: {
            endpoint: "/stream",
            port,
          },
        });

        // Register tools via adapter-based approach
        const commandMapper = new CommandMapper(server.getFastMCPServer());
        registerTaskTools(commandMapper);
        registerSessionTools(commandMapper);
        registerGitTools(commandMapper);
        registerInitTools(commandMapper);
        registerRulesTools(commandMapper);

        // Start the server
        await server.start();

        log.cli(`Minsky MCP Server started with ${transportType} transport`);
        if (transportType !== "stdio") {
          log.cli(`Listening on ${options.host}:${port}`);
        }
        log.cli("Press Ctrl+C to stop");

        // Keep the process running
        process.stdin.resume();

        // Handle termination signals
        process.on("SIGINT", () => {
          log.cli("\nStopping Minsky MCP Server...");
          process.exit(0);
        });

        process.on("SIGTERM", () => {
          log.cli("\nStopping Minsky MCP Server...");
          process.exit(0);
        });
      } catch (error) {
        log.error("Failed to start MCP server", {
          transportType: options.sse ? "sse" : options.httpStream ? "httpStream" : "stdio",
          port: options.port,
          host: options.host,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        
        log.cliError(`Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  mcpCommand.addCommand(startCommand);
  return mcpCommand;
}
