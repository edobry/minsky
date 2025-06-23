import { Command } from "commander";
import { DEFAULT_DEV_PORT } from "../utils/constants";
import { MinskyMCPServer } from "../../mcp/server";
import { CommandMapper } from "../../mcp/command-mapper";
import { log } from "../../utils/logger";
import {
  isNetworkError,
  createNetworkError,
  formatNetworkErrorMessage,
} from "../../errors/network-errors.js";
import { SharedErrorHandler } from "../../adapters/shared/error-handling";
import { launchInspector, isInspectorAvailable } from "../../mcp/inspector-launcher";
import { createProjectContext } from "../../types/project";
import fs from "fs";
import path from "path";

const INSPECTOR_PORT = INSPECTOR_PORT;

// Import adapter-based tool registrations
import { registerSessionTools } from "../../adapters/mcp/session";
// import { registerSessionFileTools } from "../../adapters/mcp/session-files";
// import { registerSessionEditTools } from "../../adapters/mcp/session-edit-tools";
import { registerTaskTools } from "../../adapters/mcp/tasks";
import { registerGitTools } from "../../adapters/mcp/git";
import { registerInitTools } from "../../adapters/mcp/init";
import { registerRulesTools } from "../../adapters/mcp/rules";
import { registerDebugTools } from "../../adapters/mcp/debug";

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
    .option("--http-stream", "Use HTTP Stream transport")
    .option("-p, --port <port>", "Port for HTTP Stream server", "DEFAULT_DEV_PORT")
    .option("-h, --host <host>", "Host for HTTP Stream server", "localhost")
    .option(
      "--repo <path>",
      "Repository path for operations that require repository context (default: current directory)"
    )
    .option("--with-inspector", "Launch MCP inspector alongside the server")
    .option("--inspector-port <port>", "Port for the MCP inspector", "INSPECTOR_PORT")
    .action(async (_options) => {
      try {
        // Determine transport type based on options
        let transportType: "stdio" | "sse" | "httpStream" = "stdio";
        if (options.httpStream) {
          transportType = "httpStream";
        }

        // Set port (used for HTTP Stream)
        const port = parseInt(options.port, 10);

        // Validate and prepare repository path if provided
        let projectContext;
        if (options.repo) {
          const repositoryPath = path.resolve(options.repo);
          // Validate that the path exists and is a directory
          if (!fs.existsSync(repositoryPath)) {
            log.cliError(`Repository path does not exist: ${repositoryPath}`);
            process.exit(1);
          }
          if (!fs.statSync(repositoryPath).isDirectory()) {
            log.cliError(`Repository path is not a directory: ${repositoryPath}`);
            process.exit(1);
          }

          try {
            projectContext = createProjectContext(repositoryPath);
            log.debug("Using repository path from _command line", {
              repositoryPath,
            });
          } catch (_error) {
            log.cliError(`Invalid repository _path: ${repositoryPath}`);
            if (SharedErrorHandler.isDebugMode() && error instanceof Error) {
              log.cliError(error.message);
            }
            process.exit(1);
          }
        }

        log.debug("Starting MCP server", {
          transportType,
          port,
          host: options.host,
          repositoryPath: projectContext?.repositoryPath || process.cwd(),
          withInspector: options.withInspector || false,
          inspectorPort: options.inspectorPort,
        });

        // Create server with appropriate options
        const server = new MinskyMCPServer({
          name: "Minsky MCP Server",
          version: "1.0.0", // TODO: Import from package.json
          transportType,
          projectContext,
          sse: {
            port: 8080, // Default SSE port (not currently used via CLI)
            host: options.host,
            path: "/mcp", // Updated from /stream to /mcp per fastmcp v3.x
          },
          httpStream: {
            port: transportType === "httpStream" ? port : 8080,
            endpoint: "/mcp",
          },
        });

        // Register tools via adapter-based approach
        const commandMapper = new CommandMapper(
          server.getFastMCPServer(),
          server.getProjectContext()
        );
        // Register debug tools first to ensure they're available for debugging
        registerDebugTools(commandMapper);

        // Register main application tools
        registerTaskTools(commandMapper);
        registerSessionTools(commandMapper);
        // registerSessionFileTools(commandMapper);
        // registerSessionEditTools(commandMapper);
        registerGitTools(commandMapper);
        registerInitTools(commandMapper);
        registerRulesTools(commandMapper);

        // Start the server
        await server.start();

        log.cli(`Minsky MCP Server started with ${transportType} transport`);
        if (projectContext) {
          log.cli(`Repository _path: ${projectContext.repositoryPath}`);
        }
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
              mcpHost: transportType !== "stdio" ? options.host : undefined,
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
      } catch (_error) {
        // Log detailed error info for debugging
        log.error("Failed to start MCP server", {
          transportType: options.httpStream ? "httpStream" : "stdio",
          port: options.port,
          host: options.host,
          withInspector: options.withInspector || false,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        // Handle network errors in a user-friendly way
        if (isNetworkError(error)) {
          const port = parseInt(options.port, 10);
          const networkError = createNetworkError(_error, port, options.host);
          const isDebug = SharedErrorHandler.isDebugMode();

          // Output user-friendly message with suggestions
          log.cliError(formatNetworkErrorMessage(_networkError, isDebug));

          // Only show stack trace in debug mode
          if (isDebug && error instanceof Error && error.stack) {
            log.cliError("\nDebug information:");
            log.cliError(error.stack);
          }
        } else {
          // For other errors, provide a simpler message
          log.cliError(
            `Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`
          );

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
