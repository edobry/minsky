import fs from "fs";
import path from "path";
import { Command } from "commander";
import express from "express";
import { MinskyMCPServer } from "../../mcp/server";
import { CommandMapper } from "../../mcp/command-mapper";
import { log } from "../../utils/logger";
import { SharedErrorHandler } from "../../adapters/shared/error-handling";
import { getErrorMessage } from "../../errors/index";
import { launchInspector, isInspectorAvailable } from "../../mcp/inspector-launcher";
import { createProjectContext } from "../../types/project";
import { exit } from "../../utils/process";

import { registerDebugTools } from "../../adapters/mcp/debug";
import { registerGitTools } from "../../adapters/mcp/git";
import { registerRepoTools } from "../../adapters/mcp/repo";
import { registerInitTools } from "../../adapters/mcp/init";
import { registerRulesTools } from "../../adapters/mcp/rules";
import { registerSessionTools } from "../../adapters/mcp/session";
import { registerSessionWorkspaceTools } from "../../adapters/mcp/session-workspace";
import { registerPersistenceTools } from "../../adapters/mcp/persistence";
import { registerTaskTools } from "../../adapters/mcp/tasks";
import { registerChangesetTools } from "../../adapters/mcp/changeset";
import { registerConfigTools } from "../../adapters/mcp/config";
import { registerSessionFileTools } from "../../adapters/mcp/session-files";
import { registerSessionEditTools } from "../../adapters/mcp/session-edit-tools";
import { registerValidateTools } from "../../adapters/mcp/validate";
import { registerMcpManagementTools } from "../../adapters/mcp/mcp-commands";
import { registerKnowledgeResources } from "../../adapters/mcp/knowledge-resources";

const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_HOST = "localhost";
const DEFAULT_HTTP_ENDPOINT = "/mcp";
const INSPECTOR_PORT = 5173;

/**
 * Register all MCP tool adapters on the given command mapper.
 */
async function registerAllTools(
  commandMapper: CommandMapper,
  container?: import("../../composition/types").AppContainerInterface
): Promise<void> {
  // Ensure the container is initialized before registering tools.
  // MCP tool invocations bypass Commander's preAction hook, so initialization
  // must happen here — making it impossible to register tools without persistence.
  if (container && !container.has("persistence")) {
    await container.initialize();
    log.debug("Container initialized for MCP server");
  }

  // Health check: verify critical dependencies are available after init
  if (container && !container.has("sessionProvider")) {
    log.error(
      "MCP startup health check failed: sessionProvider not available after container init. " +
        "Session tools will fail. Check database connectivity."
    );
  }

  // Register debug tools first to ensure they're available for debugging
  registerDebugTools(commandMapper, container);

  // Register main application tools
  log.debug("[MCP] About to register task tools");
  registerTaskTools(commandMapper, container);
  log.debug("[MCP] About to register session tools");
  registerSessionTools(commandMapper, container);
  registerSessionWorkspaceTools(commandMapper, container);
  registerSessionFileTools(commandMapper, container);
  registerSessionEditTools(commandMapper, container);

  // Register persistence tools for agent querying
  log.debug("[MCP] About to register persistence tools");
  registerPersistenceTools(commandMapper, container);

  registerGitTools(commandMapper, container);
  registerRepoTools(commandMapper, container);

  registerInitTools(commandMapper, container);
  registerRulesTools(commandMapper, container);
  registerConfigTools(commandMapper, container);
  registerChangesetTools(commandMapper, container);
  registerValidateTools(commandMapper, container);
  registerMcpManagementTools(commandMapper, container);
}

/**
 * Validate and resolve the repository path from options.
 * Returns a ProjectContext or undefined if no repo option was provided.
 */
