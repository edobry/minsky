import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { 
  StreamableHTTPServerTransport,
  StreamableHTTPServerTransportOptions
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "../utils/logger";
import type { ProjectContext } from "../types/project";
import { createProjectContextFromCwd } from "../types/project";
import { getErrorMessage } from "../errors/index";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";

/**
 * Transport type for MCP server
 */
export type MCPTransportType = "stdio" | "http";

/**
 * HTTP transport configuration
 */
export interface MCPHttpTransportConfig {
  /** Port to listen on @default 3000 */
  port?: number;
  /** Host to bind to @default localhost */
  host?: string;
  /** HTTP endpoint path @default /mcp */
  endpoint?: string;
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
   * @default "1.0.0"
   */
  version?: string;

  /**
   * Project context containing repository information
   * Used for operations that require repository context
   * @default Context created from process.cwd()
   */
  projectContext?: ProjectContext;

  /**
   * Transport type to use
   * @default "stdio"
   */
  transportType?: MCPTransportType;

  /**
   * HTTP transport configuration (required if transportType is "http")
   */
  httpConfig?: MCPHttpTransportConfig;
}

// Tool definitions for MCP server
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: object;
  handler: (args: any) => Promise<any>;
}

interface ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  handler: (uri: string) => Promise<any>;
}

interface PromptDefinition {
  name: string;
  description?: string;
  handler: (args: any) => Promise<any>;
}

/**
 * MinskyMCPServer is the main class for the Minsky MCP server
 * It handles the MCP protocol communication and tool registration using the official SDK
 */
export class MinskyMCPServer {
  private server: Server;
  private transport: StdioServerTransport | StreamableHTTPServerTransport;
  private options: MinskyMCPServerOptions & { 
    name: string; 
    version: string; 
    transportType: MCPTransportType;
  };
  private projectContext: ProjectContext;
  private tools: Map<string, ToolDefinition> = new Map();
  private resources: Map<string, ResourceDefinition> = new Map();
  private prompts: Map<string, PromptDefinition> = new Map();

  // For HTTP transport: map sessionId to transport for multiple clients
  private httpTransports: Map<string, StreamableHTTPServerTransport> = new Map();

  /**
   * Create a new MinskyMCPServer
   * @param options Configuration options for the server
   */
  constructor(options: MinskyMCPServerOptions = {}) {
    // Set defaults
    this.options = {
      name: "Minsky MCP Server",
      version: "1.0.0",
      transportType: "stdio",
      ...options,
    };

    // Set up project context
    this.projectContext = options.projectContext || createProjectContextFromCwd();

    // Create server instance
    this.server = new Server(
      {
        name: this.options.name,
        version: this.options.version,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          logging: {},
        },
      }
    );

    // Create transport based on configuration
    if (this.options.transportType === "stdio") {
      this.transport = new StdioServerTransport();
      log.debug("Created stdio transport");
    } else {
      // For HTTP transport, we'll create transports on-demand in handleHttpRequest
      // This is a placeholder transport that won't be used
      this.transport = new StdioServerTransport();
      log.debug("HTTP transport mode - transports will be created on-demand");
    }

