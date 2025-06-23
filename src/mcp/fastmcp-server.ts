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
      transportType: options.transportType ?? "stdio",
      projectContext: options.projectContext ?? createProjectContextFromCwd(),
      sse: {
        port: options.sse?.port ?? 3000,
        host: options.sse?.host ?? "localhost",
        path: options.sse?.path ?? "/sse",
      },
      httpStream: {
        endpoint: options.httpStream?.endpoint ?? "/mcp",
        port: options.httpStream?.port ?? 8080,
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
      await this.fastmcp.start({
        transport: "sse",
        port: this.options.sse.port,
        host: this.options.sse.host,
        path: this.options.sse.path,
      });
      log.agent(
        `MCP Server started with SSE transport on ${this.options.sse.host}:${this.options.sse.port}${this.options.sse.path}`
      );
    } else if (this.options.transportType === "httpStream") {
      await this.fastmcp.start({
        transport: "httpStream",
        port: this.options.httpStream.port,
        endpoint: this.options.httpStream.endpoint,
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
