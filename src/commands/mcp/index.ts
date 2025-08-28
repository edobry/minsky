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
import { registerSessionWorkspaceTools } from "../../adapters/mcp/session-workspace";
import { registerSessiondbTools } from "../../adapters/mcp/sessiondb";
import { registerTaskTools } from "../../adapters/mcp/tasks";
import { SharedErrorHandler } from "../../adapters/shared/error-handling";
import { getErrorMessage } from "../../errors/index";
// Remove network error imports since stdio doesn't have network errors
import { launchInspector, isInspectorAvailable } from "../../mcp/inspector-launcher";
import { createProjectContext } from "../../types/project";
import { exit } from "../../utils/process";
import express from "express";
import { spawn } from "child_process";
import { promisify } from "util";

const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_HOST = "localhost";
const DEFAULT_HTTP_ENDPOINT = "/mcp";
const INSPECTOR_PORT = 5173;

// Import adapter-based tool registrations
import { registerSessionFileTools } from "../../adapters/mcp/session-files";
import { registerSessionEditTools } from "../../adapters/mcp/session-edit-tools";
import { setupConfiguration } from "../../config-setup";
import { registerTaskRelationshipTools } from "../../adapters/mcp/task-relationships-tools";

/**
 * Enhanced error information from MCP inspector
 */
interface McpInspectorError {
  type: "validation" | "timeout" | "execution" | "unknown";
  message: string;
  toolName?: string;
  missingParam?: string;
  availableParams?: string[];
  suggestion?: string;
}

/**
 * Parse MCP inspector output to extract meaningful error information
 */
function parseInspectorError(output: string, toolName?: string): McpInspectorError {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Look for specific error patterns
  for (const line of lines) {
    // Missing required parameter
    if (line.includes("Missing required parameter:")) {
      const match = line.match(/Missing required parameter:\s*(\w+)/);
      const missingParam = match?.[1];
      return {
        type: "validation",
        message: `Missing required parameter: ${missingParam}`,
        toolName,
        missingParam,
        suggestion: missingParam
          ? `Use --arg ${missingParam}=<value>`
          : "Check the tool schema for required parameters",
      };
    }

    // Request timeout
    if (line.includes("Request timed out") || line.includes("timeout")) {
      return {
        type: "timeout",
        message: "Request timed out",
        toolName,
        suggestion: "The tool may be experiencing issues. Try again or use the CLI directly.",
      };
    }

    // Tool execution failed
    if (line.includes("Tool execution failed")) {
      return {
        type: "execution",
        message: "Tool execution failed",
        toolName,
        suggestion: "There may be an issue with the tool implementation.",
      };
    }
  }

  // Fallback for unknown errors
  return {
    type: "unknown",
    message: "Unknown error occurred",
    toolName,
    suggestion: `Try 'minsky mcp inspect --method tools/list' to see available tools`,
  };
}

/**
 * Call an MCP tool directly via stdio (faster than inspector CLI)
 * @param toolName Name of the tool to call
 * @param args Tool arguments as key-value pairs
 * @param options Options for the call
 */
