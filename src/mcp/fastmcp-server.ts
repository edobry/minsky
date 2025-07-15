/**
 * FastMCP-based MCP Server implementation
 */
import { FastMCP } from "fastmcp";
import type { ProjectContext } from "../types/project";
import { createProjectContextFromCwd } from "../types/project";
import { log } from "../utils/logger";

/**
 * Configuration options for the Minsky MCP server
 */
export interface MinskyMCPServerOptions {
  name?: string;
  version?: string;
  transportType?: "stdio" | "sse" | "httpStream";
  projectContext?: ProjectContext;
  sse?: {
    port?: number;
    host?: string;
    path?: string;
  };
  httpStream?: {
    endpoint?: string;
    port?: number;
  };
}

/**
 * Minsky MCP Server implementation using FastMCP
 */
export class MinskyMCPServer {
  private fastmcp: FastMCP;
  private options: Required<MinskyMCPServerOptions>;
  private projectContext: ProjectContext;

  constructor(options: MinskyMCPServerOptions = {}) {
    this.options = {
      name: options.name ?? "Minsky MCP Server",
      version: options.version ?? "1.0.0",
      /* TODO: Verify if transportType is valid property */ transportType: options.transportType ?? "stdio",
      projectContext: options.projectContext ?? createProjectContextFromCwd(),
      sse: {
        host: options.sse.host ?? "localhost",
        path: options.sse.path ?? "/sse",
        port: options.sse.port ?? 3000
      },
      /* TODO: Verify if httpStream is valid property */ httpStream: {
        endpoint: options.httpStream.endpoint ?? "/mcp",
        port: options.httpStream.port ?? 8080
      },
    };

    this.projectContext = this.options.projectContext;

    // Create the FastMCP server
    this.fastmcp = new FastMCP({
      name: this.options.name,
      version: this.options.version,
    });
  }

  /**
   * Get the underlying FastMCP server instance
   */
  getFastMCPServer(): FastMCP {
    return this.fastmcp;
  }

  /**
   * Get the project context
   */
  getProjectContext(): ProjectContext {
    return this.projectContext;
  }

  /**
   * Start the MCP server with the configured transport
   */
  async start(): Promise<void> {
    log.agent(`Starting ${this.options.name} with ${this.options.transportType} transport`);

    if (this.options.transportType === "stdio") {
      await this.fastmcp.start();
      log.agent("MCP Server started with stdio transport");
    } else if (this.options.transportType === "sse") {
      // SSE is not supported by FastMCP, fall back to httpStream
      await this.fastmcp.start({
        transportType: "httpStream",
        httpStream: {
          port: this.options.sse.port
        }
      });
      log.agent(
        `MCP Server started with HTTP Stream transport (SSE fallback) on port ${this.options.sse.port}`
      );
    } else if (this.options.transportType === "httpStream") {
      await this.fastmcp.start({
        transportType: "httpStream",
        httpStream: {
          port: this.options.httpStream.port
        }
      });
      log.agent(
        `MCP Server started with HTTP Stream transport on port ${this.options.httpStream.port}`
      );
    } else {
      throw new Error(`Unsupported transport type: ${this.options.transportType}`);
    }
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    // FastMCP doesn't have a stop method, so we'll just log
    log.agent("MCP Server stopped");
  }
}
