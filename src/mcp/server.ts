import { FastMCP } from "fastmcp";
import { log } from "../utils/logger";
import type { ProjectContext } from "../types/project";
import { createProjectContextFromCwd } from "../types/project";
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
      this.projectContext = options.projectContext || createProjectContextFromCwd();
      log.debug("Using project context", {
        repositoryPath: this.projectContext.repositoryPath,
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
      name: options.name || "Minsky MCP Server",
      version: options.version || "1.0.0", // Should be dynamically pulled from package.json
      /* TODO: Verify if transportType is valid property */ transportType: options.transportType || "stdio",
      projectContext: this.projectContext,
      sse: {
        /* TODO: Verify if endpoint is valid property */ endpoint: options.sse?.endpoint || "/sse",
        port: options.sse?.port || 8080,
        host: options.sse?.host || "localhost",
        path: options.sse?.path || "/sse",
      },
      /* TODO: Verify if httpStream is valid property */ httpStream: {
        endpoint: options.httpStream?.endpoint || "/mcp",
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
      log.agent("Client connected to Minsky MCP Server");
    });

    // Listen for client disconnections
    this.server.on("disconnect", () => {
      log.agent("Client disconnected from Minsky MCP Server");
    });

    // Add basic resources support to prevent "Method not found" errors
    this.server.addResource({
      uri: "minsky://help",
      name: "Minsky Help",
      description: "Basic help information for using Minsky MCP server",
      mimeType: "text/plain",
      load: async () => {
        return {
          text: `Minsky MCP Server Help

Available tools:
- Use 'tasks.*' commands to manage tasks
- Use 'session.*' commands to manage development sessions
- Use 'git.*' commands for git operations
- Use 'init.*' commands to initialize projects
- Use 'rules.*' commands to work with project rules

For more information, visit: https://github.com/your-org/minsky
`,
          mimeType: "text/plain"
        };
      }
    });

    // Add basic prompts support to prevent "Method not found" errors
    this.server.addPrompt({
      name: "minsky_help",
      description: "Get help with using Minsky MCP server",
      arguments: [],
      load: async () => {
        return {
          messages: [{
            role: "user" as const,
            content: {
              type: "text" as const,
              text: "How can I use the Minsky MCP server to manage my AI-assisted development workflow?"
            }
          }]
        };
      }
    });

    // We'll add the debug tool later through the CommandMapper to ensure it gets properly registered
  }

  /**
   * Start the server with the configured transport type
   */
  async start(): Promise<void> {
    try {
      if (!this.options.transportType) {
        this.options.transportType = "stdio";
      }

      if (this.options.transportType === "stdio") {
        await this.server.start({ transportType: "stdio" });
      } else if (this.options.transportType === "sse" && this.options.sse) {
        // FastMCP 3.5.0 doesn't support SSE, fall back to httpStream
        await this.server.start({
          transportType: "httpStream",
          httpStream: {
            endpoint: "/sse", // Keep original endpoint for compatibility
            port: this.options.sse.port || 8080,
          },
        });
      } else if (this.options.transportType === "httpStream" && this.options.httpStream) {
        await this.server.start({
          transportType: "httpStream",
          httpStream: {
            endpoint: "/mcp", // Updated endpoint to /mcp
            port: this.options.httpStream.port || 8080,
          },
        });
      } else {
        // Default to stdio if transport type is invalid
        await this.server.start({ transportType: "stdio" });
      }

      // Log server started message with structured information for monitoring
      log.agent("Minsky MCP Server started");

      // Debug log of registered methods
      try {
        // Get the tool names
        const methods = [];
        // @ts-ignore - Accessing a private property for debugging
        if ((this.server as any)._tools) {
          // @ts-ignore
          methods.push(...Object.keys((this.server as any)._tools));
        }
        log.debug("MCP Server registered methods", {
          methodCount: methods.length,
          methods,
        });
      } catch (e) {
        log.debug("Could not log MCP server methods", {
          error: getErrorMessage(e as unknown),
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

  /**
   * Initialize MCP Inspector compatibility patches
   * This is a workaround for MCP Inspector expecting non-standard schema metadata
   */
  private async initializeInspectorCompatibility() {
    // Note: The MCP Inspector expects `~standard.vendor` metadata that is not part
    // of the official MCP specification. This appears to be a compatibility issue
    // between FastMCP and the Inspector that needs to be addressed upstream.

    // For now, we log this issue and continue without the metadata
    log.debug("MCP Inspector compatibility note: Inspector may expect non-standard ~standard.vendor metadata");
  }
}
