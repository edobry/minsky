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
  type ServerNotification,
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
import { hostname } from "os";
import {
  resolveAgentIdWithLayer,
  type IdentityFallbackEvent,
} from "@minsky/domain/agent-identity/resolve";
import { buildDeclaredIdentityKeys } from "@minsky/domain/agent-identity/declared";
import { redactAgentId } from "@minsky/domain/agent-identity/format";

/**
 * How many distinct Layer 1 agentIds the identity-fallback reporter remembers
 * before resetting (mt#3986, PR #2877 R1).
 *
 * Sized against the observed fleet rather than a round number: mt#3811 measured
 * this daemon at 1–10 concurrent clients, and each client PROCESS contributes
 * one id, so 256 is roughly an order of magnitude above any observed
 * simultaneous population while staying trivially small in memory.
 */
const IDENTITY_FALLBACK_REPORT_CAP = 256;
import { resolvePresenceConversationId } from "./presence-conversation";
import type { RequestExtras } from "@minsky/domain/agent-identity/layer2";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { MCPConnectionTracker } from "./client-capabilities";
import { SingleConnectionCapabilityRegistry } from "./client-capabilities";
import type { ClientCapabilityRegistry } from "@minsky/domain/client-capabilities";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import { emitBraintrustEvent } from "@minsky/domain/observability/braintrust";
import { enrichToolResponse } from "./middleware/memory-enrichment";
import {
  DEADLINE_EXCEEDED,
  ENRICHMENT_DEADLINE_MS,
  enrichWakeResponse,
  raceEnrichmentDeadline,
  type SessionResolver as WakeSessionResolver,
  type WakeServiceSurface,
} from "./middleware/wake-enrichment";
import { DisconnectTracker, STDIO_SESSION_KEY } from "./disconnect-tracker";
import { writeDaemonState } from "./daemon-state";
import type { InFlightToolCall } from "./memory-capture";
import { formatAdmissionRefusal, type AdmissionGate } from "./daemon/memory-admission";
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
/**
 * What the server tracks about a tool call while it runs (mt#3973).
 *
 * `startedAtMs` alone was enough for the graceful-drain check that originally
 * owned this map; `toolName` is what a resident-memory capture needs to be a
 * lead rather than an observation.
 */
interface InFlightRequestState {
  toolName: string;
  startedAtMs: number;
}

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
   * A protocol-native `_meta` key to consult for conversation identity, after
   * `io.minsky/agent_id` and W3C `baggage` (mt#3986).
   *
   * Configured rather than hardcoded because no such key exists yet: the MCP
   * 2026-07-28 revision reserves the `io.modelcontextprotocol/` prefix but
   * defines no conversation identifier under it. Only a key under a
   * reserved MCP prefix is accepted; anything else is ignored.
   */
  protocolConversationIdKey?: string;

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
  connectionTracker?: MCPConnectionTracker;

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
/**
 * mt#3121: the canonical (dotted) protocol name of the dispatch-recover tool.
 * The request handler injects the resolved caller agentId into ONLY this tool's
 * args (matched exactly against this name and its `toClaudeDesktopName` underscore
 * alias) so its contested-check can exclude the caller's own task-grain claims.
 */
const DISPATCH_RECOVER_TOOL_NAME = "tasks.dispatch-recover";

/**
 * The tool whose calibration claim keys on caller identity (mt#4408).
 *
 * Separate constant from {@link DISPATCH_RECOVER_TOOL_NAME} because the two
 * tools want the same injection for unrelated reasons — one excludes the
 * caller's own presence claims, the other takes a claim AS the caller.
 */
const CALIBRATION_REVIEW_TOOL_NAME = "observability.calibration-review";

/**
 * The tool whose ROW records caller identity for later delivery (mt#4476).
 *
 * A third reason, distinct from the two above: the other members read the caller's
 * identity to decide something DURING the call, while this one persists it so an
 * answer can be routed back to that conversation later. `Ask.filedByAgentId` is the
 * only addressing key an ordinary ask has — a main-workspace conversation has no
 * workspace session — and it has to be server-stamped rather than caller-supplied,
 * because the adjacent caller-supplied field (`requestor`) demonstrates what happens
 * otherwise: its docblock promises an AgentId and a live sample held `"claude-opus-5"`.
 */
const ASKS_CREATE_TOOL_NAME = "asks.create";

/**
 * Tools the server injects the resolved caller `agentId` into as
 * `callerActorId` (mt#3121, extended mt#4408).
 *
 * Membership is EXACT-match on the canonical dotted name and its
 * Claude-Desktop underscore alias — never a substring — so a tool whose name
 * merely CONTAINS one of these cannot receive the param. Built once at module
 * load rather than per request.
 *
 * Why a set rather than a second `if`: the injection is now two tools wide and
 * the matching rule (exact, both aliases, server overwrites any caller-supplied
 * value) is the part that must not drift between them. One membership test
 * cannot disagree with itself.
 */
const CALLER_ACTOR_ID_TOOL_NAMES: ReadonlySet<string> = new Set(
  [DISPATCH_RECOVER_TOOL_NAME, CALIBRATION_REVIEW_TOOL_NAME, ASKS_CREATE_TOOL_NAME].flatMap(
    (name) => [name, toClaudeDesktopName(name)]
  )
);

const DI_FREE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "debug.echo",
  "debug.listMethods",
  "debug.systemInfo",
]);

/**
 * mt#2677: reports a human-readable progress message for a long-running tool
 * call. Bound (by `buildProgressReporter` below) to the MCP transport's
 * `notifications/progress` mechanism when the CALLER requested it (a
 * `_meta.progressToken` on the originating request) — a no-op function is
 * NOT passed when the caller didn't ask for progress, so tool handlers can
 * unconditionally call `progress?.("...")` without checking for support.
 *
 * Kept as a plain `(message: string) => void` (not the raw MCP SDK
 * notification shape) so nothing below this layer — command-mapper,
 * shared-command-integration, domain poll loops — needs to know about
 * `RequestHandlerExtra` or JSON-RPC notification framing.
 */
