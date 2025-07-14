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
      name: (options as unknown).name ?? "Minsky MCP Server",
      version: (options as unknown).version ?? "1.0.0",
      /* TODO: Verify if transportType is valid property */ transportType: (options as unknown).transportType ?? "stdio",
      projectContext: (options as unknown).projectContext ?? createProjectContextFromCwd(),
      sse: {
        host: (options.sse as unknown).host ?? "localhost",
        path: (options.sse as unknown).path ?? "/sse",
        port: (options.sse as unknown).port ?? 3000
      },
      /* TODO: Verify if httpStream is valid property */ httpStream: {
        endpoint: (options.httpStream as unknown).endpoint ?? "/mcp",
        port: (options.httpStream as unknown).port ?? 8080
      },
    };

    this.projectContext = (this.options as unknown).projectContext;

    // Create the FastMCP server
    this.fastmcp = new FastMCP({
      name: (this.options as unknown).name,
      version: (this.options as unknown).version,
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
    log.agent(`Starting ${(this.options as unknown).name} with ${(this.options as unknown).transportType} transport`);

    if ((this.options as unknown).transportType === "stdio") {
      await this.fastmcp.start();
      log.agent("MCP Server started with stdio transport");
    } else if ((this.options as unknown).transportType === "sse") {
      // SSE is not supported by FastMCP, fall back to httpStream
      await this.fastmcp.start({
        transportType: "httpStream",
        httpStream: {
          port: (this.options.sse as unknown).port
        }
      });
      log.agent(
        `MCP Server started with HTTP Stream transport (SSE fallback) on port ${(this.options.sse as unknown).port}`
      );
    } else if ((this.options as unknown).transportType === "httpStream") {
      await this.fastmcp.start({
        transportType: "httpStream",
        httpStream: {
          port: (this.options.httpStream as unknown).port
        }
      });
      log.agent(
        `MCP Server started with HTTP Stream transport on port ${(this.options.httpStream as unknown).port}`
      );
    } else {
      throw new Error(`Unsupported transport type: ${(this.options as unknown).transportType}`);
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
