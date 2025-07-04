import fs from "fs";
import path from "path";
import { Command } from "commander";
import { MinskyMCPServer } from "../../mcp/server";
import { CommandMapper } from "../../mcp/command-mapper";
import { log } from "../../utils/logger";
import { registerDebugTools } from "../../adapters/mcp/debug";
import { registerGitTools } from "../../adapters/mcp/git";
import { registerInitTools } from "../../adapters/mcp/init";
import { registerRulesTools } from "../../adapters/mcp/rules";
import { registerSessionTools } from "../../adapters/mcp/session";
// import { registerSessionWorkspaceTools } from "../../adapters/mcp/session-workspace";
import { registerTaskTools } from "../../adapters/mcp/tasks";
import { SharedErrorHandler } from "../../adapters/shared/error-handling";
import { getErrorMessage } from "../../errors/index";
import {
  isNetworkError,
  createNetworkError,
  formatNetworkErrorMessage,
} from "../../errors/network-errors.js";
import { launchInspector, isInspectorAvailable } from "../../mcp/inspector-launcher";
import { createProjectContext } from "../../types/project";
import { DEFAULT_DEV_PORT } from "../../utils/constants";
import { exit } from "../../utils/process.js";

const INSPECTOR_PORT = 3001;

// Import adapter-based tool registrations
// import { registerSessionFileTools } from "../../adapters/mcp/session-files";
// import { registerSessionEditTools } from "../../adapters/mcp/session-edit-tools";

/**
 * Create the MCP command
 * @returns The MCP command
 */
