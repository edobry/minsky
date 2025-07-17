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
// Remove network error imports since stdio doesn't have network errors
import { launchInspector, isInspectorAvailable } from "../../mcp/inspector-launcher";
import { createProjectContext } from "../../types/project";
import { exit } from "../../utils/process";
import express from "express";

const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_HOST = "localhost";
const DEFAULT_HTTP_ENDPOINT = "/mcp";
const INSPECTOR_PORT = 5173;

// Import adapter-based tool registrations
// import { registerSessionFileTools } from "../../adapters/mcp/session-files";
// import { registerSessionEditTools } from "../../adapters/mcp/session-edit-tools";

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
    .option(
      "--repo <path>",
      "Repository path for operations that require repository context (default: current directory)"
    )
    .option("--with-inspector", "Launch MCP inspector alongside the server")
    .option("--inspector-port <port>", "Port for the MCP inspector", INSPECTOR_PORT.toString())
    .option("--http", "Use HTTP transport for remote connections (default: stdio)")
    .option(
      "--port <port>", 
      `HTTP port (required for http transport, default: ${DEFAULT_HTTP_PORT})`,
      DEFAULT_HTTP_PORT.toString()
    )
    .option(
      "--host <host>",
      `HTTP host (default: ${DEFAULT_HTTP_HOST})`,
      DEFAULT_HTTP_HOST
    )
    .option(
      "--endpoint <path>",
      `HTTP endpoint path (default: ${DEFAULT_HTTP_ENDPOINT})`,
      DEFAULT_HTTP_ENDPOINT
    )
    .action(async (options) => {
      try {
        // Determine transport type from --http flag
        const transportType = options.http ? "http" : "stdio";

        // Validate HTTP configuration if using HTTP transport
        if (transportType === "http") {
          const port = parseInt(options.port, 10);
          if (isNaN(port) || port < 1 || port > 65535) {
            log.cliError(`Invalid port: ${options.port}. Must be a number between 1 and 65535`);
            exit(1);
          }
        }

        // Validate and prepare repository path if provided
        let projectContext;
        if (options.repo) {
          const repositoryPath = path.resolve(options.repo);
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
            if (SharedErrorHandler.isDebugMode() && error instanceof Error) {
              log.cliError((error as any).message);
            }
            exit(1);
          }
        }

        // Prepare server configuration
        const serverConfig = {
          name: "Minsky MCP Server",
          version: "1.0.0", // TODO: Import from package.json
          projectContext,
          transportType: transportType as "stdio" | "http",
          ...(transportType === "http" && {
            httpConfig: {
              port: parseInt(options.port, 10),
              host: options.host,
              endpoint: options.endpoint,
            },
          }),
        };

        log.debug("Starting MCP server", {
          transportType: transportType,
          repositoryPath: projectContext?.repositoryPath || process.cwd(),
          withInspector: options.withInspector || false,
          inspectorPort: options.inspectorPort,
          httpConfig: serverConfig.httpConfig,
        });

        // Create server with the specified transport
        const server = new MinskyMCPServer(serverConfig);

        // Register tools via adapter-based approach
        const commandMapper = new CommandMapper(
          server,
          server.getProjectContext()
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

        // Launch inspector if requested (inspector will start its own server instance)
        if (options.withInspector) {
          // Check if inspector is available
          if (!isInspectorAvailable()) {
            log.cliError(
              "MCP Inspector not found. Please install it with: bun add -d @modelcontextprotocol/inspector"
            );
            exit(1);
          } else {
            const inspectorPort = parseInt(options.inspectorPort, 10);

            // Launch the inspector with the server command
            const inspectorResult = launchInspector({
              port: inspectorPort,
              openBrowser: true,
              mcpTransportType: transportType === "http" ? "httpStream" : "stdio",
              mcpPort: transportType === "http" ? parseInt(options.port, 10) : undefined,
              mcpHost: transportType === "http" ? options.host : undefined,
            });

            if (inspectorResult.success) {
              log.cli(`MCP Inspector started on port ${inspectorPort}`);
              log.cli(`Open your browser at ${inspectorResult.url} to access the inspector`);
              if (transportType === "http") {
                log.cli(`Inspector will connect to MCP server via HTTP at ${options.host}:${options.port}${options.endpoint}`);
              } else {
                log.cli("The inspector will start its own MCP server instance");
              }
            } else {
              log.cliError(`Failed to start MCP Inspector: ${inspectorResult.error}`);
              exit(1);
            }
          }
        }

        // Start the server
        if (transportType === "http") {
          // Set up Express app for HTTP transport
          const app = express();
          app.use(express.json());

          // Set up CORS for development
          app.use((req, res, next) => {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
            if (req.method === "OPTIONS") {
              res.sendStatus(200);
            } else {
              next();
            }
          });

          // Set up MCP endpoint
          app.all(options.endpoint, async (req, res) => {
            try {
              await server.handleHttpRequest(req, res);
            } catch (error) {
              log.error("HTTP request handling failed", { error: getErrorMessage(error) });
              if (!res.headersSent) {
                res.status(500).json({ 
                  error: "Internal server error",
                  message: getErrorMessage(error)
                });
              }
            }
          });

          // Health check endpoint
          app.get("/health", (req, res) => {
            res.json({ 
              status: "ok", 
              server: "Minsky MCP Server",
              transport: "http",
              endpoint: options.endpoint,
              timestamp: new Date().toISOString()
            });
          });

          // Start the HTTP server
          const httpPort = parseInt(options.port, 10);
          app.listen(httpPort, options.host, () => {
            log.cli("Minsky MCP Server started with HTTP transport");
            log.cli(`Server listening on ${options.host}:${httpPort}`);
            log.cli(`MCP endpoint: http://${options.host}:${httpPort}${options.endpoint}`);
            log.cli(`Health check: http://${options.host}:${httpPort}/health`);
            if (projectContext) {
              log.cli(`Repository path: ${projectContext.repositoryPath}`);
            }
            log.cli("Ready to receive MCP requests via HTTP");
          });

          // Initialize the MCP server (without connecting transport since HTTP is on-demand)
          await server.start();
        } else {
          // Stdio transport
          if (!options.withInspector) {
            // Only start the server directly if not using inspector
            await server.start();

            log.cli("Minsky MCP Server started with stdio transport");
            if (projectContext) {
              log.cli(`Repository path: ${projectContext.repositoryPath}`);
            }
            log.cli("Ready to receive MCP requests via stdin/stdout");
          }
        }

        log.cli("Press Ctrl+C to stop");

        // Handle termination signals gracefully when possible
        const cleanup = async () => {
          log.cli("\nStopping Minsky MCP Server...");
          try {
            await server.close();
          } catch (error) {
            log.warn("Error during server cleanup", { error: getErrorMessage(error) });
          }
          exit(0);
        };

        // TODO: Add signal handlers for graceful shutdown once typing issues are resolved
      } catch (error) {
        // Log detailed error info for debugging
        log.error("Failed to start MCP server", {
          transportType: options.http ? "http" : "stdio",
          withInspector: options.withInspector || false,
          error: getErrorMessage(error as any),
          stack: error instanceof Error ? (error as any).stack : undefined,
        });

        // Handle different types of errors for user-friendly messages
        log.cliError(`Failed to start MCP server: ${getErrorMessage(error as any)}`);

        exit(1);
      }
    });

  mcpCommand.addCommand(startCommand);

  return mcpCommand;
}
