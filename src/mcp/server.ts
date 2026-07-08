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
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "@minsky/shared/logger";
import type { ProjectContext } from "../types/project";
import { createProjectContextFromCwd } from "../types/project";
import { getErrorMessage, getErrorMessageWithCause } from "@minsky/domain/errors/index";
import { StalenessDetector } from "./staleness-detector";
import { createDiagnosticCapture, type DiagnosticCapture } from "./diagnostic-capture";
import { toClaudeDesktopName, shouldEmitDesktopAliases } from "./tool-name";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { resolveAgentId } from "@minsky/domain/agent-identity/resolve";
import type { RequestExtras } from "@minsky/domain/agent-identity/layer2";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { MCPClientCapabilityRegistry } from "./client-capabilities";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import { enrichToolResponse } from "./middleware/memory-enrichment";
import {
  enrichWakeResponse,
  type SessionResolver as WakeSessionResolver,
  type WakeServiceSurface,
} from "./middleware/wake-enrichment";
import { DisconnectTracker, STDIO_SESSION_KEY } from "./disconnect-tracker";
import { writeDaemonState } from "./daemon-state";
import type { InitController } from "./init-retry";
import {
  type PresenceClaimRepository,
  normalizeTaskSubjectId,
} from "@minsky/domain/presence/index";

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

  /**
   * MCP client capability registry (mt#1457). When provided, each `Server`
   * instance created by `createConfiguredServer` is registered so the Ask
   * router can detect elicitation-capable connections. HTTP-mode session
   * cleanup paths unregister servers as connections close. Stdio mode
   * registers once for the process lifetime.
   *
   * When undefined (the typical bare-CLI / test path), capability tracking
   * is disabled — the no-op registry in CLI composition suffices for those
   * code paths.
   */
  clientCapabilityRegistry?: MCPClientCapabilityRegistry;

  /**
   * Optional static memory bundle to include in the SDK Server's `instructions`
   * field at construction time. Composed by the MCP start command from the
   * memory store BEFORE this constructor runs (so the bundle is present at
   * every `initialize` handshake without any post-construction mutation).
   *
   * @see mt#1625 — server-side memory injection via MCP `instructions`
   */
  instructions?: string;
}

// Tool definitions for MCP server
/**
 * mt#1751: Tools that demonstrably don't touch DI services — these skip the
 * `initPromise` await in the CallTool handler. Currently covers the three
 * debug commands routed through the shared-command bridge (which doesn't
 * thread the `requiresInit` field). Add to this set, or set
 * `requiresInit: false` on the ToolDefinition directly, when you've verified
 * a tool's handler does not call `container.get(...)` or otherwise depend on
 * a resolved DI service.
 *
 * Tool names are matched against `request.params.name` exactly. The
 * shared-command bridge registers debug tools with **dotted** IDs (e.g.,
 * `debug.listMethods` — see `src/adapters/shared/commands/debug.ts`), and
 * `CommandMapper.normalizeMethodName` (`src/mcp/command-mapper.ts:42`)
 * preserves dots, so the protocol-level tool name keeps the dot. We list
 * the dotted form below. (PR #1063 R3 BLOCKING: prior version used
 * underscore names — `debug_echo` — and the allowlist never matched.)
 */