async function callMcpToolDirectly(
  toolName: string,
  args: string[],
  options: { repo?: string; timeout?: number } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverArgs = ["mcp", "start"];
    if (options.repo) {
      serverArgs.push("--repo", options.repo);
    }

    log.debug(`Spawning minsky with args:`, serverArgs);
    const child = spawn("minsky", serverArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    log.debug(`Child process spawned with PID: ${child.pid}`);

    // Configurable timeout for the operation - use longer timeout for session operations
    const timeoutMs = options.timeout || (toolName.startsWith("session.") ? 60000 : 10000);
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        log.debug(`Killing child process ${child.pid} due to timeout`);
        child.kill("SIGTERM");
        reject(new Error(`Tool '${toolName}' timed out after ${timeoutMs / 1000} seconds`));
      }
    }, timeoutMs);

    // Convert args array to object
    const argsObj: Record<string, string> = {};
    for (const arg of args) {
      const [key, value] = arg.split("=", 2);
      if (key && value !== undefined) {
        argsObj[key] = value;
      }
    }

    // Send the MCP request
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: argsObj,
      },
    };

    // Wait a moment for the MCP server to start up
    setTimeout(() => {
      log.debug(`Sending MCP request: ${JSON.stringify(request)}`);
      child.stdin?.write(`${JSON.stringify(request)}\n`);
      child.stdin?.end();
    }, 1000);

    child.stdout?.on("data", (data) => {
      const output = data.toString();
      stdout += output;
      log.debug(`Received stdout: ${output.trim()}`);

      // Check if we got a complete JSON-RPC response and resolve early
      const lines = output.split("\n");
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('{"result":') || trimmedLine.startsWith('{"error":')) {
          try {
            const response = JSON.parse(trimmedLine);
            if (response.jsonrpc === "2.0" && response.id === 1 && !resolved) {
              resolved = true;
              clearTimeout(timeout);
              child.kill("SIGTERM");

              if (response.error) {
                reject(new Error(response.error.message || "MCP tool call failed"));
                return;
              }
              if (response.result !== undefined) {
                if (typeof response.result === "string") {
                  log.cli(String(response.result));
                } else {
                  log.cli(JSON.stringify(response.result, null, 2));
                }
                resolve();
                return;
              }
            }
          } catch (lineParseError) {
            // Continue processing
          }
        }
      }
    });

    child.stderr?.on("data", (data) => {
      const output = data.toString();
      stderr += output;
      log.debug(`Received stderr: ${output.trim()}`);
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);

      try {
        // Parse the server output to find the JSON-RPC response
        const lines = stdout.split("\n");
        for (const line of lines) {
          const trimmedLine = line.trim();

          // Look for JSON-RPC responses (might be direct or in debug logs)
          let jsonrpcResponse = null;

          // Try direct JSON-RPC response
          if (
            trimmedLine.startsWith('{"result":') ||
            trimmedLine.startsWith('{"error":') ||
            trimmedLine.includes('"jsonrpc"')
          ) {
            try {
              const response = JSON.parse(trimmedLine);
              if (response.jsonrpc === "2.0" && response.id === 1) {
                jsonrpcResponse = response;
              }
            } catch (lineParseError) {
              // Continue to check for embedded responses
            }
          }

          // If not found, look for JSON-RPC embedded in debug logs
          if (!jsonrpcResponse && trimmedLine.includes('"jsonrpc"')) {
            try {
              // Check if this is a debug log with a message field containing JSON-RPC
              const debugLog = JSON.parse(trimmedLine);
              if (
                debugLog.message &&
                typeof debugLog.message === "string" &&
                debugLog.message.includes('"jsonrpc"')
              ) {
                // Extract JSON-RPC from debug message (format: "Received stdout: {json}")
                const jsonStart = debugLog.message.indexOf("{");
                if (jsonStart !== -1) {
                  const jsonPart = debugLog.message.substring(jsonStart);
                  const response = JSON.parse(jsonPart);
                  if (response.jsonrpc === "2.0" && response.id === 1) {
                    jsonrpcResponse = response;
                  }
                }
              }
            } catch (lineParseError) {
              // Continue
            }
          }

          if (jsonrpcResponse) {
            if (jsonrpcResponse.error) {
              reject(new Error(jsonrpcResponse.error.message || "MCP tool call failed"));
              return;
            }
            if (jsonrpcResponse.result !== undefined) {
              // Pretty print the result
              if (typeof jsonrpcResponse.result === "string") {
                log.cli(String(jsonrpcResponse.result));
              } else {
                log.cli(JSON.stringify(jsonrpcResponse.result, null, 2));
              }
              resolve();
              return;
            }
          }
        }

        // If no valid JSON-RPC response found, check for any JSON-like lines
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith("{") && trimmedLine.includes("result")) {
            try {
              const response = JSON.parse(trimmedLine);
              if (response.result !== undefined) {
                if (typeof response.result === "string") {
                  log.cli(String(response.result));
                } else {
                  log.cli(JSON.stringify(response.result, null, 2));
                }
                resolve();
                return;
              }
            } catch (lineParseError) {
              continue;
            }
          }
        }

        log.debug("Raw server output:", stdout);
        log.debug("Raw server stderr:", stderr);
        reject(new Error("No valid MCP response found in server output"));
      } catch (parseError) {
        reject(new Error(`Failed to parse MCP response: ${parseError}`));
      }
    });

    child.on("error", (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/**
 * Execute the MCP inspector CLI with the given arguments
 * @param args Arguments to pass to the inspector CLI
 * @param options Execution options
 * @returns Promise that resolves with the output or rejects with enhanced error info
 */
async function runInspectorCli(
  args: string[],
  options: {
    repo?: string;
    cwd?: string;
  } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Build the command to run the inspector CLI against our MCP server
    const serverArgs = ["mcp", "start"];
    if (options.repo) {
      serverArgs.push("--repo", options.repo);
    }

    const inspectorArgs = [
      "@modelcontextprotocol/inspector",
      "--cli",
      "minsky",
      ...serverArgs,
      ...args,
    ];

    log.debug("Running MCP inspector CLI", {
      command: "npx",
      args: inspectorArgs,
      cwd: options.cwd,
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    // Add timeout to prevent indefinite hanging
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGTERM");
        reject(new Error("MCP inspector CLI timed out after 30 seconds"));
      }
    }, 30000);

    const child = spawn("npx", inspectorArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd || process.cwd(),
      env: { ...process.env },
    });

    child.stdout?.on("data", (data) => {
      const output = data.toString();
      stdout += output;
      // Still show output for successful operations
      if (!output.includes("Failed") && !output.includes("error")) {
        process.stdout.write(output);
      }
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve();
      } else {
        // Parse the error output to provide better error messages
        const errorOutput = stderr || stdout;
        const toolNameMatch = args.find((arg) => args[args.indexOf(arg) - 1] === "--tool-name");
        const errorInfo = parseInspectorError(errorOutput, toolNameMatch);

        const enhancedError = new Error(errorInfo.message) as Error & {
          mcpError: McpInspectorError;
        };
        enhancedError.mcpError = errorInfo;
        reject(enhancedError);
      }
    });

    child.on("error", (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

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

        // Shared commands are already registered by CLI initialization
        // No need to register them again here

        // Register tools via adapter-based approach
        const commandMapper = new CommandMapper(server, server.getProjectContext());

        // Register debug tools first to ensure they're available for debugging
        registerDebugTools(commandMapper);

        // Register main application tools
        log.debug("[MCP] About to register task tools");
        registerTaskTools(commandMapper);
        // Register task relationship tools (graph MVP)
        registerTaskRelationshipTools(commandMapper);
        log.debug("[MCP] About to register session tools");
        registerSessionTools(commandMapper);
        registerSessionWorkspaceTools(commandMapper);

        registerSessionFileTools(commandMapper);
        registerSessionEditTools(commandMapper);

        // Register sessiondb tools for agent querying
        log.debug("[MCP] About to register sessiondb tools");
        registerSessiondbTools(commandMapper);

        // TEMPORARILY DISABLE git tools during MCP startup to fix hanging issue
        // The git command registration causes circular dependency hangs during MCP startup
        // TODO: Fix the circular dependency in createGitService and re-enable
        // registerGitTools(commandMapper);

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
        } else {
          // Stdio transport
          if (!options.withInspector) {
            // Only start the server directly if not using inspector
            await server.start();

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

        // Note: Signal handlers removed due to Bun/TypeScript compatibility issues
        // The server will still be terminated when the parent process exits

        // Keep the process alive by waiting indefinitely
        await new Promise(() => {}); // This will never resolve, keeping the server running
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

  // Tools command - list available tools
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

        // Use direct JSON-RPC communication to avoid inspector CLI buffering issues
        const { spawn } = await import("child_process");

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

  // Call command - call a specific tool
  const callCommand = new Command("call");
  callCommand.description("Call a specific MCP tool");
  callCommand
    .argument("<tool-name>", "Name of the tool to call")
    .option(
      "--repo <path>",
      "Repository path for operations that require repository context (default: current directory)"
    )
    .option(
      "--arg <key=value>",
      "Tool arguments in key=value format (can be used multiple times)",
      (value: string, previous: string[] = []) => {
        return [...previous, value];
      },
      []
    )
    .option(
      "--timeout <seconds>",
      "Timeout in seconds (default: 10s for most tools, 60s for session operations)",
      (value: string) => parseInt(value, 10)
    )
    .option("--inspector", "Use MCP inspector CLI (legacy, slower)")
    .action(async (toolName: string, options) => {
      try {
        log.cli(`Calling tool: ${toolName}`);

        if (options.inspector) {
          // Use inspector CLI (legacy, known to hang)
          const inspectorArgs = ["--method", "tools/call", "--tool-name", toolName];

          // Add tool arguments
          if (options.arg && options.arg.length > 0) {
            for (const arg of options.arg) {
              inspectorArgs.push("--tool-arg", arg);
            }
          }

          await runInspectorCli(inspectorArgs, {
            repo: options.repo,
          });
        } else {
          // Use direct MCP client (default, faster, more reliable)
          await callMcpToolDirectly(toolName, options.arg || [], {
            repo: options.repo,
            timeout: options.timeout ? options.timeout * 1000 : undefined, // Convert seconds to milliseconds
          });
        }
      } catch (error: any) {
        // Check if this is an enhanced MCP error
        if (error.mcpError) {
          const mcpError = error.mcpError as McpInspectorError;

          // Provide user-friendly error messages based on error type
          switch (mcpError.type) {
            case "validation":
              log.cliError(`❌ ${mcpError.message}`);
              if (mcpError.suggestion) {
                log.cli(`💡 ${mcpError.suggestion}`);
              }
              if (mcpError.missingParam) {
                log.cli(
                  `📋 To see all parameters for ${toolName}, run: minsky mcp inspect --method tools/list`
                );
              }
              break;

            case "timeout":
              log.cliError(`⏱️  ${mcpError.message}`);
              if (mcpError.suggestion) {
                log.cli(`💡 ${mcpError.suggestion}`);
              }
              log.cli(`🚀 Try: minsky mcp call ${toolName} --direct (faster, more reliable)`);
              log.cli(`🔄 Alternative: minsky ${toolName.replace(".", " ")} --json`);
              break;

            case "execution":
              log.cliError(`🚫 ${mcpError.message}`);
              if (mcpError.suggestion) {
                log.cli(`💡 ${mcpError.suggestion}`);
              }
              break;

            default:
              log.cliError(`❌ ${mcpError.message}`);
              if (mcpError.suggestion) {
                log.cli(`💡 ${mcpError.suggestion}`);
              }
          }
        } else {
          // Fallback for non-MCP errors
          log.cliError(`Failed to call tool '${toolName}': ${getErrorMessage(error)}`);
        }
        exit(1);
      }
    });

  // Inspect command - general CLI inspection
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

  // Add all subcommands
  mcpCommand.addCommand(startCommand);
  mcpCommand.addCommand(toolsCommand);
  mcpCommand.addCommand(callCommand);
  mcpCommand.addCommand(inspectCommand);

  return mcpCommand;
}
