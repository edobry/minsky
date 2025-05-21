import { Command } from "commander";
import { MinskyMCPServer } from "../../mcp/server.js";
import { CommandMapper } from "../../mcp/command-mapper.js";
import { log } from "../../utils/logger.js";
import { isNetworkError, createNetworkError, formatNetworkErrorMessage } from "../../errors/network-errors.js";
import { SharedErrorHandler } from "../../adapters/shared/error-handling.js";
import { launchInspector, isInspectorAvailable } from "../../mcp/inspector-launcher.js";

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
    .option("--with-inspector", "Launch MCP inspector alongside the server")
    .option("--inspector-port <port>", "Port for the MCP inspector", "6274")
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
          host: options.host,
          withInspector: options.withInspector || false,
          inspectorPort: options.inspectorPort
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
        
        // Launch inspector if requested
        if (options.withInspector) {
          // Check if inspector is available
          if (!isInspectorAvailable()) {
            log.cliError(
              "MCP Inspector not found. Please install it with: bun add -d @modelcontextprotocol/inspector"
            );
          } else {
            const inspectorPort = parseInt(options.inspectorPort, 10);
            
            // Launch the inspector
            const inspectorResult = launchInspector({
              port: inspectorPort,
              openBrowser: true,
              mcpTransportType: transportType,
              mcpPort: transportType !== "stdio" ? port : undefined,
              mcpHost: transportType !== "stdio" ? options.host : undefined
            });
            
            if (inspectorResult.success) {
              log.cli(`MCP Inspector started on port ${inspectorPort}`);
              log.cli(`Open your browser at ${inspectorResult.url} to access the inspector`);
            } else {
              log.cliError(`Failed to start MCP Inspector: ${inspectorResult.error}`);
              log.cliError("The MCP server will continue running without the inspector.");
            }
          }
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
        // Log detailed error info for debugging
        log.error("Failed to start MCP server", {
          transportType: options.sse ? "sse" : options.httpStream ? "httpStream" : "stdio",
          port: options.port,
          host: options.host,
          withInspector: options.withInspector || false,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        
        // Handle network errors in a user-friendly way
        if (isNetworkError(error)) {
          const port = parseInt(options.port, 10);
          const networkError = createNetworkError(error, port, options.host);
          const isDebug = SharedErrorHandler.isDebugMode();
          
          // Output user-friendly message with suggestions
          log.cliError(formatNetworkErrorMessage(networkError, isDebug));
          
          // Only show stack trace in debug mode
          if (isDebug && error instanceof Error && error.stack) {
            log.cliError("\nDebug information:");
            log.cliError(error.stack);
          }
        } else {
          // For other errors, provide a simpler message
          log.cliError(`Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`);
          
          // Show stack trace only in debug mode
          if (SharedErrorHandler.isDebugMode() && error instanceof Error && error.stack) {
            log.cliError("\nDebug information:");
            log.cliError(error.stack);
          }
        }
        
        process.exit(1);
      }
    });

  mcpCommand.addCommand(startCommand);
  return mcpCommand;
}