    // Set up request handlers
    this.setupRequestHandlers();
  }

  /**
   * Handle HTTP requests for StreamableHTTP transport
   * This handles both GET and POST requests on a single endpoint
   */
  async handleHttpRequest(req: Request, res: Response): Promise<void> {
    if (this.options.transportType !== "http") {
      res.status(400).json({ error: "Server not configured for HTTP transport" });
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        await this.handleHttpPost(req, res, sessionId);
      } else if (req.method === "GET") {
        await this.handleHttpGet(req, res, sessionId);
      } else {
        res.status(405).set("Allow", "GET, POST").send("Method Not Allowed");
      }
    } catch (error) {
      log.error("Error handling HTTP request", { error: getErrorMessage(error) });
      res.status(500).json({ 
        error: "Internal server error",
        message: getErrorMessage(error)
      });
    }
  }

  /**
   * Handle HTTP POST requests - main MCP message handling
   */
  private async handleHttpPost(req: Request, res: Response, sessionId?: string): Promise<void> {
    let transport: StreamableHTTPServerTransport;

    // Reuse existing transport if we have a session ID
    if (sessionId && this.httpTransports.has(sessionId)) {
      transport = this.httpTransports.get(sessionId)!;
    } else {
      // Create new transport for new session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // Connect server to transport
      await this.server.connect(transport);
      
      log.debug("Created new HTTP transport", { sessionId: transport.sessionId });
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body);

    // Store transport if it has a session ID (only after first request)
    if (transport.sessionId && !this.httpTransports.has(transport.sessionId)) {
      this.httpTransports.set(transport.sessionId, transport);
      log.debug("Stored HTTP transport", { sessionId: transport.sessionId });
    }
  }

  /**
   * Handle HTTP GET requests - SSE streaming
   */
  private async handleHttpGet(req: Request, res: Response, sessionId?: string): Promise<void> {
    if (!sessionId || !this.httpTransports.has(sessionId)) {
      // Return 405 Method Not Allowed if no SSE stream available
      res.status(405).set("Allow", "POST").send("Method Not Allowed");
      return;
    }

    const transport = this.httpTransports.get(sessionId)!;
    await transport.handleRequest(req, res);
    
    log.debug("Established SSE stream", { sessionId });
  }

  /**
   * Set up request handlers for tools, resources, and prompts
   */
  private setupRequestHandlers(): void {
    // List tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Array.from(this.tools.values()).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema || {},
      })),
    }));

    // Call tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = this.tools.get(request.params.name);
      if (!tool) {
        throw new Error(`Tool '${request.params.name}' not found`);
      }

      try {
        const result = await tool.handler(request.params.arguments || {});
        return {
          content: [
            {
              type: "text" as const,
              text: typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        log.error("Tool execution failed", { 
          tool: request.params.name, 
          error: getErrorMessage(error) 
        });
        throw new Error(`Tool execution failed: ${getErrorMessage(error)}`);
      }
    });

    // List resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: Array.from(this.resources.values()).map(resource => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
      })),
    }));

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const resource = this.resources.get(request.params.uri);
      if (!resource) {
        throw new Error(`Resource '${request.params.uri}' not found`);
      }

      try {
        const content = await resource.handler(request.params.uri);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/plain",
              text: typeof content === "string" ? content : JSON.stringify(content),
            },
          ],
        };
      } catch (error) {
        log.error("Resource read failed", { 
          uri: request.params.uri, 
          error: getErrorMessage(error) 
        });
        throw new Error(`Resource read failed: ${getErrorMessage(error)}`);
      }
    });

    // List prompts
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: Array.from(this.prompts.values()).map(prompt => ({
        name: prompt.name,
        description: prompt.description,
      })),
    }));

    // Get prompt
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const prompt = this.prompts.get(request.params.name);
      if (!prompt) {
        throw new Error(`Prompt '${request.params.name}' not found`);
      }

      try {
        const result = await prompt.handler(request.params.arguments || {});
        return {
          description: prompt.description || `Generated prompt: ${prompt.name}`,
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: typeof result === "string" ? result : JSON.stringify(result),
              },
            },
          ],
        };
      } catch (error) {
        log.error("Prompt generation failed", { 
          prompt: request.params.name, 
          error: getErrorMessage(error) 
        });
        throw new Error(`Prompt generation failed: ${getErrorMessage(error)}`);
      }
    });
  }

  /**
   * Add a tool to the server
   */
  addTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    log.debug("Added tool", { name: tool.name });
  }

  /**
   * Add a resource to the server
   */
  addResource(resource: ResourceDefinition): void {
    this.resources.set(resource.uri, resource);
    log.debug("Added resource", { uri: resource.uri });
  }

  /**
   * Add a prompt to the server
   */
  addPrompt(prompt: PromptDefinition): void {
    this.prompts.set(prompt.name, prompt);
    log.debug("Added prompt", { name: prompt.name });
  }

  /**
   * Start the server with the configured transport
   */
  async start(): Promise<void> {
    try {
      if (this.options.transportType === "stdio") {
        await this.server.connect(this.transport);
        log.agent("Minsky MCP Server started with stdio transport");
      } else {
        // For HTTP transport, we don't connect here since transports are created on-demand
        const httpConfig = this.options.httpConfig || {};
        const host = httpConfig.host || "localhost";
        const port = httpConfig.port || 3000;
        log.agent(`Minsky MCP Server ready for HTTP transport (${host}:${port})`);
      }
      
      // Debug log of registered items
      log.debug("MCP Server registered items", {
        transportType: this.options.transportType,
        httpConfig: this.options.transportType === "http" ? this.options.httpConfig : undefined,
        toolCount: this.tools.size,
        resourceCount: this.resources.size,
        promptCount: this.prompts.size,
      });
    } catch (error) {
      log.error("Failed to start MCP server", { error: getErrorMessage(error) });
      throw error;
    }
  }

  /**
   * Close the server and cleanup resources
   */
  async close(): Promise<void> {
    try {
      if (this.options.transportType === "http") {
        // Close all HTTP transports
        for (const [sessionId, transport] of this.httpTransports.entries()) {
          try {
            await transport.close();
            log.debug("Closed HTTP transport", { sessionId });
          } catch (error) {
            log.warn("Error closing HTTP transport", { 
              sessionId, 
              error: getErrorMessage(error) 
            });
          }
        }
        this.httpTransports.clear();
      }
      
      await this.server.close();
      log.debug("MCP Server closed");
    } catch (error) {
      log.error("Error closing MCP server", { error: getErrorMessage(error) });
      throw error;
    }
  }

  /**
   * Check if the server is using HTTP transport
   */
  isHttpTransport(): boolean {
    return this.options.transportType === "http";
  }

  /**
   * Get HTTP transport configuration
   */
  getHttpConfig(): MCPHttpTransportConfig | undefined {
    return this.options.transportType === "http" ? this.options.httpConfig : undefined;
  }

  /**
   * Get project context
   */
  getProjectContext(): ProjectContext {
    return this.projectContext;
  }
}
