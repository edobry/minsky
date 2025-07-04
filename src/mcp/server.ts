import { FastMCP } from "fastmcp";
import { log } from "../utils/logger.js";
import type { ProjectContext } from "../types/project.js";
import { createProjectContextFromCwd } from "../types/project.js";
import { getErrorMessage } from "../errors/index";

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
   * Project context containing repository information
   * Used for operations that require repository context
   * @default Context created from process.cwd()
   */
  projectContext?: ProjectContext;

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

    /**
     * Host to bind to
     * @default "localhost"
     */
    host?: string;

    /**
     * Path for SSE endpoint
     * @default "/sse"
     */
    path?: string;
  };

  /**
   * HTTP Stream configuration options
   */
  httpStream?: {
    /**
     * Endpoint for HTTP Stream
     * @default "/mcp"
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
  private projectContext: ProjectContext;

  /**
   * Create a new MinskyMCPServer
   * @param options Configuration options for the server
   */
  constructor(options: MinskyMCPServerOptions = {}) {
    // Store the project context or create a default one
    try {
      this.projectContext = (options as any).projectContext || createProjectContextFromCwd();
      log.debug("Using project context", {
        repositoryPath: (this.projectContext as any).repositoryPath,
      });
    } catch (error) {
      log.warn(
        "Failed to create project context from current directory, tools requiring repository context may not work",
        {
          error: getErrorMessage(error as any),
        }
      );
      // Create a minimal context with an empty path, tools will need to handle this
      this.projectContext = { repositoryPath: "" };
    }

    this.options = {
      name: (options as any).name || "Minsky MCP Server",
      version: (options as any).version || "1.0.0", // Should be dynamically pulled from package.json
      /* TODO: Verify if transportType is valid property */ transportType: (options as any).transportType || "stdio",
      projectContext: this.projectContext,
      sse: {
        /* TODO: Verify if endpoint is valid property */ endpoint: (options.sse as any).endpoint || "/sse",
        port: (options.sse as any).port || 8080,
        host: (options.sse as any).host || "localhost",
        path: (options.sse as any).path || "/sse",
      },
      /* TODO: Verify if httpStream is valid property */ httpStream: {
        endpoint: (options.httpStream as any).endpoint || "/mcp",
        port: (options.httpStream as any).port || 8080,
      },
    };

    // Ensure name and version are not undefined for FastMCP
    const serverName = (this.options as any).name || "Minsky MCP Server";
    // Use a valid semver format for the version string
    const serverVersion = "1.0.0"; // Hard-coded to meet FastMCP's version type requirement

    this.server = new FastMCP({
      name: serverName,
      version: serverVersion,
      ping: {
        // Enable pings for network transports, disable for stdio
        enabled: (this.options as any).transportType !== "stdio",
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
    (this.server as any).on("connect", () => {
      log.agent("Client connected to Minsky MCP Server", {
      });
    });

    // Listen for client disconnections
    (this.server as any).on("disconnect", () => {
      log.agent("Client disconnected from Minsky MCP Server", {
      });
    });

    // We'll add the debug tool later through the CommandMapper to ensure it gets properly registered
  }

  /**
   * Start the server with the configured transport type
   */
  async start(): Promise<void> {
    try {
      if (!(this.options as any).transportType) {
        (this.options as any).transportType = "stdio";
      }

      if ((this.options as any).transportType === "stdio") {
        await (this.server as any).start({ transportType: "stdio" });
      } else if ((this.options as any).transportType === "sse" && (this.options as any).sse) {
        await (this.server as any).start({
          transportType: "sse",
          sse: {
            endpoint: "/sse", // Endpoint must start with a / character
            port: (this.options.sse as any).port || 8080,
          },
        });
      } else if ((this.options as any).transportType === "httpStream" && (this.options as any).httpStream) {
        await (this.server as any).start({
          transportType: "httpStream",
          httpStream: {
            endpoint: "/mcp", // Updated endpoint to /mcp
            port: (this.options.httpStream as any).port || 8080,
          },
        });
      } else {
        // Default to stdio if transport type is invalid
        await (this.server as any).start({ transportType: "stdio" });
      }

      // Log server started message with structured information for monitoring
      log.agent("Minsky MCP Server started", {
        serverName: (this.options as any).name,
        version: (this.options as any).version,
        repositoryPath: (this.projectContext as any).repositoryPath,
      });

      // Debug log of registered methods
      try {
        // Get the tool names
        const methods = [];
        // @ts-ignore - Accessing a private property for debugging
        if ((this.server as any)._tools) {
          // @ts-ignore
          (methods as any).push(...(Object as any).keys((this.server as any)._tools) as any);
        }
        log.debug("MCP Server registered methods", {
          methodCount: (methods as any).length,
          methods,
        });
      } catch (e) {
        log.debug("Could not log MCP server methods", {
          error: getErrorMessage(e as any),
        });
      }
    } catch (error) {
      // Log error with full details (for structured logging/debugging)
      log.error("Failed to start Minsky MCP Server", {
        error: getErrorMessage(error as any),
        stack: error instanceof Error ? (error as any).stack as any : undefined as any
      });

      // Always rethrow the error - the caller is responsible for user-friendly handling
      throw error;
    }
  }

  /**
   * Get access to the underlying FastMCP server instance
   */
  getFastMCPServer(): FastMCP {
    return this.server;
  }

  /**
   * Get the project context for this server instance
   * @returns The project context containing repository information
   */
  getProjectContext(): ProjectContext {
    return this.projectContext;
  }
}
