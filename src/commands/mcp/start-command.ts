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
import { buildAndStartScheduler } from "./scheduler-wiring";
import { setHostedMode } from "../../domain/configuration/guard";
import { MCPClientCapabilityRegistry } from "../../mcp/client-capabilities";

const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_HOST = "localhost";
const DEFAULT_HTTP_ENDPOINT = "/mcp";
const INSPECTOR_PORT = 5173;

/**
 * Check a bearer-token authorization header against the expected token.
 *
 * Returns true only when the header is present in the form `Bearer <token>`
 * (case-insensitive on the scheme) AND the presented token matches exactly.
 *
 * Exported for tests. Callers with auth disabled should not invoke this.
 */
export function checkBearerAuth(header: string | undefined, expectedToken: string): boolean {
  if (!header || !expectedToken) return false;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const presented = match?.[1]?.trim();
  return !!presented && presented === expectedToken;
}

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
    requireAuth?: boolean;
  },
  projectContext?: ReturnType<typeof createProjectContext>
): Promise<void> {
  const app = express();
  app.use(express.json());

  // Auth: bearer-token check. Enabled when MINSKY_MCP_AUTH_TOKEN is set OR
  // --require-auth was passed. /health remains public for Railway probes.
  // When --require-auth is explicit but no token configured, refuse startup
  // — silent no-auth with --require-auth would be the worst possible outcome.
  const rawToken = process.env.MINSKY_MCP_AUTH_TOKEN?.trim();
  const token = rawToken && rawToken.length > 0 ? rawToken : undefined;
  if (options.requireAuth && !token) {
    log.cliError(
      "--require-auth passed but MINSKY_MCP_AUTH_TOKEN env var is not set. " +
        "Set the token or omit --require-auth. Refusing to start in an undefined auth state."
    );
    exit(1);
  }
  type AuthState = { enabled: false } | { enabled: true; token: string };
  const auth: AuthState = token ? { enabled: true, token } : { enabled: false };
  if (auth.enabled) {
    log.cli(`HTTP MCP auth: bearer-token required (token length=${auth.token.length})`);
  } else {
    log.warn(
      "HTTP MCP starting WITHOUT authentication. Set MINSKY_MCP_AUTH_TOKEN to enable. " +
        "This is only safe on localhost or in a private network."
    );
  }

  // Set up CORS for development
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, mcp-session-id");
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
    } else {
      next();
    }
  });

  // Set up MCP endpoint (auth-gated when enabled)
  app.all(options.endpoint, async (req, res) => {
    if (auth.enabled) {
      const header = req.header("authorization") ?? req.header("Authorization");
      if (!checkBearerAuth(header, auth.token)) {
        res.status(401).json({
          error: "unauthorized",
          message: "valid bearer token required",
        });
        return;
      }
    }
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

  // Health check endpoint — always public, minimal body (safe to expose).
  // Railway and other uptime probes hit this; don't leak internal state.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "Minsky MCP Server",
      transport: "http",
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
    .option(
      "--require-auth",
      "Require bearer-token auth on the HTTP MCP endpoint (token from MINSKY_MCP_AUTH_TOKEN env)"
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
          // Hosted MCP: the developer-setup guard is a dev-laptop UX nudge and
          // does not apply to a server process. See mt#1208.
          setHostedMode(true);
        }

        const projectContext = resolveProjectContext(options.repo);

        // mt#1457: build the MCP-backed capability registry and wire it both
        // into the container (for asks.create / router consumers) and into
        // the MinskyMCPServer (for register/unregister of Server instances).
        // The CLI composition root (`createCliContainer`) registers a no-op
        // by default; this override replaces it for MCP-server execution so
        // routing decisions reflect actual host capabilities.
        const clientCapabilityRegistry = new MCPClientCapabilityRegistry();
        if (container) {
          container.set("clientCapabilityRegistry", clientCapabilityRegistry);
        }

        // Prepare server configuration
        const serverConfig = {
          name: "Minsky MCP Server",
          version: "1.0.0", // TODO: Import from package.json
          projectContext,
          transportType: transportType as "stdio" | "http",
          clientCapabilityRegistry,
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

        // Wire the container into the server so agentId can be written to session records
        // (must happen after registerAllTools which triggers container.initialize())
        if (container) {
          server.setContainer(container);
        }

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
          await startHttpServer(
            server,
            {
              port: options.port,
              host: options.host,
              endpoint: options.endpoint,
              requireAuth: options.requireAuth,
            },
            projectContext
          );
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

        // Start the knowledge sync scheduler (best-effort; non-blocking)
        // ADR-002: scheduler is only constructed here, inside the MCP server start
        // path — never from `minsky --help` or any CLI-only code path.
        const scheduler = await buildAndStartScheduler(container);

        // Hard timeout for drain+close path (mt#1417).
        // Configurable via PG_DRAIN_TIMEOUT_MS; defaults to 5000ms.
        // Sanitize: parseInt produces NaN for non-numeric values, which setTimeout
        // would coerce to 0 and fire the hard-timeout immediately, forcing exit(1)
        // even when a clean drain would have succeeded. Fall back to default and
        // clamp to a sane range (PR #881 R1 BLOCKING).
        const PG_DRAIN_TIMEOUT_DEFAULT_MS = 5000;
        const PG_DRAIN_TIMEOUT_MIN_MS = 100;
        const PG_DRAIN_TIMEOUT_MAX_MS = 60_000;
        // Strict validation: only accept a canonical decimal integer string.
        // parseInt would happily accept "200ms" (200), "0x10" (0), "1e3" (1) —
        // partial/exotic forms that should fall back to the default rather than
        // be silently coerced (PR #881 R3 BLOCKING).
        const rawDrainTimeout = process.env.PG_DRAIN_TIMEOUT_MS;
        const isCanonicalIntegerString = (s: string | undefined): s is string =>
          typeof s === "string" && /^\s*\d+\s*$/.test(s);
        const PG_DRAIN_TIMEOUT_MS = isCanonicalIntegerString(rawDrainTimeout)
          ? Math.min(
              Math.max(parseInt(rawDrainTimeout, 10), PG_DRAIN_TIMEOUT_MIN_MS),
              PG_DRAIN_TIMEOUT_MAX_MS
            )
          : PG_DRAIN_TIMEOUT_DEFAULT_MS;

        // Idempotency flag: once a shutdown race is in flight, skip re-entry.
        let shutdownInFlight = false;

        // Handle termination signals gracefully
        const cleanup = async () => {
          if (shutdownInFlight) return;
          shutdownInFlight = true;

          log.cli("\nStopping Minsky MCP Server...");

          // Race the drain+close path against a hard timeout so the process
          // never hangs indefinitely (e.g. when Claude Code closes the stdio pipe
          // without sending a signal — mt#1417).
          const drainAndClose = async (): Promise<void> => {
            try {
              // Stop the scheduler first so in-flight syncs complete before closing.
              if (scheduler) {
                await scheduler.stop();
                log.debug("[scheduler] Knowledge sync scheduler stopped");
              }
              await server.drain();
            } catch (error) {
              log.warn("Error during server cleanup", {
                error: getErrorMessage(error),
              });
            }
            // Release DB sockets promptly so another MCP instance (e.g. Railway
            // redeploy rolling over to a new container) can claim pool slots
            // without waiting for TCP timeout (mt#1193).
            try {
              const persistence = container?.has("persistence")
                ? container.get("persistence")
                : undefined;
              if (
                persistence &&
                typeof (persistence as { close?: () => Promise<void> }).close === "function"
              ) {
                await (persistence as { close: () => Promise<void> }).close();
                log.debug("[persistence] PostgreSQL connections closed");
              }
            } catch (error) {
              log.warn("Error closing persistence during shutdown", {
                error: getErrorMessage(error),
              });
            }
          };

          // Capture the timeout handle so we can clear it after the race resolves.
          // Otherwise the timer lingers until process.exit, harmless today but a
          // real footgun if the race shape evolves (PR #881 R1 NON-BLOCKING).
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const hardTimeout = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error("shutdown timeout")),
              PG_DRAIN_TIMEOUT_MS
            );
          });

          try {
            await Promise.race([drainAndClose(), hardTimeout]);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            // Route through the shared exit helper for consistent termination
            // semantics + Bun-vs-Node parity (PR #881 R1 BLOCKING).
            exit(0);
          } catch {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            log.warn(`Shutdown timed out after ${PG_DRAIN_TIMEOUT_MS}ms; forcing exit`);
            exit(1);
          }
        };

        const proc = process as Record<string, unknown>;
        (proc["on"] as (signal: string, handler: () => void) => void)("SIGTERM", cleanup);
        (proc["on"] as (signal: string, handler: () => void) => void)("SIGINT", cleanup);
        (proc["on"] as (signal: string, handler: () => void) => void)("SIGHUP", cleanup);

        // When the Claude Code parent closes its stdio pipe (without sending a signal),
        // trigger the same shutdown path (mt#1417). The `shutdownInFlight` guard
        // inside `cleanup` makes this listener idempotent even if it fires more
        // than once (PR #881 R1 NON-BLOCKING). Only attach for stdio transport —
        // HTTP-mode containers don't use stdin and may run with stdin closed at
        // startup, which would falsely trigger.
        if (!options.http) {
          process.stdin.on("close", cleanup);
        }

        // Print readiness AFTER all shutdown handlers are attached (PR #881 R2 BLOCKING):
        // tests + parent processes use this line as the deterministic ready signal,
        // so emitting it before handlers register opens a race window where an
        // immediate shutdown event hits the kernel default action and bypasses cleanup.
        log.cli("Press Ctrl+C to stop");

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
