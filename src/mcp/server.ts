import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "../utils/logger";
import type { ProjectContext } from "../types/project";
import { createProjectContextFromCwd } from "../types/project";
import { getErrorMessage } from "../errors/index";
import { StalenessDetector } from "./staleness-detector";
import { createDiagnosticCapture, type DiagnosticCapture } from "./diagnostic-capture";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { resolveAgentId } from "../domain/agent-identity/resolve";
import type { RequestExtras } from "../domain/agent-identity/layer2";
import type { AppContainerInterface } from "../composition/types";

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

  /**
   * DI container for accessing services (e.g., sessionProvider for agentId writes).
   * Provided by the MCP start command after tool registration.
   */
  container?: AppContainerInterface;
}

// Tool definitions for MCP server
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: object;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  spec?: string;
  handler: (uri: string) => Promise<unknown>;
}

interface PromptDefinition {
  name: string;
  description?: string;
  spec?: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Return the standard MCP server capabilities object used by both the shared server
 * (stdio mode) and per-session servers (HTTP mode).  Centralised here so that any
 * capability additions are automatically applied to all server instances.
 */
function createServerCapabilities() {
  return {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      logging: {},
    },
  } as const;
}

/**
 * MinskyMCPServer is the main class for the Minsky MCP server
 * It handles the MCP protocol communication and tool registration using the official SDK
 */
export class MinskyMCPServer {
  private server: Server;
  // Only assigned in stdio mode. HTTP mode creates per-session transports in handleHttpPost.
  private transport?: StdioServerTransport;
  private options: MinskyMCPServerOptions & {
    name: string;
    version: string;
    transportType: MCPTransportType;
  };
  private projectContext: ProjectContext;
  private tools: Map<string, ToolDefinition> = new Map();
  private resources: Map<string, ResourceDefinition> = new Map();
  private prompts: Map<string, PromptDefinition> = new Map();
  private stalenessDetector: StalenessDetector;
  private diag: DiagnosticCapture;
  private container: AppContainerInterface | undefined;

  // For HTTP transport: map sessionId to {server, transport} pairs for multiple clients
  private httpSessions: Map<string, { server: Server; transport: StreamableHTTPServerTransport }> =
    new Map();

  // Graceful shutdown tracking
  private inFlightRequests = new Map<number, number>();
  private draining = false;
  private nextRequestId = 0;

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

    // DI container for service access (e.g. sessionProvider for agentId writes)
    this.container = options.container;

    // Initialize staleness detector to warn when server code is outdated
    this.stalenessDetector = new StalenessDetector(
      this.projectContext.repositoryPath || process.cwd()
    );

    // mt#953 — agent identity research diagnostic capture (env-gated)
    this.diag = createDiagnosticCapture();
    this.diag.captureProcess();

    // Create server instance
    this.server = new Server(
      {
        name: this.options.name,
        version: this.options.version,
      },
      createServerCapabilities()
    );

    this.diag.captureInit(this.server);

    // Create transport based on configuration
    if (this.options.transportType === "stdio") {
      this.transport = new StdioServerTransport();
      log.debug("Created stdio transport");
      // Set up request handlers on the shared server (stdio mode only).
      // HTTP mode creates per-session servers in handleHttpPost; the shared
      // server is never connected in that mode so registering handlers on it
      // would be misleading and waste memory.
      this.setupRequestHandlers(this.server);
    } else {
      log.debug("HTTP transport mode - transports will be created on-demand per session");
    }

