import { spawn, ChildProcess } from "child_process";
import { log } from "../utils/logger";
import { getErrorMessage } from "../errors/index";

/**
 * Configuration options for the MCP Inspector
 */
export interface InspectorOptions {
  /**
   * Port for the inspector to listen on
   * @default 5173
   */
  port?: number;

  /**
   * Whether to open the browser automatically
   * @default true
   */
  openBrowser?: boolean;

  /**
   * Transport type of the MCP server
   */
  mcpTransportType: "stdio" | "httpStream";

  /**
   * Port of the MCP server (for non-stdio transports)
   */
  mcpPort?: number;

  /**
   * Host of the MCP server (for non-stdio transports)
   */
  mcpHost?: string;
}

/**
 * Result of launching the inspector
 */
export interface InspectorLaunchResult {
  /**
   * Whether the inspector was launched successfully
   */
  success: boolean;

  /**
   * The child process if launched successfully
   */
  process?: ChildProcess;

  /**
   * URL to access the inspector
   */
  url?: string;

  /**
   * Error message if launch failed
   */
  error?: string;
}

/**
 * Checks if the MCP inspector is available in the current environment
 * @returns true if the inspector is available
 */
export function isInspectorAvailable(): boolean {
  try {
    // Check if the binary exists in node_modules/.bin
    const { existsSync } = require("fs");
    const { join } = require("path");

    const binPath = join((process as any).cwd(), "node_modules", ".bin", "mcp-inspector");
    return existsSync(binPath);
  } catch (error) {
    return false;
  }
}

/**
 * Launch the MCP Inspector
 * @param options Inspector launch options
 * @returns Inspector launch result
 */
export function launchInspector(options: InspectorOptions): InspectorLaunchResult {
  const { port = 5173, openBrowser = true, mcpTransportType, mcpPort, mcpHost } = options;

  if (!isInspectorAvailable()) {
    return {
      success: false,
      error:
        "MCP Inspector is not installed. Run 'bun add -d @modelcontextprotocol/inspector' to install it.",
    };
  }

  try {
    // Build the MCP server command that the inspector will launch
    // Use bun run to execute the minsky command properly
    const serverCommand = ["bun", "run", "minsky", "mcp", "start"];

    // Add transport-specific arguments
    if (mcpTransportType === "httpStream") {
      serverCommand.push("--http");
      if (mcpPort) {
        serverCommand.push("--port", mcpPort.toString());
      }
      if (mcpHost) {
        serverCommand.push("--host", mcpHost);
      }
    } else {
      // Default to stdio
      serverCommand.push("--stdio");
    }

    // Configure environment variables for the inspector
    // Inspector needs its own proxy port that doesn't conflict with MCP server
    // Use a more dynamic approach to avoid port conflicts
    const basePort = mcpPort ? parseInt(mcpPort.toString()) : 3000;
    const inspectorProxyPort = (basePort + 3277).toString(); // Use a larger offset to avoid conflicts
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLIENT_PORT: port.toString(),
      SERVER_PORT: inspectorProxyPort, // Dynamic proxy port to avoid conflicts
    };

    // Configure auto-open based on openBrowser option
    // The inspector now supports auto-open with authentication enabled by default
    if (!openBrowser) {
      env.MCP_AUTO_OPEN_ENABLED = "false";
    } else {
      // Enable auto-open with authentication (recommended approach)
      env.MCP_AUTO_OPEN_ENABLED = "true";
    }

    // Remove DANGEROUSLY_OMIT_AUTH as it's not recommended and auto-open now works with auth

    log.debug("Launching MCP Inspector", {
      clientPort: port,
      inspectorProxyPort,
      openBrowser,
      mcpTransportType,
      mcpPort,
      mcpHost,
      serverCommand,
    });

    // Launch the inspector with the server command
    // The inspector will start its own instance of the server and connect to it
    const inspectorProcess = spawn(
      "npx",
      ["@modelcontextprotocol/inspector", ...serverCommand],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env,
        cwd: process.cwd(), // Ensure we're in the right directory for bun run
      }
    );

    // Check for immediate launch errors
    if (!inspectorProcess.pid) {
      return {
        success: false,
        error: "Failed to start MCP Inspector process",
      };
    }

    // Handle process events
    inspectorProcess.on("error", (error) => {
      log.error("MCP Inspector process error", {
        error: (error as any).message as any,
        stack: (error as any).stack as any,
      });
    });

    inspectorProcess.stderr.on("data", (data) => {
      log.error(`MCP Inspector stderr: ${data.toString()}`);
    });

    inspectorProcess.on("exit", (code, signal) => {
      log.debug("MCP Inspector process exited", { code, signal });
    });

    // Return success result
    return {
      success: true,
      process: inspectorProcess,
      url: `http://localhost:${port}`,
    };
  } catch (error) {
    // Log and return error
    log.error("Failed to launch MCP Inspector", {
      error: getErrorMessage(error as any),
      stack: error instanceof Error ? (error as any).stack as any : undefined as any,
    });

    return {
      success: false,
      error: error instanceof Error ? (error as any).message as any : "Unknown error launching MCP Inspector" as any,
    };
  }
}