export function createMCPCommand(): Command {
  const mcpCommand = new Command("mcp");
  (mcpCommand as any).description("Model Context Protocol (MCP) server commands");

  // Start command
  const startCommand = new Command("start");
  (startCommand as any).description("Start the MCP server");
  (startCommand
    .option("--stdio", "Use stdio transport (default)")
    .option("--http-stream", "Use HTTP Stream transport")
    .option("-p, --port <port>", "Port for HTTP Stream server", (DEFAULT_DEV_PORT as any).toString())
    .option("-h, --host <host>", "Host for HTTP Stream server", "localhost")
    .option(
      "--repo <path>",
      "Repository path for operations that require repository context (default: current directory)"
    )
    .option("--with-inspector", "Launch MCP inspector alongside the server")
    .option("--inspector-port <port>", "Port for the MCP inspector", (INSPECTOR_PORT as any).toString()) as any).action(async (options) => {
    try {
      // Determine transport type based on options
      let transportType: "stdio" | "sse" | "httpStream" = "stdio";
      if ((options as any).httpStream) {
        transportType = "httpStream";
      }

      // Set port (used for HTTP Stream)
      const port = parseInt((options as any).port, 10);

      // Validate and prepare repository path if provided
      let projectContext;
      if ((options as any).repo) {
        const repositoryPath = path.resolve((options as any).repo);
        // Validate that the path exists and is a directory
        if (!fs.existsSync(repositoryPath)) {
          log.cliError(`Repository path does not exist: ${repositoryPath}`);
          exit(1);
        }
        if (!(fs.statSync(repositoryPath) as any).isDirectory()) {
          log.cliError(`Repository path is not a directory: ${repositoryPath}`);
          exit(1);
        }

        try {
          projectContext = createProjectContext(repositoryPath);
          log.debug("Using repository path from command line", {
            repositoryPath,
          });
        } catch (error) {
          log.cliError(`Invalid repository path: ${repositoryPath}`);
          if ((SharedErrorHandler as any).isDebugMode() && error instanceof Error) {
            log.cliError((error as any).message);
          }
          exit(1);
        }
      }

      log.debug("Starting MCP server", {
        transportType,
        port,
        host: (options as any).host,
        repositoryPath: (projectContext as any).repositoryPath || (process as any).cwd(),
        withInspector: (options as any).withInspector || false,
        inspectorPort: (options as any).inspectorPort,
      });

      // Create server with appropriate options
      const server = new MinskyMCPServer({
        name: "Minsky MCP Server",
        version: "1.0.0", // TODO: Import from package.json
        transportType,
        projectContext,
        sse: {
          port: 8080, // Default SSE port (not currently used via CLI)
          host: (options as any).host,
          path: "/mcp", // Updated from /stream to /mcp per fastmcp v3.x
        },
        /* TODO: Verify if httpStream is valid property */ httpStream: {
          port: transportType === "httpStream" ? port : 8080,
          endpoint: "/mcp",
        },
      });

      // Register tools via adapter-based approach
      const commandMapper = new CommandMapper(
        (server as any).getFastMCPServer(),
        (server as any).getProjectContext()
      );
        // Register debug tools first to ensure they're available for debugging
      registerDebugTools(commandMapper);

      // Register main application tools
      registerTaskTools(commandMapper);
      registerSessionTools(commandMapper);
      // registerSessionWorkspaceTools(commandMapper);
      // registerSessionFileTools(commandMapper);
      // registerSessionEditTools(commandMapper);
      registerGitTools(commandMapper);
      registerInitTools(commandMapper);
      registerRulesTools(commandMapper);

      // Start the server
      await (server as any).start();

      log.cli(`Minsky MCP Server started with ${transportType} transport`);
      if (projectContext) {
        log.cli(`Repository path: ${(projectContext as any).repositoryPath}`);
      }
      if (transportType !== "stdio") {
        log.cli(`Listening on ${(options as any).host}:${port}`);
      }

      // Launch inspector if requested
      if ((options as any).withInspector) {
        // Check if inspector is available
        if (!isInspectorAvailable()) {
          log.cliError(
            "MCP Inspector not found. Please install it with: bun add -d @modelcontextprotocol/inspector"
          );
        } else {
          const inspectorPort = parseInt((options as any).inspectorPort, 10);

          // Launch the inspector
          const inspectorResult = launchInspector({
            port: inspectorPort,
            openBrowser: true,
            mcpTransportType: transportType,
            mcpPort: transportType !== "stdio" ? port : undefined as any,
            mcpHost: transportType !== "stdio" ? (options as any).host : undefined as any,
          }) as any;

          if ((inspectorResult as any).success) {
            log.cli(`MCP Inspector started on port ${inspectorPort}`);
            log.cli(`Open your browser at ${(inspectorResult as any).url} to access the inspector`);
          } else {
            log.cliError(`Failed to start MCP Inspector: ${(inspectorResult as any).error}`);
            log.cliError("The MCP server will continue running without the inspector.");
          }
        }
      }

      log.cli("Press Ctrl+C to stop");

      // Handle termination signals
      (process as any).on("SIGINT", () => {
        log.cli("\nStopping Minsky MCP Server...");
        exit(0);
      });

      (process as any).on("SIGTERM", () => {
        log.cli("\nStopping Minsky MCP Server...");
        exit(0);
      });
    } catch (error) {
      // Log detailed error info for debugging
      log.error("Failed to start MCP server", {
        transportType: (options as any).httpStream ? "httpStream" : "stdio",
        port: (options as any).port,
        host: (options as any).host,
        withInspector: (options as any).withInspector || false,
        error: getErrorMessage(error as any),
        stack: error instanceof Error ? (error as any).stack as any : undefined as any,
      });

      // Handle network errors in a user-friendly way
      if (isNetworkError(error as any)) {
        const port = parseInt((options as any).port, 10);
        const networkError = createNetworkError(error as any, port, (options as any).host);
        const isDebug = (SharedErrorHandler as any).isDebugMode();

        // Output user-friendly message with suggestions
        log.cliError(formatNetworkErrorMessage(networkError, isDebug));

        // Only show stack trace in debug mode
        if (isDebug && error instanceof Error && (error as any).stack) {
          log.cliError("\nDebug information:");
          log.cliError((error as any).stack);
        }
      } else {
        // For other errors, provide a simpler message
        log.cliError(`Failed to start MCP server: ${getErrorMessage(error as any)}`);

        // Show stack trace only in debug mode
        if ((SharedErrorHandler as any).isDebugMode() && error instanceof Error && (error as any).stack) {
          log.cliError("\nDebug information:");
          log.cliError((error as any).stack);
        }
      }

      exit(1);
    }
  });

  mcpCommand.addCommand(startCommand);
  return mcpCommand;
}