    log.systemDebug(
      `[MCP] Server instance created with transport type: ${this.options.transportType}`
    );
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
        this.diag.captureRequest(
          "http/post",
          { headers: req.headers, body: req.body },
          { sessionId }
        );
        await this.handleHttpPost(req, res, sessionId);
      } else if (req.method === "GET") {
        this.diag.captureRequest("http/get", { headers: req.headers }, { sessionId });
        await this.handleHttpGet(req, res, sessionId);
      } else {
        res.status(405).set("Allow", "GET, POST").send("Method Not Allowed");
      }
    } catch (error) {
      log.error("Error handling HTTP request", { error: getErrorMessage(error) });
      res.status(500).json({
        error: "Internal server error",
        message: getErrorMessage(error),
      });
    }
  }

  /**
   * Handle HTTP POST requests - main MCP message handling
   */
  private async handleHttpPost(req: Request, res: Response, sessionId?: string): Promise<void> {
    // Fail loudly if upstream JSON body middleware is missing. The
    // initialize-detection branch below depends on req.body being a parsed
    // JSON object or array; a silent 400 here would look like a protocol
    // violation instead of a deployment misconfiguration.
    if (req.body === undefined) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message:
            "Internal error: request body not parsed. HTTP transport requires a JSON body parser (e.g. express.json()) installed before handleHttpRequest.",
        },
        id: null,
      });
      return;
    }

    // Reuse existing session if we have a valid session ID
    if (sessionId && this.httpSessions.has(sessionId)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const { transport } = this.httpSessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session: only allow if this is an initialize request (single or batch)
    const bodyIsInitialize =
      isInitializeRequest(req.body) ||
      (Array.isArray(req.body) && req.body.some((item: unknown) => isInitializeRequest(item)));
    if (!sessionId && bodyIsInitialize) {
      // Create a fresh Server instance for this session
      const sessionServer = new Server(
        { name: this.options.name, version: this.options.version },
        createServerCapabilities()
      );
      this.setupRequestHandlers(sessionServer);

      let sessionInitialized = false;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessionInitialized = true;
          this.httpSessions.set(id, { server: sessionServer, transport });
          log.debug("HTTP session initialized", { sessionId: id });
        },
        onsessionclosed: async (id) => {
          const pair = this.httpSessions.get(id);
          this.httpSessions.delete(id);
          log.debug("HTTP session closed", { sessionId: id });
          if (pair) {
            try {
              await pair.server.close();
            } catch (err) {
              log.warn("Error closing per-session Server on session close", {
                sessionId: id,
                error: getErrorMessage(err),
              });
            }
          }
        },
      });

      await sessionServer.connect(transport);
      try {
        await transport.handleRequest(req, res, req.body);
      } finally {
        if (!sessionInitialized) {
          // Initialize failed before onsessioninitialized fired — clean up the orphan pair
          try {
            await transport.close();
          } catch (err) {
            log.warn("Error closing orphan transport after failed initialize", {
              error: getErrorMessage(err),
            });
          }
          try {
            await sessionServer.close();
          } catch (err) {
            log.warn("Error closing orphan sessionServer after failed initialize", {
              error: getErrorMessage(err),
            });
          }
        }
      }
      return;
    }

    // All other cases: reject with JSON-RPC error
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid Request: missing or unknown session id" },
      id: null,
    });
  }

  /**
   * Handle HTTP GET requests - SSE streaming
   */
  private async handleHttpGet(req: Request, res: Response, sessionId?: string): Promise<void> {
    if (!sessionId || !this.httpSessions.has(sessionId)) {
      // Return 405 Method Not Allowed if no SSE stream available
      res.status(405).set("Allow", "POST").send("Method Not Allowed");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { transport } = this.httpSessions.get(sessionId)!;
    await transport.handleRequest(req, res);

    log.debug("Established SSE stream", { sessionId });
  }

  /**
   * Set up request handlers for tools, resources, and prompts on the given server instance.
   * Accepts the server as a parameter so it can be applied to per-session Server instances.
   * Closures capture `this` fields (tools, resources, prompts, stalenessDetector, diag, etc.).
   */
  private setupRequestHandlers(server: Server): void {
    // List tools
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      this.diag.captureRequest("tools/list", request, extra);
      return {
        tools: Array.from(this.tools.values()).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema || {},
        })),
      };
    });

    // Call tool
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      this.diag.captureRequest("tools/call", request, extra);
      if (this.draining) {
        throw new Error("Server is shutting down");
      }

      const trackingId = this.nextRequestId++;
      this.inFlightRequests.set(trackingId, Date.now());

      // Resolve agentId once per tool call — used for last-touched-by semantics
      const agentId = this.resolveCallerAgentId(extra as RequestExtras | undefined);

      try {
        const tool = this.tools.get(request.params.name);
        if (!tool) {
          throw new Error(`Tool '${request.params.name}' not found`);
        }

        try {
          const result = await tool.handler(request.params.arguments || {});

          // Write agentId to any touched session record (fire-and-forget, non-blocking)
          this.writeAgentIdToSession(request.params.arguments || {}, agentId).catch((err) => {
            log.debug("agentId session update failed (non-blocking)", {
              error: getErrorMessage(err),
              tool: request.params.name,
            });
          });

          // Convert result to proper MCP tool response format
          let responseText: string;

          if (typeof result === "string") {
            responseText = result;
          } else if (Array.isArray(result)) {
            responseText = JSON.stringify(result, null, 2);
          } else if (typeof result === "object" && result !== null) {
            responseText = JSON.stringify(result, null, 2);
          } else {
            responseText = String(result);
          }

          // Return MCP-compliant tool response
          return {
            content: [
              {
                type: "text",
                text: responseText + (this.stalenessDetector.getStaleWarning() ?? ""),
              },
            ],
          };
        } catch (error) {
          log.error("Tool execution failed", {
            tool: request.params.name,
            error: getErrorMessage(error),
          });
          const staleWarning = this.stalenessDetector.getStaleWarning();
          const stalePrefix = staleWarning
            ? `🚫 BLOCKING: MCP server is stale — reconnect with /mcp before retrying. ${staleWarning.trim()}\n\n`
            : "";
          throw new Error(`${stalePrefix}Tool execution failed: ${getErrorMessage(error)}`);
        }
      } finally {
        this.inFlightRequests.delete(trackingId);
      }
    });

    // List resources
    server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
      this.diag.captureRequest("resources/list", request, extra);
      return {
        resources: Array.from(this.resources.values()).map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
        })),
      };
    });

    // Read resource
    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      this.diag.captureRequest("resources/read", request, extra);
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
          error: getErrorMessage(error),
        });
        throw new Error(`Resource read failed: ${getErrorMessage(error)}`);
      }
    });

    // List prompts
    server.setRequestHandler(ListPromptsRequestSchema, async (request, extra) => {
      this.diag.captureRequest("prompts/list", request, extra);
      return {
        prompts: Array.from(this.prompts.values()).map((prompt) => ({
          name: prompt.name,
          description: prompt.description,
        })),
      };
    });

    // Get prompt
    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      this.diag.captureRequest("prompts/get", request, extra);
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
          error: getErrorMessage(error),
        });
        throw new Error(`Prompt generation failed: ${getErrorMessage(error)}`);
      }
    });
  }

  /**
   * Set (or replace) the DI container after construction.
   * Called from start-command.ts after registerAllTools() completes.
   */
  setContainer(container: AppContainerInterface): void {
    this.container = container;
  }

  /**
   * Resolve the caller's agentId from MCP request extras.
   * Uses the priority resolver: Layer 2 (_meta declared) > Layer 1 (ascribed).
   * Reads clientInfo from the underlying SDK server for Layer 1 kind normalization.
   */
  private resolveCallerAgentId(extras: RequestExtras | undefined): string {
    let clientInfoName: string | undefined;
    try {
      const clientVersion = this.server.getClientVersion();
      clientInfoName = (clientVersion as { name?: string })?.name;
    } catch {
      // getClientVersion() may throw if called before initialize completes
    }
    return resolveAgentId({
      extras,
      clientInfo: clientInfoName ? { name: clientInfoName } : undefined,
    });
  }

  /**
   * Write the resolved agentId to the session record for any session touched by this tool call.
   * Implements last-touched-by semantics — every session mutation updates agentId.
   *
   * Session identifier extraction priority:
   *   1. args.session / args.sessionId  — direct session name
   *   2. args.task / args.taskId        — look up session by task id
   *
   * This runs fire-and-forget (caller catches errors). Failures are logged at debug level
   * and never surface to the MCP caller — identity tracking is best-effort.
   */
  private async writeAgentIdToSession(
    args: Record<string, unknown>,
    agentId: string
  ): Promise<void> {
    if (!this.container) return;

    // Extract session name from args
    const sessionName =
      (typeof args.session === "string" ? args.session : undefined) ||
      (typeof args.sessionId === "string" ? args.sessionId : undefined);

    if (sessionName) {
      await this.updateSessionAgentId(sessionName, agentId);
      return;
    }

    // Fall back to task-based lookup
    const taskId =
      (typeof args.task === "string" ? args.task : undefined) ||
      (typeof args.taskId === "string" ? args.taskId : undefined);

    if (taskId && this.container.has("sessionProvider")) {
      const sessionProvider = this.container.get(
        "sessionProvider"
      ) as import("../domain/session/types").SessionProviderInterface;
      // Normalize taskId: strip "mt#" prefix to match storage format
      const storageTaskId = taskId.replace(/^mt#/i, "");
      const record = await sessionProvider.getSessionByTaskId(storageTaskId);
      if (record) {
        await this.updateSessionAgentId(record.session, agentId);
      }
    }
  }

  /**
   * Call sessionProvider.updateSession() to write agentId to a session record.
   */
  private async updateSessionAgentId(sessionName: string, agentId: string): Promise<void> {
    if (!this.container?.has("sessionProvider")) return;
    const sessionProvider = this.container.get(
      "sessionProvider"
    ) as import("../domain/session/types").SessionProviderInterface;
    await sessionProvider.updateSession(sessionName, { agentId });
    log.debug("agentId written to session record", { session: sessionName, agentId });
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
      log.systemDebug("[MCP] Starting server initialization");
      if (this.options.transportType === "stdio") {
        if (!this.transport) {
          throw new Error("stdio transport not initialized");
        }
        log.systemDebug("[MCP] Connecting to stdio transport");
        await this.server.connect(this.transport);
        log.cli("Minsky MCP Server started with stdio transport");
        log.systemDebug("[MCP] Stdio transport connected successfully");
      } else {
        // For HTTP transport, we don't connect here since transports are created on-demand
        const httpConfig = this.options.httpConfig || {};
        const host = httpConfig.host || "localhost";
        const port = httpConfig.port || 3000;
        log.cli(`Minsky MCP Server ready for HTTP transport (${host}:${port})`);
      }

      // Debug log of registered items
      log.debug("MCP Server registered items", {
        transportType: this.options.transportType,
        httpConfig: this.options.transportType === "http" ? this.options.httpConfig : undefined,
        toolCount: this.tools.size,
        resourceCount: this.resources.size,
        promptCount: this.prompts.size,
      });

      log.systemDebug("[MCP] Server start completed successfully");
    } catch (error) {
      log.error("Failed to start MCP server", { error: getErrorMessage(error) });
      log.systemDebug(`[MCP] Server start failed: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * Close the server and cleanup resources
   */
  async close(): Promise<void> {
    try {
      if (this.options.transportType === "http") {
        // Close all HTTP session {server, transport} pairs
        for (const [sessionId, { server, transport }] of this.httpSessions.entries()) {
          try {
            await transport.close();
            await server.close();
            log.debug("Closed HTTP session", { sessionId });
          } catch (error) {
            log.warn("Error closing HTTP session", {
              sessionId,
              error: getErrorMessage(error),
            });
          }
        }
        this.httpSessions.clear();
      }

      await this.server.close();
      log.debug("MCP Server closed");
    } catch (error) {
      log.error("Error closing MCP server", { error: getErrorMessage(error) });
      throw error;
    }
  }

  /**
   * Gracefully drain in-flight requests and then close the server.
   * New tool calls are rejected while draining. Waits up to 5 seconds for
   * all in-flight requests to complete before closing.
   */
  async drain(): Promise<void> {
    this.draining = true;
    const count = this.inFlightRequests.size;
    log.debug("MCP Server draining", { inFlightCount: count });

    const POLL_INTERVAL_MS = 100;
    const TIMEOUT_MS = 5000;
    const start = Date.now();

    await new Promise<void>((resolve) => {
      const poll = () => {
        if (this.inFlightRequests.size === 0) {
          log.debug("MCP Server drain complete — all requests finished");
          resolve();
          return;
        }
        if (Date.now() - start >= TIMEOUT_MS) {
          log.warn("MCP Server drain timed out", {
            remainingRequests: this.inFlightRequests.size,
          });
          resolve();
          return;
        }
        setTimeout(poll, POLL_INTERVAL_MS);
      };
      poll();
    });

    await this.close();
  }

  /**
   * Return the number of currently in-flight tool call requests.
   */
  getInFlightCount(): number {
    return this.inFlightRequests.size;
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

  /**
   * Get the registered tools
   */
  getTools(): Map<string, ToolDefinition> {
    return this.tools;
  }

  /**
   * Get the registered resources
   */
  getResources(): Map<string, ResourceDefinition> {
    return this.resources;
  }

  /**
   * Get the registered prompts
   */
  getPrompts(): Map<string, PromptDefinition> {
    return this.prompts;
  }
}