export type ToolProgressReporter = (message: string) => void;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: object;
  /**
   * Eager (legacy) handler. At least one of `handler` or `getHandler` must be
   * provided. When both are present, `handler` takes precedence.
   *
   * The optional second argument (mt#2677) is a progress reporter, present
   * only when the calling client requested progress notifications for this
   * request. Long-running tools (poll loops in particular) call it once per
   * poll interval so a legitimate multi-minute wait produces MCP transport
   * activity instead of total silence — see
   * `packages/domain/src/session/commands/pr-wait-for-review-subcommand.ts`
   * for the originating case (a harness-side 1800s MCP idle timeout killed
   * connections that were still correctly polling within their own
   * server-side timeout).
   */
  handler?: (
    args: Record<string, unknown>,
    progress?: ToolProgressReporter,
    callerCapabilities?: ClientCapabilityRegistry
  ) => Promise<unknown>;
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
  getHandler?: () => Promise<
    (
      args: Record<string, unknown>,
      progress?: ToolProgressReporter,
      callerCapabilities?: ClientCapabilityRegistry
    ) => Promise<unknown>
  >;
  /**
   * PR #1103 R1 NON-BLOCKING: in-flight thunk-resolution promise. Set on first
   * call when `getHandler` resolution starts; subsequent concurrent first
   * calls share this promise instead of invoking `getHandler()` again.
   * Cleared on success (resolved value cached on `handler`) and on rejection
   * (so retry can occur). Internal; not part of the registration API.
   */
  __resolving?: Promise<
    (
      args: Record<string, unknown>,
      progress?: ToolProgressReporter,
      callerCapabilities?: ClientCapabilityRegistry
    ) => Promise<unknown>
  >;
  /**
   * When true, this tool performs external side effects (e.g. GitHub PR
   * create/edit/merge, force-push, session-update). The server will refuse
   * to execute it when drift is detected (loaded commit !== workspace HEAD).
   * Read-only tools leave this unset or set it to false.
   */
  mutating?: boolean;

  /**
   * When true, invoking this tool must NOT write a presence claim (mt#3889,
   * mt#3903). Declared at the command definition and threaded here by the
   * command mapper; `writeTaskClaim` is its only consumer.
   */
  readsPresence?: boolean;
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

/**
 * Build a `ToolProgressReporter` bound to this request's MCP transport
 * (mt#2677), or `undefined` when the calling client did not request progress
 * notifications for this request (no `_meta.progressToken`). Per the MCP
 * spec, progress notifications are only sent when the caller opts in with a
 * `progressToken` — sending them unconditionally would be protocol-incorrect
 * for clients that never asked.
 *
 * `progress` is a monotonically increasing counter (the `progress` field is
 * required by `notifications/progress`); callers only care about `message`,
 * so the counter is purely internal bookkeeping to satisfy the schema.
 *
 * Notification failures are logged and swallowed — a progress notification
 * is best-effort UX, never a reason to fail the underlying tool call.
 */
