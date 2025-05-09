import { FastMCP, UserError } from "fastmcp";
import { IncomingMessage } from "http";

/**
 * Authentication context for MCP sessions
 */
export interface MCPAuthContext {
  authenticated: boolean;
  userId: string;
}

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

  /**
   * Authentication options
   */
  auth?: {
    /**
     * Enable authentication
     * @default false
     */
    enabled?: boolean;

    /**
     * API key for simple authentication
     * If not provided, authentication is disabled regardless of enabled setting
     */
    apiKey?: string;
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
      auth: {
        enabled: options.auth?.enabled || false,
        apiKey: options.auth?.apiKey
      }
    };

    // Ensure name and version are not undefined for FastMCP
    const serverName = this.options.name || "Minsky MCP Server";

    const serverOptions = {
      name: serverName,
      // FastMCP requires version in x.y.z format
      version: "1.0.0" as const,
      ping: {
        // Enable pings for network transports, disable for stdio
        enabled: this.options.transportType !== "stdio",
        intervalMs: 5000,
      },
      // Instructions for LLMs on how to use the Minsky MCP server
      instructions: "This server provides access to Minsky, a tool for managing AI-assisted development workflows.\nYou can use these tools to:\n- Manage tasks and track their status\n- Create and manage development sessions\n- Perform git operations like commit, push, and PR creation\n- Initialize new projects with Minsky\n- Access and apply project rules\n\nAll tools return structured JSON responses for easy processing."
    };

    // For simplicity in this implementation, we'll skip authentication for now
    // and revisit it in a future task when we have a better understanding of 
    // FastMCP's authentication requirements
    this.server = new FastMCP(serverOptions);
    
    if (this.options.auth?.enabled && this.options.auth?.apiKey) {
      console.log("Note: Authentication support is disabled in this version");
    }

    // Listen for client connections
    this.server.on("connect", (event) => {
      console.log("Client connected to Minsky MCP Server");
    });

    // Listen for client disconnections
    this.server.on("disconnect", (event) => {
      console.log("Client disconnected from Minsky MCP Server");
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
            port: this.options.sse.port || 8080
          }
        });
      } else if (this.options.transportType === "httpStream" && this.options.httpStream) {
        await this.server.start({
          transportType: "httpStream",
          httpStream: {
            endpoint: "/stream", // Endpoint must start with a / character
            port: this.options.httpStream.port || 8080
          }
        });
      } else {
        // Default to stdio if transport type is invalid
        await this.server.start({ transportType: "stdio" });
      }
      console.log(`Minsky MCP Server started with ${this.options.transportType} transport`);
    } catch (error) {
      console.error("Failed to start Minsky MCP Server:", error);
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