function resolveProjectContext(
  repoPath?: string
): ReturnType<typeof createProjectContext> | undefined {
  if (!repoPath) return undefined;

  const repositoryPath = path.resolve(repoPath);
  if (!fs.existsSync(repositoryPath)) {
    log.cliError(`Repository path does not exist: ${repositoryPath}`);
    exit(1);
  }
  if (!fs.statSync(repositoryPath).isDirectory()) {
    log.cliError(`Repository path is not a directory: ${repositoryPath}`);
    exit(1);
  }

  try {
    const ctx = createProjectContext(repositoryPath);
    log.debug("Using repository path from command line", { repositoryPath });
    return ctx;
  } catch (error) {
    log.cliError(`Invalid repository path: ${repositoryPath}`);
    if (SharedErrorHandler.isDebugMode() && error instanceof Error) {
      log.cliError(getErrorMessage(error));
    }
    exit(1);
  }
}

/**
 * Start the MCP server with HTTP transport.
 */
async function startHttpServer(
  server: MinskyMCPServer,
  options: {
    port: string;
    host: string;
    endpoint: string;
  },
  projectContext?: ReturnType<typeof createProjectContext>
): Promise<void> {
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
      log.error("HTTP request handling failed", {
        error: getErrorMessage(error),
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal server error",
          message: getErrorMessage(error),
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
      timestamp: new Date().toISOString(),
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
}

/**
 * Create the MCP "start" subcommand.
 */
export function createStartCommand(
  container?: import("../../composition/types").AppContainerInterface
): Command {
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
    .option("--host <host>", `HTTP host (default: ${DEFAULT_HTTP_HOST})`, DEFAULT_HTTP_HOST)
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

        const projectContext = resolveProjectContext(options.repo);

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

        // Register tools via adapter-based approach (initializes container if needed)
        const commandMapper = new CommandMapper(server, server.getProjectContext());
        await registerAllTools(commandMapper, container);

        // Register knowledge MCP resources on the server
        registerKnowledgeResources(server, container);

        // Launch inspector if requested
        if (options.withInspector) {
          if (!isInspectorAvailable()) {
            log.cliError(
              "MCP Inspector not found. Please install it with: bun add -d @modelcontextprotocol/inspector"
            );
            exit(1);
          } else {
            const inspectorPort = parseInt(options.inspectorPort, 10);
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
                log.cli(
                  `Inspector will connect to MCP server via HTTP at ${options.host}:${options.port}${options.endpoint}`
                );
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
          await startHttpServer(server, options, projectContext);
        } else {
          // Stdio transport
          if (!options.withInspector) {
            await server.start();
            if (projectContext) {
              log.cli(`Repository path: ${projectContext.repositoryPath}`);
            }
            log.cli("Ready to receive MCP requests via stdin/stdout");
          }
        }

        // Fire-and-forget background embedding sweep for missing tasks
        import("../../adapters/shared/commands/tasks/startup-embedding-sweep")
          .then(({ triggerStartupEmbeddingSweep }) => {
            if (!container) return;
            return triggerStartupEmbeddingSweep(
              container.get("persistence"),
              container.get("taskService")
            );
          })
          .catch(() => {}); // Embedding sweep is best-effort

        log.cli("Press Ctrl+C to stop");

        // Handle termination signals gracefully
        const cleanup = async () => {
          log.cli("\nStopping Minsky MCP Server...");
          try {
            await server.drain();
          } catch (error) {
            log.warn("Error during server cleanup", {
              error: getErrorMessage(error),
            });
          }
          process.exit(0);
        };

        const proc = process as Record<string, unknown>;
        (proc["on"] as (signal: string, handler: () => void) => void)("SIGTERM", cleanup);
        (proc["on"] as (signal: string, handler: () => void) => void)("SIGINT", cleanup);

        // Keep the process alive by waiting indefinitely
        await new Promise(() => {});
      } catch (error) {
        log.error("Failed to start MCP server", {
          transportType: options.http ? "http" : "stdio",
          withInspector: options.withInspector || false,
          error: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        log.cliError(`Failed to start MCP server: ${getErrorMessage(error)}`);
        exit(1);
      }
    });

  return startCommand;
}