export function buildProgressReporter(
  progressToken: string | number | undefined,
  sendNotification: (notification: ServerNotification) => Promise<void>
): ToolProgressReporter | undefined {
  if (progressToken === undefined) return undefined;
  let progress = 0;
  return (message: string) => {
    progress += 1;
    void sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, message },
    } satisfies ServerNotification).catch((err) => {
      log.debug("mt#2677: progress notification failed (non-blocking)", {
        error: getErrorMessage(err),
      });
    });
  };
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
  private connectionTracker: MCPConnectionTracker | undefined;
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
  /**
   * Latches once the conflicting-ambient-conversation warning has been emitted
   * (mt#3945 PR #2847 R1). The check sits on the presence write path, which
   * fires on every tool call carrying a task or session arg, so an unlatched
   * warning would repeat thousands of times for one misconfiguration.
   */
  private warnedAmbientConversationConflict = false;

  /**
   * Layer 1 agentIds already reported as an identity fallback (mt#3986).
   * Bounds the warning to one per distinct ascribed id — see
   * `reportIdentityFallback`. Capped at
   * {@link IDENTITY_FALLBACK_REPORT_CAP}; a Layer 1 id is derived from
   * (hostname, user, pid, start-time), so a long-lived shared daemon meets a
   * new one per client PROCESS and this would otherwise grow without bound
   * (PR #2877 R1).
   */
  private reportedIdentityFallbacks = new Set<string>();

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

  // mt#3814: resident-memory admission gate for the shared local daemon.
  //
  // Null (no gate) unless the daemon wiring installs one, which is why this is
  // a setter rather than an env read here: arming it changes when a server
  // refuses a session, and the hosted Railway surface is explicitly out of
  // mt#3814's scope. `mcp start --local-daemon` installs it; nothing else does.
  private sessionAdmissionGate: AdmissionGate | null = null;

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
  // mt#3814: made env-configurable alongside the timeout above. With a fixed
  // 60s sweep, setting the idle timeout to seconds changes nothing observable
  // for up to a minute — so the local tuning ADR-038 §Question 6 asks for was
  // only half-tunable, and no bounded test could witness a reap at all. The
  // default is unchanged, so no existing deployment is affected.
  private readonly SESSION_REAPER_INTERVAL_MS: number =
    Number.parseInt(process.env.MINSKY_MCP_SESSION_REAPER_INTERVAL_MS ?? "", 10) || 60 * 1000;

  // mt#3764: sticky flag — true forever once the FIRST HTTP MCP session is
  // ever registered. Deliberately distinct from `httpSessions.size > 0`,
  // which reflects only CURRENTLY-open sessions: a client that connected
  // and later cleanly disconnected (or was reaped) must not be
  // indistinguishable from "no client ever connected" to the
  // never-connected idle-exit watcher in `orphan-exit.ts`.
  private hasEverHadAnyHttpSession = false;

  // Graceful shutdown tracking.
  //
  // mt#3973 widened the value from a bare start-timestamp to `{ toolName,
  // startedAtMs }`. Every other consumer reads `.size` or deletes by key, so
  // the shape change is confined to the two sites that write and read the
  // value. The tool name is what makes a resident-memory capture actionable:
  // "this process was at 40 GB" is an observation, "this process was at 40 GB
  // 90 seconds into transcripts_search-text" is a lead (mt#3885).
  private inFlightRequests = new Map<number, InFlightRequestState>();
  // True ONLY during a genuine graceful shutdown initiated by `drain()`
  // (the SIGTERM/SIGINT signal path in start-command.ts). New tool calls are
  // rejected while this is true (see the `tools/call` handler gate) because
  // the process really is going away and accepting new work would just be
  // discarded.
  //
  // mt#2830: staleness-exit does NOT set this flag — see `pendingStaleExit`
  // below. Sharing this flag between the two mechanisms was the bug: a
  // staleness-triggered drain used to set `draining = true`, which caused
  // every NEW tool call arriving during the drain window to be rejected with
  // `Error("Server is shutting down")` (surfaced to callers as MCP error
  // -32603) even though the process had not decided to exit yet and the old
  // code was still fully able to serve the request.
  private draining = false;
  private nextRequestId = 0;

  // mt#1884: injectable per-tool dispatch latency emitter. Defaults to the shared
  // Braintrust emitter; overridable in tests (instance-field DI) so latency
  // instrumentation can be asserted without a global module mock
  // (custom/no-global-module-mocks).
  private emitDispatchEvent: typeof emitBraintrustEvent = emitBraintrustEvent;

  // Staleness signal tracking
  private hasTriggeredStaleSignal = false;
  // mt#2830: set by `triggerStaleSignal` instead of `draining`. Signals that
  // the process intends to exit once genuinely idle, WITHOUT rejecting new
  // tool calls in the meantime — new requests arriving during this window are
  // served normally (on the currently-loaded, "old" code; the freshness
  // guarantee only applies to calls made AFTER the process actually exits and
  // is respawned by the stdio proxy). `scheduleStaleExitAfterDrain` polls
  // `inFlightRequests` for the first idle gap; `staleDrainCapMs` bounds how
  // long a continuously-busy server can postpone the exit.
  private pendingStaleExit = false;
  // mt#2830 R1 fix: set the MOMENT the exit decision is taken (the poll
  // observes `inFlightRequests.size === 0`, or the hard cap elapses) —
  // synchronously, in the SAME tick as that observation, with no `await`
  // in between. Closes a race the R1 review found: `pendingStaleExit` alone
  // admits new requests for the ENTIRE drain window, including the final
  // `FLUSH_BUFFER_MS` gap between "idle observed" and the actual
  // `process.exit(0)` — a request admitted in that gap would start
  // executing and then have the process die out from under it (worse than
  // the pre-fix -32603: a silently killed in-flight call instead of an
  // immediate, clear rejection the caller can retry). Once `exitCommitted`
  // is true the `tools/call` handler's gate rejects new admissions exactly
  // like `draining` does — the decision to exit is final at that point, so
  // there is nothing left to gain by admitting more work, and the
  // FLUSH_BUFFER_MS gap exists solely to let the transport flush already-
  // sent bytes, not to accept new requests.
  private exitCommitted = false;

  // mt#2701: max time to wait for in-flight tool calls to drain before a
  // staleness exit force-terminates. Overridable in tests. A wedged request
  // cannot keep a stale server alive past this cap.
  private staleDrainCapMs = 30_000;

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
    this.connectionTracker = options.connectionTracker;

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
   * workspace. Tools without the flag (false or unset) pass through.
   *
   * **This gate is a race-window backstop, not the primary staleness mechanism
   * (mt#3924).** Detecting staleness already makes the server remove itself:
   * `triggerStaleSignal` records a `staleness_exit`, sets `pendingStaleExit` and
   * schedules the process to exit at the first idle gap (mt#2830), after which the
   * stdio proxy respawns it on the current build (mt#1714 + mt#1740). What this
   * gate covers is the span between the flag latching and that exit landing —
   * calls keep being served normally in the meantime, by design.
   *
   * That window is why the measured numbers look mismatched and are not: 2,492
   * staleness exits in the 30 days to 2026-08-11 (89/day) produced 3 gate refusals
   * in ~70 days of transcripts. Both sides of the refusal set's scope are priced
   * against the window, not against the exit rate — see mt#3924's `## Outcome` for
   * the decision and `CommandDefinition.mutating`'s docblock for what the set
   * covers and what it deliberately leaves out.
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
        `This call is refused because its effect is irreversible, bulk, or schema-migrating ` +
        `and this build predates the workspace. Retry in ~30s: the server schedules its own ` +
        `exit at the next idle gap and the stdio proxy respawns it on the current build. ` +
        `Only if minsky runs WITHOUT the proxy does this need a manual /mcp reconnect.`
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
    this.connectionTracker?.registerServer(server);

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

      // mt#3814: resident-memory admission. Distinct from the cap above in
      // WHAT it protects — the cap bounds concurrent sessions, this bounds the
      // process's memory footprint before the mt#3886 ceiling terminates it.
      // Refusing a NEW session while continuing to serve established ones is
      // the whole point: under a shared daemon the ceiling's self-terminate
      // costs every conversation on the machine at once, and this is the step
      // that exists between "serving normally" and "gone".
      if (this.sessionAdmissionGate) {
        const decision = this.sessionAdmissionGate();
        if (!decision.admit) {
          log.warn("mcp_session_reject", {
            reason: "memory_watermark",
            residentBytes: decision.residentBytes,
            watermarkBytes: decision.watermarkBytes,
            currentCount: this.httpSessions.size,
          });
          res
            .status(503)
            .set("Retry-After", String(this.SESSION_CAP_RETRY_AFTER_SECS))
            .json({
              jsonrpc: "2.0",
              error: {
                code: -32603,
                message: formatAdmissionRefusal(decision, this.SESSION_CAP_RETRY_AFTER_SECS),
              },
              id: null,
            });
          return;
        }
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
          this.connectionTracker?.unregisterServer(server);
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
          this.hasEverHadAnyHttpSession = true;
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
      this.hasEverHadAnyHttpSession = true;
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
      this.connectionTracker?.unregisterServer(session.server);
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
      // Only true `drain()` (SIGTERM/SIGINT graceful shutdown) sets `draining`
      // — staleness-exit sets `pendingStaleExit` instead, deliberately NOT
      // that flag, so a tool call arriving during the EARLY staleness drain
      // window is served normally instead of being rejected here (mt#2830).
      // `exitCommitted`, in contrast, IS checked here: once the exit decision
      // is taken (the idle gap is observed, or the hard cap elapses) there is
      // a short flush-buffer gap before process.exit(0) actually fires, and a
      // request admitted into THAT gap would be killed mid-execution rather
      // than cleanly rejected — worse than the original -32603 bug. See the
      // `exitCommitted` field comment and `scheduleStaleExitAfterDrain` for
      // where it is set (mt#2830 R1 fix).
      if (this.draining || this.exitCommitted) {
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
      this.inFlightRequests.set(trackingId, {
        toolName: request.params.name,
        startedAtMs: Date.now(),
      });

      // Resolve agentId once per tool call — used for last-touched-by semantics
      const callerIdentity = this.resolveCallerIdentity(server, extra as RequestExtras | undefined);
      const agentId = callerIdentity.agentId;

      // mt#1884: per-tool dispatch latency instrumentation (flat Braintrust event).
      // Start timestamp captured at dispatch entry; the event is emitted once in the
      // `finally` below so it fires on both success and error paths. `outcome` defaults
      // to "error" and is flipped to "success" immediately before the successful return;
      // `error_class` is captured in the inner catch. This is the Phase-1 flat-event
      // level of the mt#1778 trace-shape program (Phase-2 turn/step spans = mt#1837,
      // which must first extend the flat-only shared emitter).
      const dispatchStartMs = Date.now();
      let dispatchOutcome: "success" | "error" = "error";
      let dispatchErrorClass: string | undefined;

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

          // mt#2677: build a progress reporter bound to this request's
          // transport when the caller opted in via _meta.progressToken.
          const progressToken = (request.params as { _meta?: { progressToken?: string | number } })
            ._meta?.progressToken;
          const progress = buildProgressReporter(progressToken, extra.sendNotification);

          // Inject the resolved caller agentId as `callerActorId` for the tools that
          // need caller identity (mt#3121, extended mt#4408). Two consumers, two reasons:
          //   - tasks.dispatch-recover EXCLUDES the caller's own task-grain presence claims
          //     from its contested check, so a caller is never flagged as its own peer.
          //   - observability.calibration-review takes its concurrency claim AS the caller.
          //     Without this, `resolveActorId` falls back to harness env vars the long-lived
          //     MCP server process does not have, and every MCP-invoked pass runs unclaimed.
          // Membership is EXACT (canonical name + Claude-Desktop alias, both registered),
          // never a substring. The server overwrites any caller-supplied value, so it
          // cannot be spoofed here.
          if (CALLER_ACTOR_ID_TOOL_NAMES.has(request.params.name)) {
            const injectedArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
            injectedArgs.callerActorId = agentId;
            request.params.arguments = injectedArgs;
          }

          // mt#4451: capabilities scoped to the connection that made THIS call.
          // `server` is this handler's own connection — `setupRequestHandlers`
          // takes it as a parameter and `createServer` registers the handler on
          // the same instance it just built, so no plumbing is needed to obtain
          // it. Built per request rather than per connection because the SDK
          // populates `getClientCapabilities()` during `initialize`, which may
          // not have completed when the connection was created.
          //
          // This replaces a process-wide lookup: under ADR-038's shared daemon
          // every conversation registers into one process, so asking "does ANY
          // connection support elicitation" let one connected client decide
          // routing for asks filed by every other, and dispatch to an arbitrary
          // one of them. `connectionTracker` still answers the fleet-wide
          // question, under a name that says so.
          const callerCapabilities: ClientCapabilityRegistry =
            new SingleConnectionCapabilityRegistry(server);

          const result = await tool.handler(
            request.params.arguments || {},
            progress,
            callerCapabilities
          );

          // Write agentId to any touched session record (fire-and-forget, non-blocking)
          this.writeAgentIdToSession(request.params.arguments || {}, agentId).catch((err) => {
            log.debug("agentId session update failed (non-blocking)", {
              error: getErrorMessage(err),
              tool: request.params.name,
            });
          });

          // mt#2562: Write task-grain presence claim (fire-and-forget, session-independent).
          // Fires whenever args.task or args.taskId is present — no Minsky session required.
          // mt#3889: except for presence-READ tools, which must not refresh the very
          // claims they were asked to report.
          this.writeTaskClaim(request.params.arguments || {}, agentId, tool.readsPresence).catch(
            (err) => {
              log.debug("presence claim write failed (non-blocking)", {
                error: getErrorMessage(err),
                tool: request.params.name,
              });
            }
          );

          // mt#2284: Write session-grain runtime-attachment claim (fire-and-forget).
          // Session-SCOPED (unlike writeTaskClaim) — requires a resolvable session,
          // same resolution priority as writeAgentIdToSession.
          this.writeSessionAttachment(request.params.arguments || {}, agentId).catch((err) => {
            log.debug("session attachment write failed (non-blocking)", {
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
          // mt#4526: bounded like the wake drain below. Memory enrichment is the OTHER
          // awaited DB-backed step on this path, so a deadline scoped to the wake drain
          // alone would leave an identical hang right here. On expiry the tool call
          // proceeds without the block — enrichment is additive by contract.
          const enrichmentResult = await raceEnrichmentDeadline(
            enrichToolResponse(
              request.params.name,
              request.params.arguments || {},
              this.memoryService
            ),
            ENRICHMENT_DEADLINE_MS
          );
          if (enrichmentResult === DEADLINE_EXCEEDED) {
            log.cli(
              `memory.enrichment.timed_out ${JSON.stringify({
                event: "memory.enrichment.timed_out",
                tool: request.params.name,
                budgetMs: ENRICHMENT_DEADLINE_MS,
              })}`
            );
          }
          const enrichmentBlock = enrichmentResult === DEADLINE_EXCEEDED ? null : enrichmentResult;

          // mt#1661 v0: wake-enrichment middleware. For allowlisted tools, drains
          // undelivered wake_pending rows for the calling session and appends a
          // `<wake-events>` content block. No-op when the wakeService /
          // sessionResolver are unset, the tool is not allowlisted, the caller
          // carried no resolvable session arg, or there were no pending wakes.
          // Errors are logged at `wake.enrichment.failed` and suppressed —
          // enrichment failure must NEVER break the underlying tool call.
          // mt#4476: also pass the caller's conversation-grain identity, so an
          // answered ask reaches the conversation that filed it on ANY tool call
          // rather than only on the five that carry a session argument. Layer 1 is
          // withheld deliberately — it is a process hash, so every conversation on
          // this server would resolve the same value and drain each other's wakes.
          const wakeBlock = await enrichWakeResponse(
            request.params.name,
            request.params.arguments || {},
            this.wakeService,
            this.wakeSessionResolver,
            {
              callerAgentId: callerIdentity.layer === 1 ? undefined : callerIdentity.agentId,
            }
          );

          // Return MCP-compliant tool response
          dispatchOutcome = "success";
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
          dispatchErrorClass = error instanceof Error ? error.name : typeof error;
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
      } catch (dispatchError) {
        // mt#1884: capture error_class for pre-dispatch throws (e.g. unknown tool)
        // that bypass the inner catch, so the emitted latency event's error shape is
        // consistent across all failure paths. The inner catch already sets
        // dispatchErrorClass on the handler-throw path; only fill it when still unset.
        if (dispatchErrorClass === undefined) {
          dispatchErrorClass =
            dispatchError instanceof Error ? dispatchError.name : typeof dispatchError;
        }
        throw dispatchError;
      } finally {
        this.inFlightRequests.delete(trackingId);

        // mt#1884: emit the per-tool dispatch latency event (fire-and-forget).
        // `void` preserves the handler's control flow; the shared emitter never
        // throws and silently no-ops when Braintrust is unconfigured (e.g. CI).
        const dispatchDurationMs = Date.now() - dispatchStartMs;
        void this.emitDispatchEvent({
          output: {
            tool_name: request.params.name,
            duration_ms: dispatchDurationMs,
            outcome: dispatchOutcome,
            ...(dispatchErrorClass ? { error_class: dispatchErrorClass } : {}),
          },
          metadata: {
            request_id: String(trackingId),
            // The session/peer dimension (active-sessions count) is deferred to
            // mt#2289, which designs it deliberately; a per-connection identifier
            // is intentionally NOT emitted here (reviewer note on PR #2200).
            source: "minsky.mcp.server",
            timestamp: new Date(dispatchStartMs).toISOString(),
          },
        });
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
   * Uses the priority resolver: Layer 2 (_meta declared, an ordered key list)
   * > Layer 1 (ascribed). Reads clientInfo from the underlying SDK server for
   * Layer 1 kind normalization.
   *
   * `server` is the Server instance handling this specific request — for HTTP,
   * each session has its own Server and thus its own clientVersion.
   */
  private resolveCallerAgentId(server: Server, extras: RequestExtras | undefined): string {
    return this.resolveCallerIdentity(server, extras).agentId;
  }

  /**
   * As {@link resolveCallerAgentId}, but keeps the LAYER alongside the id.
   *
   * The layer is what tells a conversation-SCOPED identity (Layer 2/3 — declared in
   * `_meta`, or stamped there by the stdio proxy) apart from an ascribed Layer 1
   * process hash. Callers that address something to a conversation need that
   * distinction; callers that only need a "who touched this last" label do not,
   * which is why the plain wrapper above still exists.
   */
  private resolveCallerIdentity(
    server: Server,
    extras: RequestExtras | undefined
  ): { agentId: string; layer: 1 | 2 | 3 } {
    let clientInfoName: string | undefined;
    try {
      const clientVersion = server.getClientVersion();
      clientInfoName = (clientVersion as { name?: string })?.name;
    } catch {
      // getClientVersion() may throw if called before initialize completes
    }
    const resolved = resolveAgentIdWithLayer({
      extras,
      clientInfo: clientInfoName ? { name: clientInfoName } : undefined,
      declaredKeys: buildDeclaredIdentityKeys(this.options.protocolConversationIdKey),
      onFallback: (event) => this.reportIdentityFallback(event),
    });
    return { agentId: resolved.agentId, layer: resolved.layer };
  }

  /**
   * Log a resolution that fell through every declared key to Layer 1 (mt#3986).
   *
   * Layer 1 is a hash of (hostname, user, pid, start-time) — ADR-006 itself
   * says it is "not a conversation-scoped distinction" — so this line is the
   * moment presence claims, dispatch attribution and attention accounting stop
   * being conversation-scoped. Before this existed, that transition was
   * completely silent and only inferable later from bad attribution data.
   *
   * Rate policy lives here rather than in the resolver: a non-cooperating
   * client falls back on EVERY tool call, so the first occurrence of each
   * distinct Layer 1 id warns and the rest go to debug. Layer 1 ids are stable
   * per connection, which makes that one warning per client rather than one per
   * call.
   */
  private reportIdentityFallback(event: IdentityFallbackEvent): void {
    const isFirst = !this.reportedIdentityFallbacks.has(event.agentId);
    if (isFirst) {
      // Clear rather than stop adding when the cap is reached. Both bound the
      // memory; only this one keeps the mechanism alive — a set that fills and
      // then refuses new entries would warn about the FIRST N clients a daemon
      // ever saw and go permanently silent about every one after, which is the
      // silent degradation this whole task exists to end. Clearing costs a
      // periodic repeat warning for a still-connected client instead.
      if (this.reportedIdentityFallbacks.size >= IDENTITY_FALLBACK_REPORT_CAP) {
        this.reportedIdentityFallbacks.clear();
      }
      this.reportedIdentityFallbacks.add(event.agentId);
    }

    const detail = {
      keysTried: event.keysTried,
      layerThatAnswered: event.layer,
      agentId: redactAgentId(event.agentId),
    };

    if (isFirst) {
      log.warn(
        "Agent identity fell back to Layer 1 (ascribed): no declared conversation identity on this request",
        detail
      );
    } else {
      log.debug("Agent identity resolved at Layer 1 (ascribed)", detail);
    }
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
  private async writeTaskClaim(
    args: Record<string, unknown>,
    actorId: string,
    readsPresence?: boolean
  ): Promise<void> {
    // mt#3889: a presence READ must not write presence — an observation that
    // mutates what it observes cannot answer the question it was asked.
    // Concretely, `tasks.claims.list` is step 0 of the collision probe in
    // `user-preferences.mdc §Probe before claiming a shared resource`; before
    // this exemption, probing task T upserted a claim on T, so a long-stale
    // claim reported `stale: false` — the probe manufactured the freshness it
    // was checking for (measured 2026-08-09: two reads 3 minutes apart, no
    // other actor, each moving `lastRefreshedAt` to its own timestamp).
    //
    // mt#3903: the flag arrives from the TOOL (`CommandDefinition.readsPresence`
    // → command-mapper → the registered tool), not from a name matched against
    // a list in this file. Checked before the repo is resolved so the probe
    // costs nothing it did not already cost.
    if (readsPresence) return;

    const repo = await this.getPresenceClaimRepo();
    if (!repo) return;

    const taskId =
      (typeof args.task === "string" ? args.task : undefined) ||
      (typeof args.taskId === "string" ? args.taskId : undefined);

    if (!taskId) return;

    // Canonicalize the task id so the write path and the read path
    // (tasks.claims.list) key on the SAME subject_id — `mt#2562`, `2562`, and
    // `MT-2562` must not fragment into distinct rows (PR #1755 R1).
    const subjectId = normalizeTaskSubjectId(taskId);
    if (!subjectId) return;

    const projectId = await this.resolveProjectIdBestEffort();

    await repo.upsertClaim({
      subjectKind: "task",
      subjectId,
      actorId,
      ccConversationId: this.resolveCcConversationId(actorId),
      projectId,
    });

    log.debug("presence claim written", { taskId, actorId });
  }

  /**
   * The conversation a presence claim was written from (mt#3945).
   *
   * Derived from the caller's already-resolved `actorId`, which ADR-006 makes
   * the conversation-grain identity key — the same value the collision probe,
   * dispatch attribution and the workspace links all join on. Deriving means
   * `cc_conversation_id` cannot disagree with `actor_id`: for a
   * conversation-scoped actor the column IS the `conv:` segment, so the two
   * agree by construction rather than by both being read from the same place at
   * the same moment.
   *
   * Both writers previously read an env var instead, and each read a different
   * one. `writeTaskClaim` read `CC_CONVERSATION_ID`, which nothing sets — zero
   * of 6076 task rows ever carried a value. `writeSessionAttachment` read
   * `CLAUDE_CODE_SESSION_ID`, which Claude Code does set, but only into the
   * server process's environment AT SPAWN: a `/clear`, resume or fork changes
   * the conversation without respawning MCP servers, so the value goes stale
   * and stays stale for the life of the process (mt#3900, the same defect one
   * field over). Their apparent 88-of-88 agreement was two fields being wrong
   * together, not a correctness property.
   *
   * The env read survives ONLY as a last resort for a Layer-1 (`unknown:hash:`)
   * actor, where `actorId` names no conversation and this is the sole remaining
   * signal — 113 rows in prod. It is spawn-frozen there for exactly the reason
   * above, which is a floor, not a fix: the real remedy is for such callers to
   * reach Layer 2/3 so `actorId` carries the conversation. Deliberately NOT
   * consulted otherwise, and deliberately not a second opinion — a per-process
   * env read is the parallel identity source this change exists to retire, and
   * under a shared local daemon (ADR-038) it would be one value shared across
   * every conversation at once.
   */
  private resolveCcConversationId(actorId: string): string | undefined {
    // Ambient precedence, for the Layer-1 path only: CLAUDE_CODE_SESSION_ID
    // first, CC_CONVERSATION_ID second. Unifying two writers that read
    // different variables forces a choice, and this one is deliberate rather
    // than incidental — ADR-006 §Phase 2 names CLAUDE_CODE_SESSION_ID as the
    // variable Claude Code actually sets, and it is the only one of the two
    // ever observed populated (201 of 202 session rows; CC_CONVERSATION_ID has
    // never produced a value in 6076 task rows). A setup exporting both to
    // DIFFERENT values is a misconfiguration rather than a supported mode, so
    // it is surfaced once per process rather than silently resolved.
    const harnessValue = process.env.CLAUDE_CODE_SESSION_ID;
    const legacyValue = process.env.CC_CONVERSATION_ID;
    if (
      !this.warnedAmbientConversationConflict &&
      harnessValue &&
      legacyValue &&
      harnessValue !== legacyValue
    ) {
      this.warnedAmbientConversationConflict = true;
      log.warn("CLAUDE_CODE_SESSION_ID and CC_CONVERSATION_ID disagree", {
        using: "CLAUDE_CODE_SESSION_ID",
      });
    }

    return resolvePresenceConversationId(actorId, harnessValue ?? legacyValue);
  }

  /**
   * mt#2284: resolve the presence-claim repository, fast-path or per-call
   * (mirrors the pre-set-vs-container-build pattern buildAskRepository uses).
   * Shared by writeTaskClaim (mt#2562) and writeSessionAttachment (mt#2284).
   */
  private async getPresenceClaimRepo(): Promise<PresenceClaimRepository | null> {
    // Use pre-set repo (fast-path from one-shot startup wiring in start-command.ts),
    // or build per-call from the container (resilient fallback — mirrors
    // buildAskRepository which constructs new DrizzleAskRepository(db) on each call).
    // mt#2567: the one-shot wiring may not complete on proxy/staleness-respawned
    // servers, leaving presenceClaimRepo unset and making every call a no-op.
    let repo: PresenceClaimRepository | null = this.presenceClaimRepo ?? null;
    if (!repo) {
      if (!this.container?.has("persistence")) return null;
      try {
        const persistence = this.container.get("persistence") as {
          getDatabaseConnection?: () => Promise<unknown>;
        };
        if (!persistence.getDatabaseConnection) return null;
        const db = await persistence.getDatabaseConnection();
        if (!db) return null;
        const { buildPresenceClaimRepository } = await import("@minsky/domain/presence/index");
        repo = buildPresenceClaimRepository(db);
        if (!repo) return null;
      } catch {
        return null; // fail silently — presence tracking is best-effort
      }
    }
    return repo;
  }

  /**
   * mt#2284: resolve the caller's project scope, best-effort (shared by
   * writeTaskClaim and writeSessionAttachment). Fails silently — project
   * scope is informational for presence, never a hard requirement.
   */
  private async resolveProjectIdBestEffort(): Promise<string | undefined> {
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
          // No cast, and no shape check HERE (mt#4509; PR #3288 R1). `resolveProjectScope`
          // takes `unknown` and validates the handle itself, so a bad one is classified and
          // logged as `invalid-db-handle` in one place. Narrowing at this call site instead
          // would SUPPRESS that log — the handle would silently fail the `if` and vanish,
          // which is the failure mode this task exists to end.
          // A null handle stays silent: persistence not being ready is not a defect.
          if (rawDb) {
            const scope = await resolveProjectScope(identity, rawDb, "mcp.presence");
            const { isAllProjects } = await import("@minsky/domain/project/scope");
            // ProjectScope = string | AllProjects; narrow to string branch = the project UUID
            if (!isAllProjects(scope)) {
              return scope;
            }
          }
        }
      }
    } catch {
      // Fail silently — project scope is informational for presence
    }
    return undefined;
  }

  /**
   * mt#2284: self-registration write path for session runtime-attachment.
   * Fires at the same seam as writeAgentIdToSession — session-SCOPED (unlike
   * writeTaskClaim, which is session-independent): requires a resolvable
   * session (args.session/sessionId directly, or via args.task/taskId lookup).
   *
   * Records/refreshes a `subject_kind = "session"` presence claim keyed on
   * (sessionId, actorId) — repeated activity from the same actor refreshes
   * `registeredAt` (the domain-layer name for `lastRefreshedAt`) rather than
   * appending a duplicate row; a distinct actor (e.g. a subagent attached to
   * the same session workspace) produces its own row (set semantics).
   *
   * Runs fire-and-forget (caller catches errors). Failures are logged at
   * debug level and never surface to the MCP caller — attachment tracking is
   * best-effort, matching writeAgentIdToSession/writeTaskClaim's posture.
   */
  private async writeSessionAttachment(
    args: Record<string, unknown>,
    actorId: string
  ): Promise<void> {
    if (!this.container) return;

    const sessionName =
      (typeof args.session === "string" ? args.session : undefined) ||
      (typeof args.sessionId === "string" ? args.sessionId : undefined);

    let sessionId = sessionName;
    if (!sessionId) {
      const taskId =
        (typeof args.task === "string" ? args.task : undefined) ||
        (typeof args.taskId === "string" ? args.taskId : undefined);
      if (!taskId || !this.container.has("sessionProvider")) return;
      const sessionProvider = this.container.get(
        "sessionProvider"
      ) as import("@minsky/domain/session/types").SessionProviderInterface;
      const storageTaskId = taskId.replace(/^mt#/i, "");
      const record = await sessionProvider.getSessionByTaskId(storageTaskId);
      if (!record) return;
      sessionId = record.sessionId;
    }
    if (!sessionId) return;

    const repo = await this.getPresenceClaimRepo();
    if (!repo) return;

    const projectId = await this.resolveProjectIdBestEffort();

    const ccConversationId = this.resolveCcConversationId(actorId);
    // "Where" context — env bag of only-the-keys-present (emulator-agnostic;
    // stores env strings, introspects no terminal app). Claude Code sets
    // CLAUDE_CODE_ENTRYPOINT (e.g. "cli", "sdk-cli") — see
    // packages/domain/src/runtime/harness-detection.ts.
    const entrypoint =
      typeof process.env.CLAUDE_CODE_ENTRYPOINT === "string"
        ? process.env.CLAUDE_CODE_ENTRYPOINT
        : undefined;

    const TERMINAL_CONTEXT_KEYS = [
      "TERM_PROGRAM",
      "TERM_SESSION_ID",
      "TERM",
      "TMUX",
      "TMUX_PANE",
      "WEZTERM_PANE",
      "KITTY_WINDOW_ID",
    ] as const;
    const terminalContext: Record<string, string> = {};
    for (const key of TERMINAL_CONTEXT_KEYS) {
      const value = process.env[key];
      if (typeof value === "string") terminalContext[key] = value;
    }

    // pid: local stdio MCP servers are spawned AS A CHILD of the calling
    // harness process, so process.ppid is the caller's pid (OS-level fact,
    // no terminal-app introspection). This assumption does not hold for the
    // hosted-HTTP transport; process.ppid there is not a meaningful "who is
    // attached" signal, but recording it is still harmless (host/ccConversationId
    // remain the primary identifying context for that path).
    // (Cast mirrors diagnostic-capture.ts's ExtendedProcess — this repo's
    // legacy ambient `process` shim, src/types/node.d.ts, omits `ppid`.)
    const ppid = (process as typeof process & { ppid?: number }).ppid;
    const pid = typeof ppid === "number" ? ppid : undefined;

    try {
      await repo.upsertClaim({
        subjectKind: "session",
        subjectId: sessionId,
        actorId,
        ccConversationId,
        host: hostname(),
        projectId,
        pid,
        entrypoint,
        terminalContext: Object.keys(terminalContext).length > 0 ? terminalContext : undefined,
      });
      log.debug("session attachment written", { sessionId, actorId, pid });
    } catch (err) {
      log.debug("session attachment write failed (non-blocking)", {
        error: getErrorMessage(err),
        sessionId,
      });
    }
  }

  /**
   * Begin a staleness-driven shutdown (mt#1315 mechanism, mt#2701 drain, mt#2830
   * idle-gap sequencing): emit a notifications/message at level=alert, tag the
   * upcoming exit as `staleness_exit`, set `pendingStaleExit` (NOT `draining` —
   * see the field comment), then wait for the first IDLE GAP — the moment
   * `inFlightRequests` reaches 0 — before scheduling `process.exit(0)` after a
   * 200ms flush buffer. A hard cap (`staleDrainCapMs`) force-exits if the server
   * is never idle for that long.
   *
   * Only fires once per process lifetime (guarded by hasTriggeredStaleSignal).
   *
   * mt#2830: requests already in flight when staleness is detected are waited
   * on (mt#2701's original guarantee — the detecting call is itself in flight
   * until its `finally` runs, so the drain waits for it and every concurrent
   * sibling to respond first). NEW requests that arrive DURING the drain window
   * are also served normally — they are NOT rejected — because `draining`
   * (the flag the `tools/call` handler gates on) is intentionally left false.
   * This closes the -32603 "Server is shutting down" gap: a caller issuing a
   * tool call while a staleness exit is pending gets a normal response on the
   * still-loaded ("old") code, exactly as it would have moments earlier. The
   * freshness guarantee is unchanged for the POST-exit world — the next call
   * after the process actually exits and is respawned gets the new HEAD.
   *
   * See scheduleStaleExitAfterDrain.
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

    // mt#2830: set pendingStaleExit (NOT draining) so the exit is sequenced
    // into the first idle gap while new tool calls keep being served normally
    // in the meantime. See the field comments and this method's docstring.
    this.pendingStaleExit = true;
    this.scheduleStaleExitAfterDrain();
  }

  /**
   * Poll until no tool call is in flight (or `staleDrainCapMs` elapses), then
   * schedule the process exit after a short flush buffer so the final response
   * reaches the transport before the process dies (mt#2701).
   *
   * mt#2830: `inFlightRequests` counts BOTH requests that were already
   * executing when staleness was detected AND new requests that arrive while
   * `pendingStaleExit` is true (the `tools/call` handler does not reject them
   * — see `pendingStaleExit`'s field comment). So a steady trickle of new
   * calls naturally extends the drain past a single request's lifetime; this
   * is intentional ("first idle gap", not "first response"). `staleDrainCapMs`
   * is the backstop: if the server is never idle for that long, the exit
   * fires anyway so staleness cannot be starved indefinitely by continuous
   * traffic.
   *
   * mt#2830 R1 fix: the exit DECISION (idle gap observed, or hard cap
   * elapsed) and marking `exitCommitted = true` happen in the same
   * synchronous section — `poll()` calls `scheduleExit()` as a plain,
   * unawaited function call, and `scheduleExit()`'s first statement is the
   * flip. No request-handler code can run between the counter check and the
   * flip (the event loop cannot interleave within a synchronous call chain),
   * so a request cannot be admitted "in between" the decision and its
   * enforcement. From that flip onward the `tools/call` handler's gate
   * rejects new admissions (mt#2830 field comment on `exitCommitted`) for
   * the remaining `FLUSH_BUFFER_MS` gap before `process.exit(0)` actually
   * fires — closing the window where an admitted-then-orphaned request would
   * be killed mid-execution instead of cleanly rejected.
   */
  private scheduleStaleExitAfterDrain(): void {
    const POLL_INTERVAL_MS = 50;
    const FLUSH_BUFFER_MS = 200;
    const start = Date.now();

    const scheduleExit = (wedgedRequests: number): void => {
      // mt#2830 R1 fix: flip BEFORE any logging/async work below — this is
      // the exit-commitment point. See this method's docstring.
      this.exitCommitted = true;
      if (wedgedRequests > 0) {
        log.warn("MCP staleness drain cap reached — exiting with requests still in flight", {
          wedgedRequests,
          capMs: this.staleDrainCapMs,
        });
      } else {
        log.debug("MCP staleness drain complete — all in-flight requests finished", {
          drainMs: Date.now() - start,
        });
      }
      setTimeout(() => this.exit(0), FLUSH_BUFFER_MS);
    };

    const poll = (): void => {
      const inFlight = this.inFlightRequests.size;
      if (inFlight === 0) {
        scheduleExit(0);
        return;
      }
      if (Date.now() - start >= this.staleDrainCapMs) {
        scheduleExit(inFlight);
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();
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
          this.connectionTracker?.unregisterServer(entry.server);
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
      this.connectionTracker?.unregisterServer(this.server);

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
   * The tool calls in flight right now, with how long each has been running.
   *
   * Read by the mt#3973 resident-memory capture when a process crosses its
   * watermark, so the artifact names what the process was doing rather than
   * only how large it had grown. `nowMs` is a parameter rather than a `Date.now()`
   * call so the elapsed figures are consistent across the set and the method is
   * testable without patching the clock.
   */
  getInFlightToolCalls(nowMs: number = Date.now()): InFlightToolCall[] {
    return Array.from(this.inFlightRequests.values()).map((state) => ({
      toolName: state.toolName,
      elapsedMs: nowMs - state.startedAtMs,
    }));
  }

  /**
   * Install (or clear) the resident-memory session-admission gate (mt#3814).
   *
   * A setter rather than a constructor option because the gate needs the
   * ceiling value resolved by `orphan-exit.ts` at wiring time in
   * `start-command.ts`, which happens well after the server is constructed.
   */
  setSessionAdmissionGate(gate: AdmissionGate | null): void {
    this.sessionAdmissionGate = gate;
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
   * mt#3764: true once the first HTTP MCP session has EVER been
   * established, and stays true afterward even if all sessions later
   * close/reap. Feeds the never-connected idle-exit watcher in
   * `orphan-exit.ts` — deliberately NOT the same as `getSessionCount() > 0`,
   * which only reflects currently-open sessions.
   */
  hasEverHadHttpSession(): boolean {
    return this.hasEverHadAnyHttpSession;
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
