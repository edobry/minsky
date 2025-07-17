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
    .action(async (options) => {
      try {
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

        log.debug("Starting MCP server", {
          repositoryPath: projectContext?.repositoryPath || process.cwd(),
          withInspector: options.withInspector || false,
          inspectorPort: options.inspectorPort,
        });

        // Create server with stdio transport (official MCP SDK)
        const server = new MinskyMCPServer({
          name: "Minsky MCP Server",
          version: "1.0.0", // TODO: Import from package.json
          projectContext,
        });

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
              mcpTransportType: "stdio",
              mcpPort: undefined, // stdio doesn't use ports
              mcpHost: undefined, // stdio doesn't use hosts
            });

            if (inspectorResult.success) {
              log.cli(`MCP Inspector started on port ${inspectorPort}`);
              log.cli(`Open your browser at ${inspectorResult.url} to access the inspector`);
              log.cli("The inspector will start its own MCP server instance");
            } else {
              log.cliError(`Failed to start MCP Inspector: ${inspectorResult.error}`);
              exit(1);
            }
          }
        } else {
          // Only start the server directly if not using inspector
          await server.start();

          log.cli("Minsky MCP Server started with stdio transport");
          if (projectContext) {
            log.cli(`Repository path: ${projectContext.repositoryPath}`);
          }
          log.cli("Ready to receive MCP requests via stdin/stdout");
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
