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
  private stalenessDetector: StalenessDetector;
  private diag: DiagnosticCapture;
  private container: AppContainerInterface | undefined;

  // For HTTP transport: map sessionId → {server, transport, lastActiveAt}.
  // Each MCP session owns its own Server instance because the SDK's Server
  // class binds 1:1 with a Transport and rejects a second connect().
  // `lastActiveAt` feeds the idle-timeout reaper so abandoned sessions
  // (client POSTed initialize but never closed) don't accumulate indefinitely.
  private httpSessions: Map<
    string,
    { server: Server; transport: StreamableHTTPServerTransport; lastActiveAt: number }
  > = new Map();

  // Idle-timeout reaper for HTTP sessions. A client can POST initialize, get a
  // sessionId, and never call close() — leaving the Server+Transport pair
  // pinned in memory. The reaper periodically drops sessions whose
  // lastActiveAt is older than SESSION_IDLE_TIMEOUT_MS. Timeout is deliberately
  // generous so long-running tool calls / SSE streams aren't killed mid-flight
  // — lastActiveAt is also refreshed on every transport.onmessage so any
  // client→server protocol traffic counts as activity. Pure server→client SSE
  // streams with no client traffic for the full timeout window will still be
  // reaped; tune MINSKY_MCP_SESSION_IDLE_TIMEOUT_MS (milliseconds) for workloads
  // with very long-running streams.
  private sessionReaperTimer: ReturnType<typeof setInterval> | null = null;
  private readonly SESSION_IDLE_TIMEOUT_MS: number =
    Number.parseInt(process.env.MINSKY_MCP_SESSION_IDLE_TIMEOUT_MS ?? "", 10) || 2 * 60 * 60 * 1000;
  private readonly SESSION_REAPER_INTERVAL_MS = 60 * 1000;

  // Graceful shutdown tracking
  private inFlightRequests = new Map<number, number>();
  private draining = false;
  private nextRequestId = 0;

  // Staleness signal tracking
  private hasTriggeredStaleSignal = false;
  /** Indirection for process.exit so tests can intercept without spawning a process. */
  private exit = (code: number) => process.exit(code);

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

    // Create the primary server instance. For stdio, this is THE server. For
    // HTTP, each session creates an additional one via createConfiguredServer();
    // this instance is never connected to a transport in HTTP mode.
    this.server = this.createConfiguredServer();

    // Create transport based on configuration
    if (this.options.transportType === "stdio") {
      this.transport = new StdioServerTransport();
      log.debug("Created stdio transport");
    } else {
      // For HTTP transport, we'll create transports on-demand in handleHttpRequest
      // This is a placeholder transport that won't be used
      this.transport = new StdioServerTransport();
      log.debug("HTTP transport mode - transports will be created on-demand");

      // Start the idle-session reaper. Cleared in close() to let the process
      // exit. Using an unref'd interval so tests that forget to close() don't
      // pin the event loop.
      this.sessionReaperTimer = setInterval(
        () => void this.reapIdleSessions(),
        this.SESSION_REAPER_INTERVAL_MS
      );
      if (typeof this.sessionReaperTimer.unref === "function") {
        this.sessionReaperTimer.unref();
      }
    }

    log.systemDebug(
      `[MCP] Server instance created with transport type: ${this.options.transportType}`
    );
  }

  /**
   * Construct a new Server with all request handlers and diagnostic capture
   * wired up. Each HTTP session gets its own instance; stdio uses the singleton
   * created in the constructor. Tools/resources/prompts are owned by
   * MinskyMCPServer and shared across all Server instances via closures in the
   * registered handlers.
   */
  private createConfiguredServer(): Server {
    const server = new Server(
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
        instructions:
          "You are connected to the Minsky MCP server. If a tool result or error references stale source code, run /mcp to reconnect minsky and pick up the latest server build.",
      }
    );
    this.diag.captureInit(server);
    this.setupRequestHandlers(server);
    return server;
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
    // Guard: body-parser middleware must be installed before this handler.
    // Without it req.body is undefined, and downstream isInitializeRequest(undefined)
    // returns false — causing a confusing protocol-violation error instead of a clear
    // deployment misconfiguration message.
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

    let session: { server: Server; transport: StreamableHTTPServerTransport; lastActiveAt: number };

    // Reuse existing session if we have a session ID
    if (sessionId && this.httpSessions.has(sessionId)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      session = this.httpSessions.get(sessionId)!;
      session.lastActiveAt = Date.now();
    } else if (sessionId && !this.httpSessions.has(sessionId)) {
      // Session ID provided but not found — reject with 404 JSON-RPC -32001
      // "Session not found". This matches the MCP Streamable HTTP spec and the
      // SDK's own webStandardStreamableHttp behavior: the session resource does
      // not exist on this instance (e.g. stale ID after a restart). 404 tells
      // compliant clients the condition is retryable via a fresh initialize.
      res.status(404).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Session not found",
        },
        id: null,
      });
      return;
    } else {
      // No session ID: only accept initialize requests (or batches containing one).
      // Any other request without a session ID is a protocol violation — the client
      // must start with an initialize before sending tool calls.
      const bodyIsInitialize =
        isInitializeRequest(req.body) ||
        (Array.isArray(req.body) && req.body.some((msg) => isInitializeRequest(msg)));

      if (!bodyIsInitialize) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message: "Invalid Request: first request must be initialize",
          },
          id: null,
        });
        return;
      }

      // New session: each HTTP session gets its own Server instance because
      // the SDK's Server binds 1:1 with a Transport. A singleton Server across
      // sessions rejects every connect() past the first.
      const server = this.createConfiguredServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // Connect server to its dedicated transport first, so any onclose /
      // onmessage handlers the SDK installs during connect() are captured
      // below when we chain our own.
      await server.connect(transport);
      const entry: {
        server: Server;
        transport: StreamableHTTPServerTransport;
        lastActiveAt: number;
      } = { server, transport, lastActiveAt: Date.now() };

      // Register onclose cleanup: drop the entry from httpSessions. Server
      // closure is owned by whoever initiated the close (reaper / MinskyMCPServer.close
      // / external signal) — this handler deliberately does NOT call server.close()
      // to avoid double-close paths when the reaper or close() initiates the transport
      // close and then expects to own server lifecycle. If a natural transport close
      // occurs (client disconnect) with no initiator, the Server is also torn down
      // here.
      const prevOnclose = transport.onclose;
      let externalInitiator = false;
      (entry as typeof entry & { markExternalClose: () => void }).markExternalClose = () => {
        externalInitiator = true;
      };
      transport.onclose = () => {
        try {
          prevOnclose?.();
        } finally {
          const closedId = transport.sessionId;
          if (closedId && this.httpSessions.has(closedId)) {
            this.httpSessions.delete(closedId);
            log.debug("HTTP session closed and cleaned up", { sessionId: closedId });
          }
          // Only close the Server if no external initiator claimed ownership —
          // the initiator (reaper / MinskyMCPServer.close) is responsible for
          // closing the Server directly.
          if (!externalInitiator) {
            server.close().catch((error) => {
              log.warn("Error closing per-session MCP Server", {
                sessionId: closedId,
                error: getErrorMessage(error),
              });
            });
          }
        }
      };

      // Hook onmessage to (a) refresh lastActiveAt on any client→server
      // protocol traffic and (b) register the session in httpSessions the
      // moment transport.sessionId is assigned. Registering here (rather
      // than after handleRequest returns) closes the POST→GET race window:
      // a client racing an SSE GET immediately after receiving the initialize
      // response finds the session already in the map.
      const prevOnmessage = transport.onmessage;
      transport.onmessage = (message, extra) => {
        entry.lastActiveAt = Date.now();
        const id = transport.sessionId;
        if (id && !this.httpSessions.has(id)) {
          this.httpSessions.set(id, entry);
          log.debug("Registered new HTTP session via onmessage", { sessionId: id });
        }
        prevOnmessage?.(message, extra);
      };

      session = entry;
    }

    // Handle the request
    await session.transport.handleRequest(req, res, req.body);

    // Defensive registration: under normal SDK behavior, onmessage already
    // populated httpSessions before handleRequest returned. If the transport
    // assigned a sessionId without firing onmessage for any reason, this
    // catches that path.
    if (session.transport.sessionId && !this.httpSessions.has(session.transport.sessionId)) {
      this.httpSessions.set(session.transport.sessionId, session);
      log.debug("Registered new HTTP session (post-handle fallback)", {
        sessionId: session.transport.sessionId,
      });
    }
  }

  /**
   * Handle HTTP GET requests - SSE streaming
   */
  private async handleHttpGet(req: Request, res: Response, sessionId?: string): Promise<void> {
    if (!sessionId || !this.httpSessions.has(sessionId)) {
      // Return 404 Not Found — GET is a valid method on this endpoint, but only
      // when a session exists. A missing or unknown session-id means the resource
      // does not exist, not that the method is disallowed. Plain text body (no
      // JSON-RPC envelope) because SSE GET is a streaming connection, not a
      // JSON-RPC message exchange. Explicit text/plain Content-Type to match
      // documented behavior — Express defaults string bodies to text/html.
      res.status(404).type("text/plain").send("Session not found");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const session = this.httpSessions.get(sessionId)!;
    session.lastActiveAt = Date.now();
    await session.transport.handleRequest(req, res);

    log.debug("Established SSE stream", { sessionId });
  }

  /**
   * Sweep httpSessions for entries whose lastActiveAt is older than
   * SESSION_IDLE_TIMEOUT_MS. Closes the transport and paired Server for each
   * idle entry. Runs on an interval scheduled in the HTTP-mode constructor.
   */
  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    const idle: string[] = [];
    for (const [id, session] of this.httpSessions.entries()) {
      if (now - session.lastActiveAt > this.SESSION_IDLE_TIMEOUT_MS) {
        idle.push(id);
      }
    }
    for (const id of idle) {
      const session = this.httpSessions.get(id);
      if (!session) continue;
      // Mark external initiator so onclose doesn't also call server.close().
      (session as typeof session & { markExternalClose?: () => void }).markExternalClose?.();
      this.httpSessions.delete(id);
      const idleMinutes = Math.floor((now - session.lastActiveAt) / 60_000);
      log.debug("Reaping idle HTTP session", { sessionId: id, idleMinutes });
      try {
        await session.transport.close();
      } catch (error) {
        log.warn("Error closing idle HTTP transport", {
          sessionId: id,
          error: getErrorMessage(error),
        });
      }
      try {
        await session.server.close();
      } catch (error) {
        log.warn("Error closing idle per-session MCP Server", {
          sessionId: id,
          error: getErrorMessage(error),
        });
      }
    }
  }

  /**
   * Set up request handlers for tools, resources, and prompts on the given
   * Server instance. Called once per Server — once from the constructor for
   * stdio, and once per HTTP session via createConfiguredServer.
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
      const agentId = this.resolveCallerAgentId(server, extra as RequestExtras | undefined);

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

          // Check for staleness after building the response — trigger fires
          // notification + clean exit after the current response is returned.
          const staleWarning = this.stalenessDetector.getStaleWarning();
          if (staleWarning !== null && !this.hasTriggeredStaleSignal) {
            this.triggerStaleSignal(server);
          }

          // Return MCP-compliant tool response
          return {
            content: [
              {
                type: "text",
                text: responseText,
              },
            ],
          };
        } catch (error) {
          log.error("Tool execution failed", {
            tool: request.params.name,
            error: getErrorMessage(error),
          });

          // Check for staleness on error path too — trigger fires notification
          // + clean exit after the error is thrown to the caller.
          const staleWarning = this.stalenessDetector.getStaleWarning();
          if (staleWarning !== null && !this.hasTriggeredStaleSignal) {
            this.triggerStaleSignal(server);
          }

          throw new Error(`Tool execution failed: ${getErrorMessage(error)}`);
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
   *
   * `server` is the Server instance handling this specific request — for HTTP,
   * each session has its own Server and thus its own clientVersion.
   */
  private resolveCallerAgentId(server: Server, extras: RequestExtras | undefined): string {
    let clientInfoName: string | undefined;
    try {
      const clientVersion = server.getClientVersion();
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
        await this.updateSessionAgentId(record.sessionId, agentId);
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
   * Emit a notifications/message at level=alert and schedule a clean process.exit(0)
   * after 200ms to give the notification time to flush to the client.
   *
   * Only fires once per process lifetime (guarded by hasTriggeredStaleSignal).
   * The tool call's response/error is already returned to the caller by the
   * time this method runs — the 200ms delay is the spike-derived buffer from
   * mt#1315 (response → exit measured at ~102ms at delayMs=100).
   */
  private triggerStaleSignal(server: Server): void {
    if (this.hasTriggeredStaleSignal) return;
    this.hasTriggeredStaleSignal = true;

    // Extract 8-char head slices from the detector's cached stale message.
    // The detector already has startupHead/currentHead as private fields used
    // to build staleMessage; we re-derive them by reading the stale message
    // text rather than adding new public surface to StalenessDetector.
    const staleMessage = this.stalenessDetector.getStaleWarning() ?? "";
    const startupHeadMatch = /commit ([0-9a-f]{7,8})/i.exec(staleMessage);
    const currentHeadMatch = /now at ([0-9a-f]{7,8})/i.exec(staleMessage);
    const startupHead = startupHeadMatch ? startupHeadMatch[1] : "unknown";
    const currentHead = currentHeadMatch ? currentHeadMatch[1] : "unknown";

    server
      .sendLoggingMessage({
        level: "alert",
        logger: "minsky-staleness",
        data: {
          text: "Minsky source has changed since this server started; reconnect via /mcp.",
          startupHead,
          currentHead,
        },
      })
      .catch((err) => {
        log.debug("Failed to send staleness notification (non-blocking)", {
          error: getErrorMessage(err),
        });
      });

    setTimeout(() => this.exit(0), 200);
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
      if (this.sessionReaperTimer) {
        clearInterval(this.sessionReaperTimer);
        this.sessionReaperTimer = null;
      }

      if (this.options.transportType === "http") {
        // Close all HTTP sessions (transport + per-session Server). Mark
        // external-initiator so each session's onclose handler doesn't also
        // call server.close().
        for (const [sessionId, entry] of this.httpSessions.entries()) {
          (entry as typeof entry & { markExternalClose?: () => void }).markExternalClose?.();
          try {
            await entry.transport.close();
            log.debug("Closed HTTP transport", { sessionId });
          } catch (error) {
            log.warn("Error closing HTTP transport", {
              sessionId,
              error: getErrorMessage(error),
            });
          }
          try {
            await entry.server.close();
            log.debug("Closed per-session MCP Server", { sessionId });
          } catch (error) {
            log.warn("Error closing per-session MCP Server", {
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
