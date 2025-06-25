import { spawn, ChildProcess } from "child_process";
import { log } from "../utils/logger.js";

/**
 * Configuration options for the MCP Inspector
 */
export interface InspectorOptions {
  /**
   * Port for the inspector to listen on
   * @default 6274
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

    const binPath = join(process.cwd(), "node_modules", ".bin", "mcp-inspector");
    return existsSync(binPath);
  } catch (error) {
    console.log('[DEBUG] Caught error in src/mcp/inspector-launcher.ts:73:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');
    return false;
  }
}

/**
 * Launch the MCP Inspector
 * @param options Inspector launch options
 * @returns Inspector launch result
 */
export function launchInspector(options: InspectorOptions): InspectorLaunchResult {
  const { port = 6274, openBrowser = true, mcpTransportType, mcpPort, mcpHost } = options;

  if (!isInspectorAvailable()) {
    return {
      success: false,
      error:
        "MCP Inspector is not installed. Run 'bun add -d @modelcontextprotocol/inspector' to install it.",
    };
  }

  try {
    // For the new MCP inspector, we use the client start script
    // and configure it to connect to our existing server
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLIENT_PORT: port.toString(),
      SERVER_PORT: (port + 3).toString(), // Use a different port for the inspector server
    };

    // Configure auto-open based on openBrowser option
    if (!openBrowser) {
      env.MCP_AUTO_OPEN_ENABLED = "false";
    }

    // For security, we'll need to set this for auto-open to work
    env.DANGEROUSLY_OMIT_AUTH = "true";

    log.debug("Launching MCP Inspector", {
      clientPort: port,
      serverPort: port + 3,
      openBrowser,
      mcpTransportType,
      mcpPort,
      mcpHost,
    });

    // Use the client start script directly
    const inspectorProcess = spawn(
      "node",
      ["node_modules/@modelcontextprotocol/inspector/client/bin/start.js"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env,
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
        error: error.message,
        stack: error.stack,
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
    console.log('[DEBUG] Caught error in src/mcp/inspector-launcher.ts:162:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');
    // Log and return error
    log.error("Failed to launch MCP Inspector", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error launching MCP Inspector",
    };
  }
}