const DI_FREE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "debug.echo",
  "debug.listMethods",
  "debug.systemInfo",
]);

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: object;
  /**
   * Eager (legacy) handler. At least one of `handler` or `getHandler` must be
   * provided. When both are present, `handler` takes precedence.
   */
  handler?: (args: Record<string, unknown>) => Promise<unknown>;
  /**
   * mt#1792: lazy handler thunk — defers handler-module loading until first
   * invocation. Mutually exclusive with `handler` at registration time: provide
   * EITHER a direct `handler` (eager, legacy form) OR a `getHandler` thunk
   * (lazy form). The CallTool dispatch resolves the thunk on first call and
   * caches the resolved function back onto `handler` for subsequent calls.
   *
   * When both are provided, the legacy `handler` takes precedence and
   * `getHandler` is ignored — backward-compatible coexistence.
   */
  getHandler?: () => Promise<(args: Record<string, unknown>) => Promise<unknown>>;
  /**
   * PR #1103 R1 NON-BLOCKING: in-flight thunk-resolution promise. Set on first
   * call when `getHandler` resolution starts; subsequent concurrent first
   * calls share this promise instead of invoking `getHandler()` again.
   * Cleared on success (resolved value cached on `handler`) and on rejection
   * (so retry can occur). Internal; not part of the registration API.
   */
  __resolving?: Promise<(args: Record<string, unknown>) => Promise<unknown>>;
  /**
   * When true, this tool performs external side effects (e.g. GitHub PR
   * create/edit/merge, force-push, session-update). The server will refuse
   * to execute it when drift is detected (loaded commit !== workspace HEAD).
   * Read-only tools leave this unset or set it to false.
   */
  mutating?: boolean;
  /**
   * mt#1751: when explicitly `false`, this tool does NOT require the DI
   * container to be initialized — the CallTool handler skips the init
   * await for it. Default (unset/`true`) is to await DI init, which is
   * the safe choice for any tool that calls `container.get(...)`.
   *
   * Opt out only for tools that demonstrably do not touch DI services
   * (e.g. `debug_echo`, `debug_listMethods`). Mis-opting-out a tool that
   * does need DI would surface as a "Service ... is not available"
   * runtime error on first call before background init completes.
   */
  requiresInit?: boolean;
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
  /**
   * Memory service for the mt#1588 spike enrichment middleware. Optional —
   * when absent, enrichment middleware is a no-op (the dispatcher behaves
   * identically to pre-mt#1588). Set via `setMemoryService` from the MCP
   * start command after `registerAllTools` resolves the persistence provider.
   */
  private memoryService: MemoryServiceSurface | undefined;
  /**
   * mt#1625 spike: static memory bundle for MCP `instructions` injection.
   * When set, this text is appended to the `instructions` field passed to
   * every SDK `Server` constructor created by `createConfiguredServer`.
   * Passed via the `instructions` constructor option (composed by the MCP
   * start command from the memory store BEFORE this class is instantiated).
   * Stdio mode receives it at constructor time; HTTP per-session Servers
   * read it on each `createConfiguredServer` call.
   */
  private instructionsBundle: string | null | undefined = null;
  /**
   * Wake-pending service for the mt#1661 v0 wake-enrichment middleware. Optional —
   * when absent, the middleware is a no-op. Set via `setWakeService` from the
   * MCP start command after the persistence provider resolves.
   */
  private wakeService: WakeServiceSurface | undefined;
  /**
   * Session resolver paired with `wakeService`. Maps tool-call args to a Minsky
   * session UUID. v0 production resolver maps `args.session`/`args.sessionId`
   * directly and `args.task`/`args.taskId` via session lookup.
   */
  private wakeSessionResolver: WakeSessionResolver | undefined;
  /** Optional capability registry — when set, every Server created in
   * createConfiguredServer is register/unregister-tracked. */
  private clientCapabilityRegistry: MCPClientCapabilityRegistry | undefined;
  /**
   * mt#1751: DI initialization promise. When set via `setInitPromise`, every
   * CallTool dispatch awaits this promise before invoking the tool handler.
   * The MCP `initialize` handshake and `tools/list` do NOT await it (they
   * don't need persistence) — only tool execution does. This lets the server
   * accept the initialize handshake while DI runs in the background.
   *
   * Null in HTTP mode (init runs synchronously via preAction) and in tests
   * that pre-populate the container.
   *
   * mt#1962: superseded by `initController` for the production stdio path —
   * the controller adds demand-driven retry on rejected attempts so a single
   * transient init failure no longer poisons the daemon. `setInitPromise` is
   * retained as the no-retry single-attempt API for tests and any caller
   * that wants the legacy behavior. Exactly one of `initPromise` /
   * `initController` is set at any time — each setter clears the other
   * (symmetric mutual exclusivity).
   */
  private initPromise: Promise<void> | null = null;

  /**
   * mt#1962: DI initialization controller. When set via `setInitController`,
   * CallTool dispatch calls `awaitReady()` instead of awaiting `initPromise`
   * directly. The controller tracks attempt state and re-invokes the
   * underlying initializer on demand (next tool call) when a prior attempt
   * rejected, subject to a backoff cap. Exactly one of `initPromise` /
   * `initController` is set at any time — each setter clears the other
   * (symmetric mutual exclusivity).
   */
  private initController: InitController | null = null;

  /**
   * mt#2562: PresenceClaimRepository for task-grain agent presence.
   * When set, every tool call with args.task/args.taskId fires a
   * session-independent upsertClaim (fire-and-forget). When absent, the
   * write path is a no-op (graceful degradation).
   */
  private presenceClaimRepo: PresenceClaimRepository | undefined;

  // For HTTP transport: map sessionId → {server, transport, lastActiveAt}.
  // Each MCP session owns its own Server instance because the SDK's Server
  // class binds 1:1 with a Transport and rejects a second connect().
  // `lastActiveAt` feeds the idle-timeout reaper so abandoned sessions
  // (client POSTed initialize but never closed) don't accumulate indefinitely.
  private httpSessions: Map<
    string,
    { server: Server; transport: StreamableHTTPServerTransport; lastActiveAt: number }
  > = new Map();

  // Maximum concurrent HTTP sessions. When set, new initialize requests are
  // rejected with 503 Service Unavailable once the cap is reached. Configured
  // via MINSKY_MCP_MAX_SESSIONS env var. Absent or non-positive → no cap.
  private readonly MAX_HTTP_SESSIONS: number | null = null;

  // Retry-After value (seconds) sent with 503 responses when the cap is reached.
  // Configurable via MINSKY_MCP_RETRY_AFTER_SECS env var; defaults to 30.
  private readonly SESSION_CAP_RETRY_AFTER_SECS: number = 30;

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

  /**
   * Disconnect/reconnect event tracker for cadence measurement (mt#1645).
   * Records structured events to `~/.local/state/minsky/mcp-disconnect-log.json`
   * and exposes a summary via `debug.systemInfo`.
   */
  private disconnectTracker: DisconnectTracker;
  /** Indirection for process.exit so tests can intercept without spawning a process. */
  private exit = (code: number) => process.exit(code);

  /**
   * Whether SIGTERM/SIGINT/SIGHUP listeners have been installed in this
   * process. Static because the underlying process is a singleton — multiple
   * MinskyMCPServer instances per process should not double-register
   * listeners. mt#1682.
   */
  private static signalHandlersInstalled = false;

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

    // mt#1457: capability registry for the Ask router. When provided, each
    // Server created via createConfiguredServer is registered.
    this.clientCapabilityRegistry = options.clientCapabilityRegistry;

    // mt#1625: optional static memory bundle for the `instructions` field.
    // Must be set BEFORE createConfiguredServer is called below so the
    // eager-constructed stdio Server picks it up via the SDK constructor.
    this.instructionsBundle = options.instructions;

    // Parse session cap from env var. Non-positive or non-numeric values → no cap.
    const maxSessionsRaw = process.env.MINSKY_MCP_MAX_SESSIONS;
    if (maxSessionsRaw !== undefined && maxSessionsRaw !== "") {
      const parsed = Number.parseInt(maxSessionsRaw, 10);
      this.MAX_HTTP_SESSIONS = parsed > 0 ? parsed : null;
    }

    // Parse Retry-After override (seconds). Falls back to the field default (30).
    const retryAfterRaw = process.env.MINSKY_MCP_RETRY_AFTER_SECS;
    if (retryAfterRaw !== undefined && retryAfterRaw !== "") {
      const parsed = Number.parseInt(retryAfterRaw, 10);
      if (parsed > 0) {
        this.SESSION_CAP_RETRY_AFTER_SECS = parsed;
      }
    }

    // Initialize staleness detector to warn when server code is outdated
    this.stalenessDetector = new StalenessDetector(
      this.projectContext.repositoryPath || process.cwd()
    );

    // mt#1645: disconnect/reconnect cadence tracker. Server name is the
    // MCP server name as configured (e.g. "Minsky MCP Server", "minsky",
    // "minsky-hosted"). Normalised to the short form for readability in logs.
    this.disconnectTracker = DisconnectTracker.getInstance(this.options.name);
    // mt#1682: process_start lifecycle marker. Recorded in the constructor
    // before any tool can be invoked so log readers can count actual server
    // processes (including those that lived <1s and never recorded a
    // disconnect) and correlate disconnects back to their source process.
    this.disconnectTracker.recordProcessStart();
    // mt#1682: install signal handlers that record cause before the natural
    // process exit. Without these, signal-driven shutdowns surface as
    // generic `stdin_close` (because the SDK's onclose fires during stdio
    // teardown), conflating signal kills with harness-initiated closures.
    this.installSignalHandlers();

    // mt#953 — agent identity research diagnostic capture (env-gated)
    this.diag = createDiagnosticCapture();
    this.diag.captureProcess();

    // Create the primary server instance. For stdio, this is THE server. For
    // HTTP, each session creates an additional one via createConfiguredServer();
    // this instance is never connected to a transport in HTTP mode.
    // mt#1705: stdio uses the fixed STDIO_SESSION_KEY. The HTTP-primary instance
    // here also uses STDIO_SESSION_KEY because it is never connected when
    // transportType === "http" (the connected Server instances are created in
    // handleHttpRequest with their own UUIDs).
    this.server = this.createConfiguredServer(STDIO_SESSION_KEY);

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
   * Refuse a mutating tool call when the server source is stale relative to the
   * workspace. Read-only tools (mutating false or unset) pass through.
   *
   * Public so unit tests can exercise the real check without going through the
   * full MCP transport. The dispatcher in createConfiguredServer's
   * setRequestHandler(CallToolRequestSchema, ...) calls this before invoking
   * the registered tool handler, so removing the call site there is the only
   * way to break the gate at the dispatch layer (covered by a separate
   * dispatcher-level test).
   *
   * @throws Error with the loaded vs workspace commits and reconnect guidance
   */
  public checkDriftGate(tool: { mutating?: boolean }): void {
    if (!tool.mutating || !this.stalenessDetector.isCurrentlyStale()) return;
    const staleMessage = this.stalenessDetector.getStaleWarning() ?? "";
    const loadedMatch = /commit ([0-9a-f]{7,8})/i.exec(staleMessage);
    const headMatch = /now at ([0-9a-f]{7,8})/i.exec(staleMessage);
    const loaded = loadedMatch ? loadedMatch[1] : "unknown";
    const head = headMatch ? headMatch[1] : "unknown";
    throw new Error(
      `MCP server is stale relative to workspace (loaded ${loaded}, workspace ${head}). ` +
        `Reconnect via /mcp before retrying mutating operations.`
    );
  }

  /**
   * Construct a new Server with all request handlers and diagnostic capture
   * wired up. Each HTTP session gets its own instance; stdio uses the singleton
   * created in the constructor. Tools/resources/prompts are owned by
   * MinskyMCPServer and shared across all Server instances via closures in the
   * registered handlers.
   *
   * mt#1705: each Server is paired with a `sessionKey` for per-session
   * tool-call tracking. Stdio passes `STDIO_SESSION_KEY` (a fixed constant);
   * HTTP generates a unique UUID for each per-session Server. The key is
   * captured in the CallTool handler closure (so each session's tool calls
   * increment its own counter) and the wireDisconnectHooks chain (so each
   * session's disconnect reads its own counter).
   */
  private createConfiguredServer(sessionKey: string): Server {
    // mt#1625 spike: compose the `instructions` field from the static
    // reconnect note plus the optional memory bundle (when set). The bundle
    // is appended after the operational note so the agent sees the reconnect
    // guidance first, then the memory context.
    const baseInstructions =
      "You are connected to the Minsky MCP server. If a tool result or error references stale source code, run /mcp to reconnect minsky and pick up the latest server build.";
    const instructions = this.instructionsBundle
      ? `${baseInstructions}\n\n${this.instructionsBundle}`
      : baseInstructions;

    const server = new Server(
      {
        name: this.options.name,
        version: this.options.version,
      },
      {
        capabilities: {
          // listChanged: true advertises that the server may emit
          // `notifications/tools/list_changed`. The stdio proxy (mt#2011)
          // emits this notification on inner-server respawn so Claude Code
          // refreshes its tools/list cache without needing `/mcp` reconnect.
          // Per MCP spec, clients SHOULD ignore the notification when the
          // server has not advertised this capability.
          //
          // In direct-start mode (no proxy), the inner server itself does
          // not emit `notifications/tools/list_changed` — Minsky has no
          // in-process tool-set mutation today (PR #1216 R1 NON-BLOCKING 1).
          // The capability advertisement is therefore inert in direct mode.
          // We advertise unconditionally for two reasons: (a) the proxy is
          // the operator-recommended deployment path, and (b) advertising a
          // capability the server can deliver under SOME deployment shape is
          // spec-permissible (the spec frames `listChanged: true` as
          // "server MAY send", not "server WILL always send"). If direct-
          // start emits start to support in-process tool mutation in the
          // future, this declaration is already correct; no change needed.
          tools: { listChanged: true },
          resources: {},
          prompts: {},
          logging: {},
        },
        instructions,
      }
    );
    this.diag.captureInit(server);

    // mt#1457: register with the capability registry so the Ask router can
    // detect this connection's elicitation capability once initialize completes.
    // Capabilities are read live from the SDK Server (no caching), so registering
    // here pre-init is safe — the SDK populates getClientCapabilities() on
    // initialize. HTTP onclose / idle reaper / close() handle unregistration.
    this.clientCapabilityRegistry?.registerServer(server);

    this.setupRequestHandlers(server, sessionKey);
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
      // mt#1831 PR #1113 R1: keep the cause-chain enrichment inside the MCP
      // tool-response path (CallToolRequestSchema catch) where the consumer is
      // an MCP agent / operator. The outer HTTP transport's 500 handler fires
      // for transport-level errors (body-parser, malformed JSON-RPC, express
      // middleware crashes) whose audience includes arbitrary HTTP clients;
      // exposing the full `.cause` chain there widens the leak surface to
      // include driver messages and connection state beyond the spec's scope
      // (operator-facing MCP wire path). Log the enriched chain for operator
      // diagnostics but return only the shallow message to the wire.
      log.error("Error handling HTTP request", { error: getErrorMessageWithCause(error) });
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

      // Admission control: reject new sessions when the concurrent-session cap
      // is reached. The cap is configurable via MINSKY_MCP_MAX_SESSIONS; absent
      // or non-positive values disable the cap entirely (no-op for backward
      // compatibility). Rejected requests receive 503 + Retry-After so that
      // well-behaved clients back off and retry rather than hammering the endpoint.
      if (this.MAX_HTTP_SESSIONS !== null && this.httpSessions.size >= this.MAX_HTTP_SESSIONS) {
        const currentCount = this.httpSessions.size;
        log.warn("mcp_session_reject", {
          reason: "cap_reached",
          currentCount,
          cap: this.MAX_HTTP_SESSIONS,
        });
        res
          .status(503)
          .set("Retry-After", String(this.SESSION_CAP_RETRY_AFTER_SECS))
          .json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: `Service unavailable: concurrent session cap (${this.MAX_HTTP_SESSIONS}) reached. Retry after ${this.SESSION_CAP_RETRY_AFTER_SECS}s.`,
            },
            id: null,
          });
        return;
      }

      // New session: each HTTP session gets its own Server instance because
      // the SDK's Server binds 1:1 with a Transport. A singleton Server across
      // sessions rejects every connect() past the first.
      // mt#1705: generate a per-session key for tool-call tracking BEFORE the
      // Server is constructed. The CallTool handler closure captures it so
      // each session's tool calls increment its own counter; wireDisconnectHooks
      // captures it so each session's disconnect reads its own counter. Using
      // a process-wide counter (the original mt#1705 approach) would misclassify
      // disconnects from other sessions once any session made a tool call.
      const sessionKey = randomUUID();
      const server = this.createConfiguredServer(sessionKey);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // Connect server to its dedicated transport first, so any onclose /
      // onmessage handlers the SDK installs during connect() are captured
      // below when we chain our own.
      await server.connect(transport);
      // mt#1645: wire disconnect/reconnect tracking on this per-session Server.
      // HTTP sessions use "unknown" as the default cause — the transport close
      // event does not distinguish client-initiated vs. server-initiated closes
      // at the protocol level.
      // mt#1705: pass the per-session sessionKey so the disconnect reads the
      // correct per-session tool-call count.
      this.wireDisconnectHooks(server, "unknown", sessionKey);
      this.disconnectTracker.recordReconnect();
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
          // mt#1457: unregister from the capability registry so a closed
          // connection's stale capabilities don't influence routing decisions.
          this.clientCapabilityRegistry?.unregisterServer(server);
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
          const newCount = this.httpSessions.size;
          log.debug("mcp_session_admit", {
            sessionId: id,
            currentCount: newCount,
            cap: this.MAX_HTTP_SESSIONS ?? "unlimited",
          });
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
      // mt#1457: unregister from capability registry. Idempotent — safe even
      // if onclose also fires and unregisters again.
      this.clientCapabilityRegistry?.unregisterServer(session.server);
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
  /**
   * Register all request handlers on a Server instance.
   *
   * mt#1705: `sessionKey` is captured in the CallTool handler closure so each
   * session's tool calls increment that session's counter (not a process-wide
   * one). Stdio passes `STDIO_SESSION_KEY`; HTTP passes a per-session UUID
   * generated in `handleHttpRequest`.
   */
  private setupRequestHandlers(server: Server, sessionKey: string): void {
    // List tools
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      this.diag.captureRequest("tools/list", request, extra);
      // mt#1779: dedupe by ToolDefinition identity (dual-registration in
      // `addTool` puts the same tool object under both dotted and underscored
      // keys). Whether to emit the underscored alias is feature-detected from
      // the client's `clientInfo.name` reported during `initialize` —
      // `shouldEmitDesktopAliases` defaults to false for non-Claude clients so
      // the canonical dotted wire contract is preserved. Claude clients
      // (clientInfo.name starts with "claude") see the underscored form that
      // passes their strict frontend validator regex.
      const clientInfo = server.getClientVersion() as { name?: string } | undefined;
      const emitDesktop = shouldEmitDesktopAliases(clientInfo);
      const seen = new Set<ToolDefinition>();
      const tools: Array<{
        name: string;
        description: string;
        inputSchema: object;
      }> = [];
      for (const tool of this.tools.values()) {
        if (seen.has(tool)) continue;
        seen.add(tool);
        tools.push({
          name: emitDesktop ? toClaudeDesktopName(tool.name) : tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema || {},
        });
      }
      return { tools };
    });

    // Call tool
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      this.diag.captureRequest("tools/call", request, extra);
      if (this.draining) {
        throw new Error("Server is shutting down");
      }

      // mt#1705: count tool calls for process-role classification at disconnect
      // time. Incremented before the tool runs so the count is accurate even if
      // the handler throws. Per-session counter (keyed by `sessionKey` captured
      // in this handler's closure) — so HTTP sessions classify independently
      // and one session's tool call doesn't inflate another's count. This is
      // the discriminating signal: 0 calls → "helper" (harness helper / hook
      // spawner / probe), 1+ calls → "main_session".
      // mt#1715: skip increment after clean shutdown to prevent repopulating
      // an already-evicted counter during the 200ms exit delay or signal drain.
      if (!this.disconnectTracker.isCleanShutdownInitiated()) {
        this.disconnectTracker.incrementToolCallCount(sessionKey);
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
          // Drift gate: refuse mutating tools when the server is stale.
          // Read-only tools (mutating === false or unset) are allowed through.
          this.checkDriftGate(tool);

          // mt#1751: await DI initialization before dispatching to the tool
          // handler. The MCP `initialize` handshake completes before DI runs
          // in stdio mode (so the server appears connected fast); the first
          // DI-dependent tool call pays the cost. After the first await
          // resolves, the promise is settled and subsequent awaits are O(1).
          //
          // mt#1962: prefer `initController.awaitReady()` when set — it adds
          // demand-driven retry so a transient init failure recovers on the
          // next tool call (subject to backoff). Falls back to `initPromise`
          // for callers using the legacy single-attempt API (tests).
          //
          // Tools that declare `requiresInit: false` skip the await — this
          // gates the latency to DI-dependent tools only, so read-only
          // debug tools (`debug_echo`, `debug_listMethods`) respond
          // immediately even if init is still in flight. The DI-free
          // allowlist is checked against the resolved tool's CANONICAL
          // (dotted) name, not the request-provided name — so Claude
          // Desktop clients invoking via the underscored alias (mt#1779
          // dual-registration) still hit the fast path.
          const requiresInit = tool.requiresInit !== false && !DI_FREE_TOOL_NAMES.has(tool.name);
          if (requiresInit) {
            if (this.initController) {
              await this.initController.awaitReady();
            } else if (this.initPromise) {
              await this.initPromise;
            }
          }

          // mt#1792: lazy handler resolution. Resolve the getHandler thunk on
          // first call and cache the result back onto tool.handler so subsequent
          // calls use the resolved function directly (O(1) cached path).
          // Handler resolution happens AFTER initPromise so DI services are
          // available before the first handler module is loaded.
          //
          // PR #1103 R1 NON-BLOCKING: memoize the in-flight thunk resolution on
          // `tool.__resolving` so concurrent first calls share a single
          // `getHandler()` invocation (no redundant heavy module loads under
          // parallel load). On rejection, the sentinel is cleared so a
          // subsequent retry can re-attempt resolution.
          if (!tool.handler && tool.getHandler) {
            if (!tool.__resolving) {
              const thunk = tool.getHandler;
              tool.__resolving = thunk().catch((err) => {
                tool.__resolving = undefined;
                throw err;
              });
            }
            tool.handler = await tool.__resolving;
            tool.__resolving = undefined;
          }
          if (!tool.handler) {
            throw new Error(`Tool '${request.params.name}' has no handler or getHandler`);
          }

          const result = await tool.handler(request.params.arguments || {});

          // Write agentId to any touched session record (fire-and-forget, non-blocking)
          this.writeAgentIdToSession(request.params.arguments || {}, agentId).catch((err) => {
            log.debug("agentId session update failed (non-blocking)", {
              error: getErrorMessage(err),
              tool: request.params.name,
            });
          });

          // mt#2562: Write task-grain presence claim (fire-and-forget, session-independent).
          // Fires whenever args.task or args.taskId is present — no Minsky session required.
          this.writeTaskClaim(request.params.arguments || {}, agentId).catch((err) => {
            log.debug("presence claim write failed (non-blocking)", {
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

          // mt#1588 spike: memory enrichment middleware. For allowlisted tools,
          // append a second `{type:"text"}` content block carrying top-K
          // memory_search results. No-op for non-allowlisted tools, when the
          // memoryService is unset, or when the env-var kill switch is set
          // (used by the benchmark script). Errors and degraded results are
          // silently dropped — enrichment must never break the tool call.
          const enrichmentBlock = await enrichToolResponse(
            request.params.name,
            request.params.arguments || {},
            this.memoryService
          );

          // mt#1661 v0: wake-enrichment middleware. For allowlisted tools, drains
          // undelivered wake_pending rows for the calling session and appends a
          // `<wake-events>` content block. No-op when the wakeService /
          // sessionResolver are unset, the tool is not allowlisted, the caller
          // carried no resolvable session arg, or there were no pending wakes.
          // Errors are logged at `wake.enrichment.failed` and suppressed —
          // enrichment failure must NEVER break the underlying tool call.
          const wakeBlock = await enrichWakeResponse(
            request.params.name,
            request.params.arguments || {},
            this.wakeService,
            this.wakeSessionResolver
          );

          // Return MCP-compliant tool response
          return {
            content: [
              {
                type: "text",
                text: responseText,
              },
              ...(enrichmentBlock ? [enrichmentBlock] : []),
              ...(wakeBlock ? [wakeBlock] : []),
            ],
          };
        } catch (error) {
          // mt#1831: surface the underlying `.cause` chain so operators can
          // discriminate stale-connection failures (ECONNRESET, Connection
          // terminated) from real DB errors (schema mismatch, constraint
          // violation). DrizzleQueryError stashes the driver error on
          // `.cause` but only surfaces "Failed query: <SQL>" via `.message`.
          const wireMessage = getErrorMessageWithCause(error);
          log.error("Tool execution failed", {
            tool: request.params.name,
            error: wireMessage,
          });

          // Check for staleness on error path too — trigger fires notification
          // + clean exit after the error is thrown to the caller.
          const staleWarning = this.stalenessDetector.getStaleWarning();
          if (staleWarning !== null && !this.hasTriggeredStaleSignal) {
            this.triggerStaleSignal(server);
          }

          // Preserve structured McpError instances (e.g. StructuredMcpError with
          // machine-readable data payload) so the SDK propagates `code` and `data`
          // to the caller intact. Plain Error objects are wrapped as before, but
          // mt#1831 PR #1113 R1 NON-BLOCKING: preserve the original error via the
          // ES2022 `cause` option so downstream handlers can still inspect machine-
          // readable fields (driver code, sub-error chain) even though the
          // user-facing message is the flattened wireMessage string.
          if (error instanceof McpError) {
            throw error;
          }
          throw new Error(`Tool execution failed: ${wireMessage}`, { cause: error });
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
   * Set the memory service used by the mt#1588 spike enrichment middleware.
   * Optional — when unset, the middleware is a no-op. Called from the MCP
   * start command after `registerAllTools` resolves the persistence provider.
   *
   * @see mt#1588 — spike that introduces this surface
   */
  setMemoryService(service: MemoryServiceSurface): void {
    this.memoryService = service;
  }

  /**
   * Set the wake-pending service + session resolver used by the mt#1661 v0
   * wake-enrichment middleware. Optional — when unset, the middleware is a
   * no-op. Called from the MCP start command after the persistence provider
   * resolves.
   *
   * @see mt#1661 — v0 short-term bridge
   * @see mt#1506 — long-term InterfaceBinding model that retires this v0
   */
  setWakeService(service: WakeServiceSurface, sessionResolver: WakeSessionResolver): void {
    this.wakeService = service;
    this.wakeSessionResolver = sessionResolver;
  }

  /**
   * mt#1751: Set the DI initialization promise.
   *
   * When set, every CallTool dispatch awaits this promise before invoking the
   * tool handler. The MCP `initialize` handshake and `tools/list` do NOT await
   * it (they don't need persistence), so the server can become responsive
   * immediately while DI runs in the background.
   *
   * The promise must complete in finite time and must not be cancellable —
   * tool handlers depend on the container being fully resolved. If init
   * fails, the rejection propagates to the first tool call.
   *
   * Called from `src/commands/mcp/start-command.ts` for stdio mode after
   * `registerAllTools` returns but before `server.start()` resolves.
   */
  setInitPromise(p: Promise<void>): void {
    this.initPromise = p;
    // mt#1962: symmetric mutual exclusivity — setInitPromise clears any
    // previously-set controller, mirroring setInitController clearing
    // initPromise. This prevents the silent-ignore failure mode where
    // both fields are populated and the controller branch wins
    // unconditionally in the CallTool handler.
    this.initController = null;
  }

  /**
   * mt#1962: Set the DI initialization controller for stdio mode.
   *
   * When set, every CallTool dispatch calls `initController.awaitReady()`
   * before invoking the tool handler. The controller is responsible for
   * retrying transient init failures (subject to its own backoff policy);
   * a single rejected attempt no longer poisons the daemon.
   *
   * Clears any previously-set `initPromise` so the controller is the
   * single source of truth (symmetric with `setInitPromise` clearing
   * `initController`).
   *
   * Called from `src/commands/mcp/start-command.ts` for stdio mode after
   * `registerAllTools` returns but before `server.start()` resolves.
   */
  setInitController(controller: InitController): void {
    this.initController = controller;
    this.initPromise = null;
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
      ) as import("@minsky/domain/session/types").SessionProviderInterface;
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
    ) as import("@minsky/domain/session/types").SessionProviderInterface;
    await sessionProvider.updateSession(sessionName, { agentId });
    log.debug("agentId written to session record", { session: sessionName, agentId });
  }

  /**
   * mt#2562: Set the presence claim repository. Called from the MCP start command
   * after the persistence provider resolves. When unset, `writeTaskClaim` is a no-op.
   */
  setPresenceClaimRepository(repo: PresenceClaimRepository): void {
    this.presenceClaimRepo = repo;
  }

  /**
   * mt#2562: Write a task-grain presence claim for the current actor.
   * Session-independent: fires whenever args.task or args.taskId is present,
   * regardless of whether a Minsky workspace session exists.
   *
   * Runs fire-and-forget (caller catches errors). Failures are logged at debug
   * level and never surface to the MCP caller — presence tracking is best-effort.
   *
   * mt#2567: builds the presence repo per-call from the container when the
   * one-shot setPresenceClaimRepository() fast-path was not fired (e.g. on
   * proxy/staleness-respawned servers). Mirrors the buildAskRepository pattern.
   */
  private async writeTaskClaim(args: Record<string, unknown>, actorId: string): Promise<void> {
    // Use pre-set repo (fast-path from one-shot startup wiring in start-command.ts),
    // or build per-call from the container (resilient fallback — mirrors
    // buildAskRepository which constructs new DrizzleAskRepository(db) on each call).
    // mt#2567: the one-shot wiring may not complete on proxy/staleness-respawned
    // servers, leaving presenceClaimRepo unset and making every call a no-op.
    let repo: PresenceClaimRepository | null = this.presenceClaimRepo ?? null;
    if (!repo) {
      if (!this.container?.has("persistence")) return;
      try {
        const persistence = this.container.get("persistence") as {
          getDatabaseConnection?: () => Promise<unknown>;
        };
        if (!persistence.getDatabaseConnection) return;
        const db = await persistence.getDatabaseConnection();
        if (!db) return;
        const { buildPresenceClaimRepository } = await import("@minsky/domain/presence/index");
        repo = buildPresenceClaimRepository(db);
        if (!repo) return;
      } catch {
        return; // fail silently — presence tracking is best-effort
      }
    }

    const taskId =
      (typeof args.task === "string" ? args.task : undefined) ||
      (typeof args.taskId === "string" ? args.taskId : undefined);

    if (!taskId) return;

    // Canonicalize the task id so the write path and the read path
    // (tasks.claims.list) key on the SAME subject_id — `mt#2562`, `2562`, and
    // `MT-2562` must not fragment into distinct rows (PR #1755 R1).
    const subjectId = normalizeTaskSubjectId(taskId);
    if (!subjectId) return;

    // Resolve project scope (best-effort; fail silently on error)
    let projectId: string | undefined;
    try {
      const { resolveProjectIdentity } = await import("@minsky/domain/project/identity");
      const { resolveProjectScope } = await import("@minsky/domain/project/scope-resolver");
      const identity = resolveProjectIdentity({ repoPath: process.cwd() });
      if (identity.kind === "resolved" && this.container?.has("persistence")) {
        const persistence = this.container.get("persistence") as {
          getDatabaseConnection?: () => Promise<unknown>;
        };
        if (persistence.getDatabaseConnection) {
          const rawDb = await persistence.getDatabaseConnection();
          if (rawDb) {
            const scope = await resolveProjectScope(
              identity,
              rawDb as import("@minsky/domain/project/scope-resolver").ScopeResolverDb
            );
            const { isAllProjects } = await import("@minsky/domain/project/scope");
            // ProjectScope = string | AllProjects; narrow to string branch = the project UUID
            if (!isAllProjects(scope)) {
              projectId = scope;
            }
          }
        }
      }
    } catch {
      // Fail silently — project scope is informational for presence
    }

    // Capture the caller's CC conversation id (best-effort from environment)
    const ccConversationId =
      typeof process.env.CC_CONVERSATION_ID === "string"
        ? process.env.CC_CONVERSATION_ID
        : undefined;

    await repo.upsertClaim({
      subjectKind: "task",
      subjectId,
      actorId,
      ccConversationId,
      projectId,
    });

    log.debug("presence claim written", { taskId, actorId });
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

    // mt#1682: tag the upcoming exit as `staleness_exit` BEFORE process.exit
    // fires. Without this, the SDK's onclose handler (chained via
    // wireDisconnectHooks) records `stdin_close` during stdio teardown,
    // conflating the by-design staleness exit with harness-initiated
    // closures. Append-only persistence (mt#1682) guarantees the event hits
    // disk before the 200ms timeout completes.
    this.disconnectTracker.recordDisconnect("staleness_exit", {
      sessionKey: STDIO_SESSION_KEY,
      errorMessage: staleMessage || undefined,
    });

    setTimeout(() => this.exit(0), 200);
  }

  /**
   * Install SIGTERM / SIGINT / SIGHUP listeners that record a cause-tagged
   * disconnect event before the process exits. Without these, signal-driven
   * shutdowns surface as generic `stdin_close` (because the SDK's onclose
   * fires during stdio teardown) — losing the distinction between by-design
   * shutdowns and harness-initiated closures.
   *
   * The handler is a no-op if a previous MinskyMCPServer instance in the same
   * process already installed listeners. Multiple servers per process is
   * unusual but possible (tests); the singleton DisconnectTracker means the
   * recorded events are still correctly attributed.
   *
   * The handler explicitly does NOT call process.exit. After recording the
   * cause, control returns to Node's default signal handling (or any
   * additional listeners installed by other parts of the application), which
   * is what eventually terminates the process. This avoids interfering with
   * graceful-shutdown paths that other code may have wired up.
   *
   * @see mt#1682 — cause classification
   */
  private installSignalHandlers(): void {
    if (MinskyMCPServer.signalHandlersInstalled) return;
    MinskyMCPServer.signalHandlersInstalled = true;

    // The project's narrowed `process` type omits EventEmitter methods.
    // Cast to a Node-shaped surface for the signal-handling APIs we need —
    // intentional escape from the narrow type to access on/removeListener/kill.
    type ProcSignal = "SIGTERM" | "SIGINT" | "SIGHUP";
    // eslint-disable-next-line custom/no-excessive-as-unknown
    const proc = process as unknown as {
      pid: number;
      on(event: ProcSignal, listener: () => void): void;
      removeListener(event: ProcSignal, listener: () => void): void;
      listenerCount(event: ProcSignal): number;
      kill(pid: number, signal: ProcSignal): void;
    };

    const tracker = this.disconnectTracker;
    const listeners: Record<ProcSignal, () => void> = {
      SIGTERM: () => handle("SIGTERM"),
      SIGINT: () => handle("SIGINT"),
      SIGHUP: () => handle("SIGHUP"),
    };
    const handle = (signal: ProcSignal) => {
      const cause: import("./disconnect-tracker").McpDisconnectCause =
        signal === "SIGTERM"
          ? "signal_sigterm"
          : signal === "SIGINT"
            ? "signal_sigint"
            : "signal_sighup";
      try {
        tracker.recordDisconnect(cause, { sessionKey: STDIO_SESSION_KEY });
      } catch (err) {
        log.debug("signal handler: recordDisconnect failed (non-blocking)", {
          error: getErrorMessage(err),
        });
      }
      // Remove our own listener so we don't re-enter on the kernel-default
      // re-emit below, and so the post-removal listenerCount reflects only
      // OTHER registered handlers.
      proc.removeListener(signal, listeners[signal]);

      // mt#1987: only re-emit when there are no other listeners. When
      // `start-command.ts` (or any other module) has registered a graceful-
      // shutdown handler (e.g. the `cleanup` async closure that drains the
      // DB pool and exits cleanly), defer to it — re-emitting SIGTERM mid-
      // tick races against the cleanup handler and causes the kernel default
      // to fire before the JS handler can run, exiting with `signal:SIGTERM`
      // / code:null and bypassing the cleanup path entirely. Standalone
      // usages (tests that construct an MCPServer without a cleanup handler)
      // still get the kernel-default termination because the listenerCount
      // is 0 after our removal.
      if (proc.listenerCount(signal) > 0) return;
      proc.kill(proc.pid, signal);
    };

    proc.on("SIGTERM", listeners.SIGTERM);
    proc.on("SIGINT", listeners.SIGINT);
    proc.on("SIGHUP", listeners.SIGHUP);
  }

  /**
   * Wire disconnect/reconnect tracking hooks onto an SDK Server instance
   * (mt#1645). Chains onto any existing `onclose`/`onerror` callbacks rather
   * than replacing them so other SDK internals continue to work.
   *
   * @param server   The SDK Server to instrument.
   * @param defaultCause  Cause to record when `onclose` fires without an
   *                 accompanying transport error (e.g. `"stdin_close"` for
   *                 stdio, `"unknown"` for HTTP sessions).
   * @param sessionKey  Per-session key for tool-call-count tracking (mt#1705).
   *                 Passed through to `recordDisconnect` so the disconnect
   *                 reads THIS session's tool-call count, not the process-wide
   *                 one. Stdio uses `STDIO_SESSION_KEY`; HTTP uses a per-
   *                 session UUID generated in `createConfiguredServer`.
   */
  private wireDisconnectHooks(
    server: Server,
    defaultCause: import("./disconnect-tracker").McpDisconnectCause,
    sessionKey: string
  ): void {
    const prevOnclose = server.onclose;
    server.onclose = () => {
      prevOnclose?.();
      // mt#1682: if a server-initiated disconnect (staleness_exit, signal_*,
      // server_close) was already recorded by triggerStaleSignal /
      // installSignalHandlers / explicit close, suppress the duplicate
      // `stdin_close` event that the SDK fires during stdio teardown.
      if (this.disconnectTracker.isCleanShutdownInitiated()) return;
      this.disconnectTracker.recordDisconnect(defaultCause, { sessionKey });
    };

    const prevOnerror = server.onerror;
    server.onerror = (error: Error) => {
      prevOnerror?.(error);
      this.disconnectTracker.recordTransportError(getErrorMessage(error));
    };
  }

  /**
   * Expose the disconnect tracker for use by the `debug.systemInfo` command.
   * Read-only — callers must not mutate the tracker.
   */
  getDisconnectTracker(): DisconnectTracker {
    return this.disconnectTracker;
  }

  /**
   * Add a tool to the server.
   *
   * mt#1779: Tools whose canonical name contains a dot (e.g., `tasks.list`,
   * `session.pr.get`) are dual-registered under both the canonical name AND
   * an underscored alias produced by `toClaudeDesktopName(name)`. Reason:
   * Claude Desktop's frontend validator regex `^[a-zA-Z0-9_-]{1,64}$` rejects
   * dotted names, blocking every tool call. Legacy consumers using dotted
   * names (Reviewer service: `session.list`, `session.pr.get`) keep working
   * because the dotted key remains in the map. Both keys point to the SAME
   * `ToolDefinition` object, so `tool.name` (used by logs, drift gate, and
   * `DI_FREE_TOOL_NAMES` allowlist) keeps its canonical dotted form.
   *
   * `tools/list` (see `setupRequestHandlers`) dedupes by ToolDefinition
   * identity and emits the variant appropriate for the connected client
   * (see `shouldEmitDesktopAliases`).
   *
   * PR #1071 R1 BLOCKING #1 fix: pre-flight check BOTH the canonical and
   * alias keys before any write. The pre-fix code wrote `tool.name` first
   * then checked the alias — a canonical-name collision (e.g., adding
   * `foo_bar` after `foo.bar` had been registered and created the
   * `foo_bar` alias key) would overwrite silently. The fix is symmetric:
   * any collision on either key to a different `ToolDefinition` refuses
   * the registration and logs a clear warning. Idempotent re-adds of the
   * same `ToolDefinition` object are allowed (no-op).
   */
  addTool(tool: ToolDefinition): void {
    const desktopName = toClaudeDesktopName(tool.name);
    const aliasDiffers = desktopName !== tool.name;

    // Pre-flight: detect collisions BEFORE writing. Idempotent re-adds (same
    // ToolDefinition object) are permitted as no-ops.
    const canonicalExisting = this.tools.get(tool.name);
    if (canonicalExisting && canonicalExisting !== tool) {
      log.warn("mt#1779: tool name collision — refusing to overwrite existing tool", {
        name: tool.name,
        existing: canonicalExisting.name,
      });
      return;
    }
    if (aliasDiffers) {
      const aliasExisting = this.tools.get(desktopName);
      if (aliasExisting && aliasExisting !== tool) {
        log.warn("mt#1779: Claude Desktop alias collision — refusing to register tool", {
          canonical: tool.name,
          desktopAlias: desktopName,
          existing: aliasExisting.name,
        });
        return;
      }
    }

    // No conflicts — register under both keys (or just the one if equal).
    this.tools.set(tool.name, tool);
    if (aliasDiffers) {
      this.tools.set(desktopName, tool);
    }
    log.debug("Added tool", {
      name: tool.name,
      ...(aliasDiffers ? { desktopAlias: desktopName } : {}),
    });
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
        // mt#1645: wire disconnect/reconnect hooks on the SDK Server after connect().
        // onclose fires when the stdio pipe closes (client-side disconnect or process exit).
        // onerror fires on transport-level errors (I/O errors on stdin/stdout).
        // mt#1705: stdio mode is one-server-per-process, so a fixed sessionKey
        // is correct here.
        this.wireDisconnectHooks(this.server, "stdin_close", STDIO_SESSION_KEY);
        // Record the reconnect event (this process starting = a reconnect from the client's POV)
        this.disconnectTracker.recordReconnect();
        // mt#1717: write daemon state so the staleness detector hook can compare
        // the running daemon's start-commit against the current HEAD.
        writeDaemonState("minsky", "stdio");
        log.cli("Minsky MCP Server started with stdio transport");
        log.systemDebug("[MCP] Stdio transport connected successfully");
      } else {
        // For HTTP transport, we don't connect here since transports are created on-demand
        const httpConfig = this.options.httpConfig || {};
        const host = httpConfig.host || "localhost";
        const port = httpConfig.port || 3000;
        log.cli(`Minsky MCP Server ready for HTTP transport (${host}:${port})`);
        // mt#1717: write daemon state for HTTP mode too — the hook gates on
        // transport === "http" and skips, but the file must exist so the hook
        // knows a daemon is running (BLOCKING 2, PR #1035 R1).
        writeDaemonState("minsky", "http");
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
          // mt#1457: unregister from capability registry on shutdown.
          this.clientCapabilityRegistry?.unregisterServer(entry.server);
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

      // mt#1457: unregister the singleton stdio Server (HTTP sessions are
      // unregistered above). Idempotent for the http-mode path.
      this.clientCapabilityRegistry?.unregisterServer(this.server);

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
   * Return the number of currently active HTTP sessions.
   * Returns 0 for stdio transport (no HTTP sessions).
   */
  getSessionCount(): number {
    return this.httpSessions.size;
  }

  /**
   * Return the configured maximum concurrent HTTP sessions, or null if no cap.
   */
  getMaxSessions(): number | null {
    return this.MAX_HTTP_SESSIONS;
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
