import { FastMCP } from "fastmcp";
import { log } from "../utils/logger";

/**
 * Configuration options for the Minsky MCP server
 */
export interface MinskyMCPServerOptions {
  /**
   * The name of the server
   * @default "Minsky MCP Server"
   */
  name?: string;

  /**
   * The version of the server
   * @default "current version of Minsky"
   */
  version?: string;

  /**
   * Transport type to use for the server
   * @default "stdio"
   */
  transportType?: "stdio" | "sse" | "httpStream";

  /**
   * SSE configuration options
   */
  sse?: {
    /**
     * Endpoint for SSE
     * @default "/sse"
     */
    endpoint?: string;

    /**
     * Port for SSE server
     * @default 8080
     */
    port?: number;
  };

  /**
   * HTTP Stream configuration options
   */
  httpStream?: {
    /**
     * Endpoint for HTTP Stream
     * @default "/stream"
     */
    endpoint?: string;

    /**
     * Port for HTTP Stream server
     * @default 8080
     */
    port?: number;
  };
}

/**
 * MinskyMCPServer is the main class for the Minsky MCP server
 * It handles the MCP protocol communication and tool registration
 */
export class MinskyMCPServer {
  private server: FastMCP;
  private options: MinskyMCPServerOptions;

  /**
   * Create a new MinskyMCPServer
   * @param options Configuration options for the server
   */
  constructor(options: MinskyMCPServerOptions = {}) {
    this.options = {
      name: options.name || "Minsky MCP Server",
      version: options.version || "1.0.0", // Should be dynamically pulled from package.json
      transportType: options.transportType || "stdio",
      sse: {
        endpoint: options.sse?.endpoint || "/sse",
        port: options.sse?.port || 8080,
      },
      httpStream: {
        endpoint: options.httpStream?.endpoint || "/stream",
        port: options.httpStream?.port || 8080,
      },
    };

    // Ensure name and version are not undefined for FastMCP
    const serverName = this.options.name || "Minsky MCP Server";
    // Use a valid semver format for the version string
    const serverVersion = "1.0.0"; // Hard-coded to meet FastMCP's version type requirement

    this.server = new FastMCP({
      name: serverName,
      version: serverVersion,
      ping: {
        // Enable pings for network transports, disable for stdio
        enabled: this.options.transportType !== "stdio",
        intervalMs: 5000,
      },
      // Instructions for LLMs on how to use the Minsky MCP server
      instructions:
        "This server provides access to Minsky, a tool for managing AI-assisted development workflows.\n" +
        "You can use these tools to:\n" +
        "- Manage tasks and track their status\n" +
        "- Create and manage development sessions\n" +
        "- Perform git operations like commit, push, and PR creation\n" +
        "- Initialize new projects with Minsky\n" +
        "- Access and apply project rules\n\n" +
        "All tools return structured JSON responses for easy processing.",
    });

    // Listen for client connections
    this.server.on("connect", () => {
      log.agent("Client connected to Minsky MCP Server", {
        transport: this.options.transportType
      });
    });

    // Listen for client disconnections
    this.server.on("disconnect", () => {
      log.agent("Client disconnected from Minsky MCP Server", {
        transport: this.options.transportType
      });
    });
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    try {
      if (!this.options.transportType) {
        this.options.transportType = "stdio";
      }

      if (this.options.transportType === "stdio") {
        await this.server.start({ transportType: "stdio" });
      } else if (this.options.transportType === "sse" && this.options.sse) {
        await this.server.start({
          transportType: "sse",
          sse: {
            endpoint: "/sse", // Endpoint must start with a / character
            port: this.options.sse.port || 8080,
          },
        });
      } else if (this.options.transportType === "httpStream" && this.options.httpStream) {
        await this.server.start({
          transportType: "httpStream",
          httpStream: {
            endpoint: "/stream", // Endpoint must start with a / character
            port: this.options.httpStream.port || 8080,
          },
        });
      } else {
        // Default to stdio if transport type is invalid
        await this.server.start({ transportType: "stdio" });
      }
      log.agent("Minsky MCP Server started", {
        transport: this.options.transportType,
        serverName: this.options.name,
        version: this.options.version
      });
    } catch (error) {
      log.error("Failed to start Minsky MCP Server", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        transport: this.options.transportType
      });
      throw error;
    }
  }

  /**
   * Get access to the underlying FastMCP server instance
   */
  getFastMCPServer(): FastMCP {
    return this.server;
  }
}
