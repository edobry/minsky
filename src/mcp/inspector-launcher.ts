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
    // Try to resolve the inspector package
    require.resolve("@modelcontextprotocol/inspector");
    return true;
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
  const { port = 6274, openBrowser = true, mcpTransportType, mcpPort, mcpHost } = options;

  if (!isInspectorAvailable()) {
    return {
      success: false,
      error:
        "MCP Inspector is not installed. Run 'bun add -d @modelcontextprotocol/inspector' to install it.",
    };
  }

  try {
    // Prepare arguments for the inspector
    const args = ["--port", port.toString()];

    // Set open browser flag
    if (!openBrowser) {
      args.push("--no-open");
    }

    // Configure MCP server connection based on transport type
    if (mcpTransportType === "stdio") {
      args.push("--stdio");
    } else if (mcpTransportType === "httpStream" && mcpPort) {
      args.push("--sse", `${mcpHost || "localhost"}:${mcpPort}`);
    } else if (mcpTransportType === "httpStream" && mcpPort) {
      args.push("--http-stream", `${mcpHost || "localhost"}:${mcpPort}`);
    }

    log.debug("Launching MCP Inspector with arguments", { args });

    // Spawn the inspector process
    const inspectorProcess = spawn("mcp-inspector", args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

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
