import fs from "fs";
import path from "path";
import { createServer } from "http";
import { Command } from "commander";
// mt#1719 Intervention 2: `express`, `launchInspector`/`isInspectorAvailable`,
// and `resolveOAuthProvider` were top-level imports. They are HTTP-only
// (express, OAuth) or inspector-only (inspector-launcher) — pulling them
// in at module-load time costs ~10-30ms each on stdio cold-start where
// none of them run. Each is converted to function-local dynamic import
// at its sole use site below. Type positions (`import("express").Request`)
// remain top-level since TS erases them at runtime.
import type { MinskyMCPServer } from "../../mcp/server";
import { CommandMapper } from "../../mcp/command-mapper";
import { RetryingInitController } from "../../mcp/init-retry";
import { log, setProcessRole } from "@minsky/shared/logger";
import { SharedErrorHandler } from "../../adapters/shared/error-handling";
import { getErrorMessage } from "@minsky/domain/errors/index";
import { createProjectContext } from "../../types/project";
import { exit } from "@minsky/shared/process";
import { CommandCategory } from "../../adapters/shared/command-registry";
import { registerSharedCommandsWithMcp } from "../../adapters/mcp/shared-command-integration";
import { registerSessionWorkspaceTools } from "../../adapters/mcp/session-workspace";
import { registerSessionFileTools } from "../../adapters/mcp/session-files";
import { registerSessionEditTools } from "../../adapters/mcp/session-edit-tools";
import { registerKnowledgeResources } from "../../adapters/mcp/knowledge-resources";
import { MCP_CATEGORY_ADAPTERS } from "./discovery-config";
import { buildAndStartScheduler } from "./scheduler-wiring";
import { assessPersistenceHealth } from "@minsky/domain/persistence/health";
import {
  createReadinessProbe,
  type ReadinessProbe,
  type ReadinessResult,
} from "@minsky/domain/persistence/readiness-probe";
import { buildMcpHealthResponse } from "../../mcp/health-payload";
import { resolveDeeplinkBridge } from "../../mcp/deeplink-bridge";
import { getPgRetryCounters } from "@minsky/domain/persistence/postgres-retry";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";

// Re-export the dispatch table for consumers that prefer importing from
// `start-command.ts`. Source of truth: `./discovery-config.ts` — a side-
// effect-free module that smoke scripts and unit tests can import without
// pulling in the MCP-server / HTTP / OAuth dependency graph.
//
// mt#2037: the prior exclusion-constant re-export was deleted alongside
// the constant itself. No in-repo consumers ever imported it; out-of-repo
// consumers (if any exist) would need to update their imports to remove
// the deleted symbol. The deletion is intentional, not a backward-compat
// break — the symbol has zero realistic consumers per the mt#2017 caller-
// graph analysis.
export { MCP_CATEGORY_ADAPTERS } from "./discovery-config";
import { setHostedMode } from "@minsky/domain/configuration/guard";
import { hasLocalGitCapability } from "@minsky/domain/utils/git-exec";
import { isHostedMcpServer, resolveMcpTransport } from "../../cli-discriminators";
import { MCPConnectionTracker } from "../../mcp/client-capabilities";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { EventEmitterWithTryEmit } from "@minsky/domain/events/emitter";
import { isEnrichmentEnabled } from "../../mcp/middleware/memory-enrichment";
import {
  isInstructionsBundleEnabled,
  composeMemoryBundle,
} from "../../mcp/middleware/memory-bundle";
// mt#1719 Intervention 2: `resolveOAuthProvider` top-level import deferred —
// pulls in `oidc-provider` + Koa middleware closure (~30-50ms estimated).
// Sole call site is inside `if (transportType === "http" && container)`
// block, so stdio mode never needs it. The type imports below are erased
// at runtime by TypeScript and stay top-level.
import type { OAuthIdentityProvider, OAuthValidationResult } from "@minsky/domain/oauth/types";
import { AGENT_ID_META_KEY } from "@minsky/domain/agent-identity/layer2";
// mt#3814: local shared MCP daemon lifecycle. Statically imported despite the
// cold-start discipline above — the module's whole dependency graph is
// node builtins plus `health-identity` (a pure function file), so there is no
// closure here worth deferring, and the bind-error handler needs it
// synchronously at `app.listen` time.
import {
  ensureLocalDaemonToken,
  writeDiscoveryRecord,
  removeDiscoveryRecord,
  probeHealthIdentity,
  classifyPortConflict,
  formatPortConflictFailure,
  findListenerPid,
  resolveLocalDaemonDefaults,
  DEFAULT_LOCAL_DAEMON_PORT,
  DEFAULT_LOCAL_DAEMON_HOST,
  LOCAL_DAEMON_IDLE_TIMEOUT_MS,
} from "../../mcp/daemon/local-daemon";
import {
  createAdmissionGate,
  resolveAdmissionWatermarkBytes,
} from "../../mcp/daemon/memory-admission";
import { profileCheckpoint } from "../../utils/cold-start-profile";

const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_HOST = "localhost";
const DEFAULT_HTTP_ENDPOINT = "/mcp";
const INSPECTOR_PORT = 5173;

/**
 * Vector dimension for the memory embeddings store.
 *
 * **TODO (mt#1631):** This dimension is hard-coded across three independent
 * MemoryService construction sites — `resolveMemoryService` (pre-existing),
 * `buildMemoryServiceForSpike` (this file), and `scripts/import-claude-code-memory.ts`.
 * Centralize via an embedding-service-derived dimension getter or a single
 * shared constant when those three sites are unified (PR #974 R2 BLOCKING).
 * Today's value (1536) matches `text-embedding-3-small`/`text-embedding-ada-002`,
 * which is what Minsky configures by default.
 */
const MEMORY_EMBEDDING_DIMENSION = 1536;

/**
 * Check a bearer-token authorization header against the expected token.
 *
 * Returns true only when the header is present in the form `Bearer <token>`
 * (case-insensitive on the scheme) AND the presented token matches exactly.
 *
 * Exported for tests. Callers with auth disabled should not invoke this.
 */
export function checkBearerAuth(header: string | undefined, expectedToken: string): boolean {
  if (!header || !expectedToken) return false;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const presented = match?.[1]?.trim();
  return !!presented && presented === expectedToken;
}

/**
 * Extract the raw bearer token string from an Authorization header.
 *
 * Returns the token string (without the "Bearer " prefix) if the header is
 * well-formed, or null if the header is absent or malformed.
 *
 * Exported for tests.
 */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Validate an OAuth bearer token and enforce RFC 8707 audience binding.
 *
 * - Calls `oauthProvider.validateToken(bearer)`.
 * - On `{ valid: true }`, checks that the token's `audience` matches `endpointUrl`
 *   (audience is allowed to be null only when endpointUrl is also null, i.e., no
 *   audience binding required — currently unused; production always passes an endpointUrl).
 *
 * Returns:
 *   `{ ok: true, agentId }` — token valid, audience matches, agentId ready to inject.
 *   `{ ok: false, reason }` — validation failed or audience mismatch.
 *
 * Exported for tests.
 */
export async function validateOAuthBearer(
  bearer: string,
  oauthProvider: OAuthIdentityProvider,
  endpointUrl: string | null
): Promise<
  | { ok: true; agentId: string; validation: OAuthValidationResult & { valid: true } }
  | { ok: false; reason: string }
> {
  let result: OAuthValidationResult;
  try {
    result = await oauthProvider.validateToken(bearer);
  } catch (err) {
    log.error("[mt#1666] validateToken threw unexpectedly", { error: getErrorMessage(err) });
    return { ok: false, reason: "malformed" };
  }

  if (!result.valid) {
    return { ok: false, reason: result.reason };
  }

  // RFC 8707 audience binding: when the token was issued for a specific resource,
  // it must match the resource being accessed.
  if (result.audience !== null && endpointUrl !== null && result.audience !== endpointUrl) {
    log.warn("[mt#1666] audience mismatch", {
      tokenAudience: result.audience,
      endpointUrl,
    });
    return { ok: false, reason: "audience_mismatch" };
  }

  return { ok: true, agentId: result.principal.agentId, validation: result };
}

/**
 * Inject an OAuth-derived agentId into a JSON-RPC message's `params._meta`.
 *
 * mt#1765: The MCP SDK's `JSONRPCRequestSchema` is `.strict()` — any extra
 * top-level key fails the union parse and the SDK returns `-32700 Parse error:
 * Invalid JSON-RPC message`. Request-scoped `_meta` must live inside
 * `params._meta`, which the SDK surfaces to handlers as `RequestHandlerExtra._meta`
 * (the location Layer 2's `readLayer2` reads from).
 *
 * Behavior:
 * - Only injects when `params` is a non-array object (or absent — in which case a
 *   fresh `params: { _meta: {...} }` is created). When `params` is an array
 *   (positional parameters, valid per JSON-RPC 2.0 but not used by MCP today)
 *   or any other non-object value, the message is returned unchanged so the
 *   middleware never clobbers caller-provided positional payloads (PR #1064 R1
 *   BLOCKING).
 * - Cooperative Layer 2: if the caller has already declared
 *   `params._meta[AGENT_ID_META_KEY]`, the existing value wins and the message
 *   is returned unchanged.
 *
 * Exported for tests so the regression suite exercises the real implementation
 * rather than a hand-mirrored copy (PR #1064 R1 NON-BLOCKING #1).
 */
export function injectAgentIdMeta(
  msg: Record<string, unknown>,
  agentId: string
): Record<string, unknown> {
  // Array params (positional) is valid JSON-RPC 2.0; do not clobber it.
  // Any non-object, non-undefined `params` value is also left untouched.
  if (msg.params !== undefined) {
    if (typeof msg.params !== "object" || msg.params === null || Array.isArray(msg.params)) {
      return msg;
    }
  }
  const existingParams = (msg.params as Record<string, unknown> | undefined) ?? {};
  const existingParamsMeta =
    existingParams._meta &&
    typeof existingParams._meta === "object" &&
    !Array.isArray(existingParams._meta)
      ? (existingParams._meta as Record<string, unknown>)
      : {};
  if (existingParamsMeta[AGENT_ID_META_KEY]) return msg;
  return {
    ...msg,
    params: {
      ...existingParams,
      _meta: { ...existingParamsMeta, [AGENT_ID_META_KEY]: agentId },
    },
  };
}

/**
 * Register all MCP tool adapters on the given command mapper.
 *
 * Uses a discovery loop over `Object.values(CommandCategory)` (mt#2010,
 * subsumes mt#1521). Categories in `MCP_CATEGORY_ADAPTERS` use their
 * per-category adapter(s) (preserving per-command overrides); categories
 * without an entry are auto-bridged via `registerSharedCommandsWithMcp`.
 *
 * Native MCP tools (session-workspace, session-files, session-edit-tools)
 * register directly via `commandMapper.addCommand` rather than going through
 * the shared command registry, so they are NOT covered by the discovery loop —
 * they are invoked explicitly below.
 *
 * mt#2037: the prior narrowed-deployment opt-out (mt#1521 / mt#1227 / mt#1254
 * hook) was deleted per the mt#2017 investigation — none of the realistic
 * narrowing use cases needed the boot-time function-parameter shape.
 * Per-request narrowing belongs at OAuth-scope (mt#1666); per-deployment
 * belongs at env-var read in `createStartCommand`. See ADR-011 §Retraction
 * and the inline comment in discovery-config.ts.
 */
async function registerAllTools(
  commandMapper: CommandMapper,
  container?: import("@minsky/domain/composition/types").AppContainerInterface
): Promise<void> {
  // mt#1751: Tool handlers (which need persistence) await the server's
  // `initPromise` before dispatching, so the container is NOT eagerly
  // initialized here. For stdio mode, the caller in `createStartCommand`
  // kicks off `container.initialize()` in the background and wires it via
  // `server.setInitPromise()`. For HTTP mode, `src/cli.ts`'s preAction has
  // already run init synchronously before this function is called.
  //
  // Pre-mt#1751 a defensive eager `container.initialize()` ran here as a
  // safety net. That defense is gone: it would defeat the stdio defer.

  // Health check (HTTP-mode only — preAction already ran init eagerly).
  // For stdio mode, sessionProvider becomes available after the background
  // init resolves, so the check is meaningless until then.
  if (container && container.has("persistence") && !container.has("sessionProvider")) {
    log.error(
      "MCP startup health check failed: sessionProvider not available after container init. " +
        "Session tools will fail. Check database connectivity."
    );
  }

  // Native MCP tools — registered directly via commandMapper.addCommand
  // (NOT bridged through the shared command registry). These are session
  // file/edit tools with bespoke runtime semantics; the discovery loop
  // below covers everything else.
  registerSessionWorkspaceTools(commandMapper, container);
  registerSessionFileTools(commandMapper, container);
  registerSessionEditTools(commandMapper, container);

  // Discovery loop: every CommandCategory gets bridged exactly once. Dispatch
  // to per-category adapter(s) if registered; otherwise auto-bridge with no
  // overrides. New categories added to the enum + registered with shared
  // commands surface in MCP `tools/list` without editing this file.
  for (const category of Object.values(CommandCategory)) {
    const adapters = MCP_CATEGORY_ADAPTERS[category];
    if (adapters && adapters.length > 0) {
      log.debug(`[MCP] Registering category ${category} via ${adapters.length} adapter(s)`);
      for (const adapter of adapters) {
        adapter(commandMapper, container);
      }
    } else {
      // Auto-bridge: no per-category adapter, no overrides. The bridge
      // function is idempotent on empty categories (CORE has no commands),
      // so this is safe to call unconditionally.
      log.debug(`[MCP] Auto-bridging category ${category} (no per-category adapter)`);
      registerSharedCommandsWithMcp(commandMapper, {
        categories: [category],
        container,
      });
    }
  }
}

/**
 * Validate and resolve the repository path from options.
 * Returns a ProjectContext or undefined if no repo option was provided.
 */
function resolveProjectContext(
  repoPath?: string
): ReturnType<typeof createProjectContext> | undefined {
  if (!repoPath) return undefined;

  const repositoryPath = path.resolve(repoPath);
  if (!fs.existsSync(repositoryPath)) {
    log.cliError(`Repository path does not exist: ${repositoryPath}`);
    exit(1);
  }
  if (!fs.statSync(repositoryPath).isDirectory()) {
    log.cliError(`Repository path is not a directory: ${repositoryPath}`);
    exit(1);
  }

  try {
    const ctx = createProjectContext(repositoryPath);
    log.debug("Using repository path from command line", { repositoryPath });
    return ctx;
  } catch (error) {
    log.cliError(`Invalid repository path: ${repositoryPath}`);
    if (SharedErrorHandler.isDebugMode() && error instanceof Error) {
      log.cliError(getErrorMessage(error));
    }
    exit(1);
  }
}

/**
 * Compose the externally-observed base URL of an incoming request, honoring
 * Express's `trust proxy` config so the result reflects the public-facing
 * URL (e.g. `https://minsky-mcp-production.up.railway.app`) rather than the
 * internal listener (`http://0.0.0.0:8080`). Used for OAuth Discovery
 * metadata's `issuer` and `resource` fields, which RFC 8414/9728 require to
 * match the URL the client used to fetch the metadata.
 *
 * Falls back to "localhost" only if `req.hostname` is missing entirely
 * (very rare; usually only in malformed requests). The metadata document is
 * served best-effort in that case rather than 500'ing the probe.
 */
export function composeRequestBaseUrl(req: import("express").Request): string {
  const host = req.hostname || "localhost";
  return `${req.protocol}://${host}`;
}

/**
 * Build the RFC 9728 §5.1 `WWW-Authenticate: Bearer ...` challenge for a 401
 * from the OAuth-protected MCP endpoint. Always includes the `resource_metadata`
 * parameter pointing at this server's protected-resource-metadata document
 * (`${baseUrl}/.well-known/oauth-protected-resource`), so a spec-compliant MCP
 * client can discover the authorization server straight from the 401 instead of
 * having to know to probe the well-known path itself. Optional RFC 6750
 * `error` / `error_description` parameters describe an invalid/expired/revoked
 * token. The base URL is derived from the request (honoring `trust proxy`), so
 * it matches the URL the client actually used to reach the resource. mt#2493.
 */
/**
 * Escape a value for use inside an RFC 7230 `quoted-string` (the form
 * `WWW-Authenticate` auth-param values take). Backslash MUST be escaped before
 * the double-quote, otherwise the backslash inserted to escape a `"` would
 * itself be re-escaped. Today's callers pass fixed token-like strings, but the
 * helper is exported, so this guards a future caller from passing a value with
 * a `"` or `\` that would otherwise break header framing or inject a parameter.
 */
function escapeQuotedString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function composeWwwAuthenticate(
  req: import("express").Request,
  opts?: { error?: string; errorDescription?: string }
): string {
  const resourceMetadataUrl = `${composeRequestBaseUrl(req)}/.well-known/oauth-protected-resource`;
  const params: string[] = [];
  if (opts?.error) params.push(`error="${escapeQuotedString(opts.error)}"`);
  if (opts?.errorDescription) {
    params.push(`error_description="${escapeQuotedString(opts.errorDescription)}"`);
  }
  params.push(`resource_metadata="${escapeQuotedString(resourceMetadataUrl)}"`);
  return `Bearer ${params.join(", ")}`;
}

/**
 * Ensure a route path starts with a single leading slash. Used when the
 * user-configurable `--endpoint` value is embedded into a public metadata
 * URL: `--endpoint mcp` (no leading slash) would otherwise produce an
 * invalid URL like `https://example.commcp`.
 */
export function normalizeEndpointPath(endpoint: string): string {
  if (endpoint.startsWith("/")) return endpoint;
  return `/${endpoint}`;
}

/**
 * Start the MCP server with HTTP transport.
 */
async function startHttpServer(
  server: MinskyMCPServer,
  options: {
    port: string;
    host: string;
    endpoint: string;
    requireAuth?: boolean;
    /** mt#3814: run as the shared local daemon (ADR-038). */
    localDaemon?: boolean;
  },
  projectContext?: ReturnType<typeof createProjectContext>,
  oauthProvider?: OAuthIdentityProvider,
  container?: AppContainerInterface
): Promise<void> {
  // mt#1719 Intervention 2: function-local dynamic import. Express is only
  // needed in HTTP mode; deferring this off the stdio-mode import graph
  // shaves the express closure (~10-20ms) off `mcp_command_module_loaded`.
  const { default: express } = await import("express");
  const app = express();
  // Trust exactly one proxy hop (Railway's edge / TLS terminator). Scoping
  // to `1` rather than `true` limits the X-Forwarded-* trust to one upstream
  // and avoids the unbounded-chain risk where a malicious client could spoof
  // their `req.ip`/`req.protocol` by injecting forged X-Forwarded-* headers
  // along multiple unverified hops. Required for the OAuth Discovery
  // endpoints to advertise the correct public `https://` URL.
  app.set("trust proxy", 1);
  app.use(express.json());

  // mt#3814 / ADR-038 §Question 5: the local daemon is auth-required, and it
  // supplies its own token rather than expecting the launcher to. Generation
  // is idempotent — the tray supervisor (mt#3815) and `minsky setup local-http`
  // (mt#3816) call the same helper, and only the first one to run mints. This
  // MUST run before the token is read below, which is why it sits here rather
  // than with the rest of the daemon wiring further down.
  if (options.localDaemon && !process.env.MINSKY_MCP_AUTH_TOKEN?.trim()) {
    const ensured = ensureLocalDaemonToken();
    process.env.MINSKY_MCP_AUTH_TOKEN = ensured.token;
    log.cli(
      `Local MCP daemon token ${ensured.created ? "generated at" : "read from"} ${ensured.path}`
    );
  }

  // Auth: bearer-token check. Enabled when MINSKY_MCP_AUTH_TOKEN is set OR
  // --require-auth was passed. /health remains public for Railway probes.
  // When --require-auth is explicit but no token configured, refuse startup
  // — silent no-auth with --require-auth would be the worst possible outcome.
  const rawToken = process.env.MINSKY_MCP_AUTH_TOKEN?.trim();
  const token = rawToken && rawToken.length > 0 ? rawToken : undefined;
  if (options.requireAuth && !token) {
    log.cliError(
      "--require-auth passed but MINSKY_MCP_AUTH_TOKEN env var is not set. " +
        "Set the token or omit --require-auth. Refusing to start in an undefined auth state."
    );
    exit(1);
  }
  type AuthState = { enabled: false } | { enabled: true; token: string };
  const auth: AuthState = token ? { enabled: true, token } : { enabled: false };
  if (auth.enabled) {
    log.cli(`HTTP MCP auth: bearer-token required (token length=${auth.token.length})`);
  } else {
    log.warn(
      "HTTP MCP starting WITHOUT authentication. Set MINSKY_MCP_AUTH_TOKEN to enable. " +
        "This is only safe on localhost or in a private network."
    );
  }

  // Set up CORS for development
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, mcp-session-id");
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
    } else {
      next();
    }
  });

  // Set up MCP endpoint (auth-gated when EITHER static-bearer OR OAuth is configured).
  //
  // Gating logic: enforce auth when `auth.enabled` (static bearer configured) OR
  // `oauthProvider` (OAuth provider wired) is present. If NEITHER is configured,
  // the endpoint is open — same as before this PR; the WARN log on startup
  // surfaces this state.
  //
  // Auth precedence within the gate: static-bearer match short-circuits (preserves
  // the local Claude Code daemon path); else fall through to OAuth validation when
  // oauthProvider is available.
  app.all(options.endpoint, async (req, res) => {
    const authRequired = auth.enabled || !!oauthProvider;
    if (authRequired) {
      const header = req.header("authorization") ?? req.header("Authorization");
      const staticOk = auth.enabled && checkBearerAuth(header, auth.token);

      if (staticOk) {
        // Static-bearer path: existing agentId logic (Layer 1 / Layer 2 from _meta).
        // No agentId injection needed — caller may declare their own via _meta.
      } else if (oauthProvider) {
        // OAuth-token path: try to validate as an OAuth-issued token.
        const bearer = extractBearer(header);
        if (!bearer) {
          // mt#2493: advertise OAuth discovery on the 401 per RFC 9728 §5.1.
          res.set("WWW-Authenticate", composeWwwAuthenticate(req));
          res.status(401).json({
            error: "unauthorized",
            message: "valid bearer token required",
          });
          return;
        }

        // Compose the endpoint URL for RFC 8707 audience binding.
        // The audience in the token must match the resource URL the token was issued for.
        //
        // Strict equality is intentional per Minsky's hosted MCP convention:
        // `/.well-known/oauth-protected-resource` advertises the resource as the
        // FULL endpoint URL (`${issuer}/mcp`), not just the origin. Tokens MUST be
        // issued with `resource=${issuer}/mcp` (RFC 8707) and matched here against
        // the same path-inclusive value. If a future operational mode needs
        // origin-only matching, that's a config flag — not a relaxation of the
        // default check.
        const baseUrl = composeRequestBaseUrl(req);
        const endpointUrl = `${baseUrl}${normalizeEndpointPath(options.endpoint)}`;

        const oauthResult = await validateOAuthBearer(bearer, oauthProvider, endpointUrl);
        if (!oauthResult.ok) {
          const errorCode =
            oauthResult.reason === "audience_mismatch" ? "invalid_token" : "unauthorized";
          const description =
            oauthResult.reason === "audience_mismatch"
              ? "audience mismatch"
              : oauthResult.reason === "expired"
                ? "token expired"
                : oauthResult.reason === "revoked"
                  ? "token revoked"
                  : "invalid token";
          // mt#2493: advertise OAuth discovery + the RFC 6750 token error on the
          // 401 per RFC 9728 §5.1, so a spec-compliant client can re-discover and
          // re-authorize.
          res.set(
            "WWW-Authenticate",
            composeWwwAuthenticate(req, { error: errorCode, errorDescription: description })
          );
          res.status(401).json({
            error: errorCode,
            error_description: description,
          });
          return;
        }

        // Inject agentId into the MCP request body's params._meta so Layer 2 picks it up.
        // mt#1765: see `injectAgentIdMeta` above for rationale (the SDK's JSON-RPC envelope
        // is strictly typed; _meta must live in params._meta, not at top level).
        // Only inject for POST requests that carry a body — GET (SSE) connections don't
        // carry a JSON body and don't have tool-call context.
        if (req.method === "POST" && req.body && typeof req.body === "object") {
          if (Array.isArray(req.body)) {
            // Batch request: inject per-item, preserving any item that isn't a plain object.
            req.body = req.body.map((item: unknown) =>
              item && typeof item === "object" && !Array.isArray(item)
                ? injectAgentIdMeta(item as Record<string, unknown>, oauthResult.agentId)
                : item
            );
          } else {
            req.body = injectAgentIdMeta(req.body as Record<string, unknown>, oauthResult.agentId);
          }
        }
      } else {
        // No OAuth provider available; static-bearer check already failed.
        // mt#2493: emit a bare RFC 6750 Bearer challenge. No `resource_metadata`
        // here — without an OAuth provider the
        // `/.well-known/oauth-protected-resource` route is not registered, so
        // there is nothing to advertise for discovery.
        res.set("WWW-Authenticate", "Bearer");
        res.status(401).json({
          error: "unauthorized",
          message: "valid bearer token required",
        });
        return;
      }
    }
    try {
      await server.handleHttpRequest(req, res);
    } catch (error) {
      log.error("HTTP request handling failed", {
        error: getErrorMessage(error),
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal server error",
          message: getErrorMessage(error),
        });
      }
    }
  });

  // Health check endpoint — always public, minimal body (safe to expose).
  // Railway and other uptime probes hit this; don't leak internal state.
  //
  // mt#2949: persistence liveness now gates the status code. During the
  // 2026-07-19 outage this endpoint stayed a static 200 regardless of
  // persistence state, so Railway reported the deployment SUCCESS while
  // every DB-backed tool was dead. `assessPersistenceHealth` distinguishes
  // "deliberately unconfigured" (no Postgres connection anywhere — the
  // expected local/dev/offline boot path, and the bundle-boot-smoke CI
  // gate's exact boot state) from "configured but unavailable" (a
  // connection string WAS configured but initialization failed — a genuine
  // outage): only the latter flips this endpoint to 503. See
  // packages/domain/src/persistence/health.ts for the full rationale.
  // mt#4471: bound on the readiness round trip, DERIVED from the ceiling it has
  // to fit inside rather than picked as a round number
  // (`decision-defaults.mdc §Thresholds`, CEILING case).
  //
  // The binding constraint is the tray supervisor's own HTTP request timeout:
  // `cockpit-tray/src-tauri/src/supervisor.rs:1244` sets `.timeout(2s)` on the
  // health request, inside a `POLL_INTERVAL` of 5s
  // (`supervisor/daemon_core.rs:51`). A probe slower than that budget makes the
  // whole request time out, and a timed-out request reads as "daemon DOWN"
  // rather than "daemon not ready" — two states with opposite recoveries. So
  // this must sit BELOW 2s with room for the rest of the response, not merely
  // below the poll interval.
  //
  // A healthy `select 1` is single-digit milliseconds, so 1500ms is ~2 orders
  // of magnitude of headroom over normal and still leaves 500ms of the tray's
  // budget. If that Rust timeout ever changes, this must change with it.
  const HEALTH_READINESS_PROBE_TIMEOUT_MS = 1_500;

  // mt#4471: one probe per process, created lazily on the first `/health` that
  // finds a connected provider. Deduplication lives inside the probe; this
  // memo just avoids rebuilding the closure per request.
  let readinessProbe: ReadinessProbe | undefined;

  /**
   * Build the probe bound to a specific provider. Extracted so startup can warm
   * it (below) with the same closure the route uses — a second closure would
   * open a second connection and defeat the point.
   */
  const ensureReadinessProbe = (provider: PersistenceProvider): ReadinessProbe => {
    readinessProbe ??= createReadinessProbe({
      timeoutMs: HEALTH_READINESS_PROBE_TIMEOUT_MS,
      runProbeQuery: async () => {
        // The TAGGED-TEMPLATE path, deliberately — not `.unsafe()`. mt#2773's
        // guard wraps `.unsafe()` with its own FIFO, so a probe sent through it
        // would report on that queue rather than on the pool. Since mt#4473
        // that queue also carries drizzle, which makes the distinction sharper
        // rather than weaker: a probe behind the admission gate would be
        // REFUSED after the admission deadline during exactly the condition it
        // exists to measure, reporting our own backpressure instead of the
        // pool's state. This acquires a real pool connection exactly as an
        // ordinary query does, which is what makes it end-to-end.
        const raw = await (
          provider as PersistenceProvider & {
            getRawSqlConnection?: () => Promise<unknown>;
          }
        ).getRawSqlConnection?.();
        if (!raw) {
          throw new Error("provider reports SQL capability but exposes no raw connection");
        }
        const sql = raw as (strings: TemplateStringsArray) => Promise<unknown>;
        await sql`select 1`;
      },
    });
    return readinessProbe;
  };

  // mt#4471: WARM the pool at startup, because postgres.js connects lazily and
  // the first query pays TCP + TLS + auth.
  //
  // Found by live verification, not by the unit tests, which all passed: a
  // freshly booted daemon's FIRST `/health` measured 1.505s and reported
  // `ready: false` with the saturation reason, while calls 2-4 returned
  // `ready: true` in ~90ms. That is a false negative — the daemon was healthy
  // and merely cold — and it is exactly the reading that would make a
  // health-driven supervisor (mt#4472) restart a working process.
  //
  // Fire-and-forget: the result is discarded because it is not a verdict about
  // anything yet, and a rejection cannot escape (the probe never rejects). Its
  // only job is to have paid the handshake before anything polls.
  //
  // RESIDUAL, stated rather than implied: `max_lifetime` (30-60 min) recycles
  // connections, so a later probe can still land on a fresh connect and blip
  // not-ready. That is why mt#4472 requires a PERSISTENCE threshold rather than
  // acting on a single poll — one blip that clears on the next poll is expected
  // behaviour here, not a degraded daemon.
  {
    const bootProvider = container?.has("persistence")
      ? (container.get("persistence") as PersistenceProvider)
      : undefined;
    if (bootProvider && assessPersistenceHealth(bootProvider).mode === "connected") {
      void ensureReadinessProbe(bootProvider).check();
    }
  }

  app.get("/health", async (_req, res) => {
    // `container.get()` is synchronous by design: `AppServices["persistence"]`
    // is typed as a plain `BasePersistenceProvider`, not a Promise. All async
    // factory resolution already happened inside `container.initialize()`
    // (awaited eagerly for HTTP mode in `src/cli.ts`'s preAction hook, before
    // this route is ever registered) — `.get()` just reads the already-
    // resolved value out of the container. Same synchronous-`.get()` pattern
    // as `buildWakeServiceForBridge` / `buildMemoryServiceForSpike` /
    // `buildSubagentDispatchTracker` / the OAuth provider wiring above, all in
    // this file. No `await` belongs here.
    const persistence = container?.has("persistence")
      ? (container.get("persistence") as PersistenceProvider)
      : undefined;
    const persistenceHealth = assessPersistenceHealth(persistence);
    // mt#4322: the body is built by `buildMcpHealthResponse` so the golden
    // contract in `contract/mcp-health-shape.json` can assert the SAME code
    // this route runs, rather than a copy of it. The per-field rationale moved
    // there with it — including why `unconfigured` stays a 200 while `ready` is
    // false, which is the invariant `bundle-boot-smoke` depends on.
    // mt#4471: `mode === "connected"` only says a SQL-capable provider object
    // exists. Round-trip it, so a pool that has stopped serving reports
    // not-ready instead of the `ready: true` this endpoint answered twice
    // during the 2026-08-23 outage.
    //
    // Skipped when there is nothing to round-trip against: `unconfigured` is
    // the offline/dev boot (already `ready: false` without a probe, and the
    // state `bundle-boot-smoke` asserts a 200 against), and `unavailable` is
    // already reporting the outage on its own evidence.
    let readiness: ReadinessResult | undefined;
    if (persistence && persistenceHealth.mode === "connected") {
      readiness = await ensureReadinessProbe(persistence).check();
    }
    // mt#4562: the route is the imperative shell — it reads the module-level
    // retry counters and hands them to the pure builder, which only renders.
    const health = buildMcpHealthResponse(
      persistenceHealth,
      new Date().toISOString(),
      readiness,
      getPgRetryCounters()
    );
    res.status(health.statusCode).json(health.body);
  });

  // mt#4604: https → minsky:// deeplink bridge. Public like /health — the whole
  // point is that a link pasted into Notion/GitHub/Slack works for a reader who
  // holds no bearer token. Posture this route must keep (PR #3362 R1): no auth,
  // no per-request or per-user state in the body (only the entity URI and the
  // id-derived label), no host self-reference, and Cache-Control: no-store on
  // every response so an intermediary never caches whatever a future edit
  // emits. Express percent-decodes params, so an id containing an encoded `/`
  // (%2F) would be split by the router and truncate req.params.id — fine for
  // every current id shape (task short ids, uuids, PR numbers, guard names),
  // none of which may contain `/`; revisit with a wildcard param if one ever
  // can.
  app.get("/r/:type/:id", (req, res) => {
    const result = resolveDeeplinkBridge(req.params.type, req.params.id);
    res
      .status(result.status)
      .type(result.contentType)
      .set("Cache-Control", result.cacheControl)
      .send(result.body);
  });

  // OAuth discovery + Dynamic Client Registration (mt#1634c).
  //
  // MCP clients (e.g., Claude Code's /mcp UI) probe these endpoints to
  // determine whether the server supports OAuth. When an oauthProvider is
  // available (wired via resolveOAuthProvider from the persistence container),
  // the real RFC 8414/9728/7591 implementations are used. Without a provider
  // (e.g., no DB at startup), the well-known endpoints return 503 Service
  // Unavailable and /register returns 400 with a parseable RFC 7591 error.
  //
  // Public-access posture (intentional): all of these endpoints sit
  // outside the bearer-auth check, parallel to /health. The probe must
  // succeed before the SDK has any auth credentials to send, otherwise
  // the fall-through never fires. The bodies leak no internal state.
  app.get("/.well-known/oauth-authorization-server", async (req, res) => {
    if (!oauthProvider) {
      res.status(503).json({
        error: "service_unavailable",
        error_description: "OAuth provider not configured; database connection required",
      });
      return;
    }
    try {
      const metadata = await oauthProvider.discoveryMetadata(req);
      res.json(metadata);
    } catch (err) {
      log.error("OAuth discovery metadata error", { error: getErrorMessage(err) });
      res.status(500).json({
        error: "server_error",
        error_description: "Failed to build OAuth authorization server metadata",
      });
    }
  });

  app.get("/.well-known/oauth-protected-resource", async (req, res) => {
    if (!oauthProvider) {
      res.status(503).json({
        error: "service_unavailable",
        error_description: "OAuth provider not configured; database connection required",
      });
      return;
    }
    try {
      const metadata = await oauthProvider.protectedResourceMetadata(req);
      res.json(metadata);
    } catch (err) {
      log.error("OAuth protected-resource metadata error", { error: getErrorMessage(err) });
      res.status(500).json({
        error: "server_error",
        error_description: "Failed to build OAuth protected resource metadata",
      });
    }
  });

  app.post("/register", async (req, res) => {
    if (!oauthProvider) {
      res.status(400).json({
        error: "registration_not_supported",
        error_description:
          "Dynamic Client Registration is not available; database connection required",
      });
      return;
    }
    try {
      const result = await oauthProvider.registerClient(req.body);
      res.status(201).json(result);
    } catch (err) {
      const message = getErrorMessage(err);
      log.error("DCR /register error", { error: message });
      // RFC 7591 §3.2.2: registration errors use error + error_description
      res.status(400).json({
        error: "invalid_client_metadata",
        error_description: message,
      });
    }
  });

  // OAuth authorize + token endpoints (mt#1665).
  // Delegates to the OAuthIdentityProvider (oidc-provider under the hood),
  // which enforces PKCE (S256 only), refresh-token rotation, and RFC 8707
  // audience binding internally.
  // When no provider is available (no DB), returns 503 service_unavailable —
  // consistent with the discovery endpoint pattern from mt#1664.
  app.get("/oauth/authorize", async (req, res) => {
    if (!oauthProvider) {
      res.status(503).json({
        error: "service_unavailable",
        error_description: "OAuth provider not configured; database connection required",
      });
      return;
    }
    try {
      await oauthProvider.authorize(req, res);
    } catch (err) {
      log.error("OAuth authorize error", { error: getErrorMessage(err) });
      if (!res.headersSent) {
        res.status(500).json({
          error: "server_error",
          error_description: "Authorization endpoint error",
        });
      }
    }
  });

  app.post("/oauth/token", async (req, res) => {
    if (!oauthProvider) {
      res.status(503).json({
        error: "service_unavailable",
        error_description: "OAuth provider not configured; database connection required",
      });
      return;
    }
    try {
      await oauthProvider.token(req, res);
    } catch (err) {
      log.error("OAuth token error", { error: getErrorMessage(err) });
      if (!res.headersSent) {
        res.status(500).json({
          error: "server_error",
          error_description: "Token endpoint error",
        });
      }
    }
  });

  // mt#1731 Bug-B fix: forward /interaction/:uid requests to the oidc-provider
  // PR #1042 R1: anchor the regex so it matches /interaction/<uid>(/anything)? but
  // NOT bare /interaction/ — oidc-provider's interaction routes always have at
  // least one path segment after /interaction/ (e.g. /interaction/:uid, /interaction/:uid/abort).
  app.all(/^\/interaction\/[^/]+/, async (req, res) => {
    if (!oauthProvider) {
      res.status(503).json({
        error: "service_unavailable",
        error_description: "OAuth provider not configured; database connection required",
      });
      return;
    }
    try {
      await oauthProvider.forwardInteraction(req, res);
    } catch (err) {
      log.error("OAuth interaction error", { error: getErrorMessage(err) });
      if (!res.headersSent) {
        res.status(500).json({
          error: "server_error",
          error_description: "Interaction endpoint error",
        });
      }
    }
  });

  // mt#1753: forward /auth/<uid> requests to oidc-provider. After devInteractions
  // consent is submitted, oidc-provider 302-redirects to /auth/<uid> (its internal
  // authorization-continuation endpoint) to issue the auth code and redirect back
  // to the client's redirect_uri. Express has no match for this path unless we
  // explicitly mount it. Mirrors the /interaction/<uid> handler exactly — same
  // forwardInteraction() method because /auth/<uid> is already oidc-provider's
  // internal path (no URL rewrite needed). The regex anchors after /auth/ to
  // require a uid segment, so the bare /oauth/authorize → /auth (rewritten) path
  // from mt#1731 is unaffected.
  app.all(/^\/auth\/[^/]+/, async (req, res) => {
    if (!oauthProvider) {
      res.status(503).json({
        error: "service_unavailable",
        error_description: "OAuth provider not configured; database connection required",
      });
      return;
    }
    try {
      await oauthProvider.forwardInteraction(req, res);
    } catch (err) {
      log.error("OAuth /auth/<uid> error", { error: getErrorMessage(err) });
      if (!res.headersSent) {
        res.status(500).json({
          error: "server_error",
          error_description: "Authorization-continuation endpoint error",
        });
      }
    }
  });

  // Start the HTTP server
  // NOTE: the `http://...` URLs printed below are the INTERNAL listener
  // (i.e., what Express binds to inside the container). In TLS-fronted
  // deployments (e.g., Railway), the externally-observed URL is `https://`
  // and may use a different host. The OAuth Discovery handlers above
  // derive the public URL from request headers via `composeRequestBaseUrl`
  // / `trust proxy`, so the metadata they emit reflects the externally-
  // observed URL even though these log lines do not.
  const httpPort = parseInt(options.port, 10);

  // PR #2871 R1 BLOCKING: construct the server and attach the bind-error
  // handler BEFORE listening, rather than attaching to what `app.listen()`
  // returns. Node defers an `EADDRINUSE` to `process.nextTick`, so attaching
  // afterwards is safe there — but this runs on Bun, and the correctness of
  // the adopt-or-fail path should not rest on a runtime's emit timing when
  // ordering the two lines removes the question entirely. An unhandled
  // 'error' on a server is a process crash, which is the failure mode this
  // handler exists to replace with a legible message.
  const httpServer = createServer(app);
  const onListening = (): void => {
    log.cli("Minsky MCP Server started with HTTP transport");
    log.cli(`Server listening on ${options.host}:${httpPort}`);
    log.cli(`MCP endpoint: http://${options.host}:${httpPort}${options.endpoint}`);
    log.cli(`Health check: http://${options.host}:${httpPort}/health`);
    if (projectContext) {
      log.cli(`Repository path: ${projectContext.repositoryPath}`);
    }
    log.cli("Ready to receive MCP requests via HTTP");

    // mt#3814: the discovery record is written from the LISTEN callback, not
    // before the bind, so the file can never advertise a port this process did
    // not actually get. It is for the supervisor, the CLI, and (mt#2430) hook
    // subprocesses — never for the MCP client, which reads a static config.
    if (options.localDaemon) {
      try {
        const written = writeDiscoveryRecord({
          port: httpPort,
          host: options.host,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        });
        log.cli(`Local MCP daemon discovery file: ${written}`);
      } catch (error) {
        // Non-fatal: a daemon nobody can discover still serves every client
        // that has the static URL, which is all of them today.
        log.warn("Failed to write the local MCP daemon discovery file (non-fatal)", {
          error: getErrorMessage(error),
        });
      }
    }
  };

  // mt#3814 / ADR-038 §Question 4: identity-asserting adopt-or-fail.
  //
  // Without a listener on 'error', an EADDRINUSE is an unhandled event that
  // crashes the process with a stack trace naming neither the port's owner nor
  // what to do about it. Two outcomes only — adopt an asserted `minsky-mcp`
  // incumbent, or fail loudly. Never bind elsewhere: the port is the contract
  // the static client config targets, so a "helpful" fallback produces a
  // running daemon no client can reach.
  //
  // Identity is asserted rather than inferred from a 200, because mt#3811
  // observed a client's own model spawning a competing daemon on this port
  // with its shell access — "something answers" is exactly the case this has
  // to discriminate.
  httpServer.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") {
      log.cliError(`HTTP server error: ${getErrorMessage(error)}`);
      exit(1);
      return;
    }
    if (!options.localDaemon) {
      log.cliError(`Port ${options.host}:${httpPort} is already in use.`);
      exit(1);
      return;
    }
    void (async () => {
      const probe = await probeHealthIdentity(`http://${options.host}:${httpPort}/health`);
      const decision = classifyPortConflict(probe);
      if (decision.action === "adopt") {
        log.cli(
          `Local MCP daemon already running on ${options.host}:${httpPort} — ${decision.detail}. ` +
            `Adopting the incumbent and exiting; the port has exactly one owner (ADR-014).`
        );
        exit(0);
        return;
      }
      log.cliError(
        formatPortConflictFailure({
          host: options.host,
          port: httpPort,
          pid: findListenerPid(httpPort),
          detail: decision.detail,
        })
      );
      exit(1);
    })();
  });

  // Bind LAST: every handler above is registered before the socket can produce
  // an event, so there is no window in which an EADDRINUSE has nowhere to go.
  httpServer.listen(httpPort, options.host, onListening);

  // Initialize the MCP server (without connecting transport since HTTP is on-demand)
  await server.start();
}

/**
 * Construct a MemoryService for the mt#1588 spike enrichment middleware.
 *
 * Spike-scope inline duplication of `resolveMemoryService`'s real-path branch
 * in `src/adapters/shared/commands/memory/index.ts`. If this spike graduates,
 * extract the shared construction logic into a `src/domain/memory/build.ts`
 * helper and have both call sites consume it.
 *
 * Returns null on any construction failure — the middleware degrades to a
 * no-op (the dispatcher behaves identically to pre-mt#1588).
 *
 * @see mt#1588 — this spike
 */
/**
 * Build the wake-pending service + session resolver for the mt#1661 v0
 * wake-enrichment middleware. Returns null when persistence is unavailable.
 *
 * The session resolver mirrors `writeAgentIdToSession`'s args-extraction order
 * (session/sessionId direct → task/taskId via session lookup). v0 covers only
 * the unambiguous addressing case; cross-session / agent-handoff delivery is
 * out of scope per mt#1506.
 *
 * @see mt#1661 — v0 short-term bridge spec
 * @see mt#1506 — long-term InterfaceBinding model that retires this v0
 */
async function buildWakeServiceForBridge(container: AppContainerInterface): Promise<{
  service: import("../../mcp/middleware/wake-enrichment").WakeServiceSurface;
  resolver: import("../../mcp/middleware/wake-enrichment").SessionResolver;
} | null> {
  try {
    const persistence = container.has("persistence") ? container.get("persistence") : undefined;
    if (!persistence) return null;

    const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
    if (!(persistence instanceof PersistenceProvider)) return null;
    if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
      return null;
    }
    const connection = await persistence.getDatabaseConnection();
    if (!connection) return null;

    const { DrizzleWakePendingRepository } = await import(
      "@minsky/domain/ask/wake-pending-repository"
    );
    const wakeRepo = new DrizzleWakePendingRepository(
      connection as import("drizzle-orm/postgres-js").PostgresJsDatabase
    );

    const sessionProvider = container.has("sessionProvider")
      ? (container.get(
          "sessionProvider"
        ) as import("@minsky/domain/session/types").SessionProviderInterface)
      : undefined;

    const resolver: import("../../mcp/middleware/wake-enrichment").SessionResolver = {
      async resolveParentSessionId(args: Record<string, unknown>): Promise<string | null> {
        // Priority 1: direct session arg matches `Ask.parentSessionId` produced
        // by mt#1180-class call sites that file Asks with parentSessionId = sessionId.
        const sessionName =
          (typeof args.session === "string" ? args.session : undefined) ||
          (typeof args.sessionId === "string" ? args.sessionId : undefined);
        if (sessionName) return sessionName;

        // Priority 2: task → session lookup. Mirrors `writeAgentIdToSession`'s
        // taskId-normalization (strip "mt#" prefix). Returns null when no
        // session exists for the task or sessionProvider is unavailable.
        const taskId =
          (typeof args.task === "string" ? args.task : undefined) ||
          (typeof args.taskId === "string" ? args.taskId : undefined);
        if (!taskId || !sessionProvider) return null;
        const storageTaskId = taskId.replace(/^mt#/i, "");
        const record = await sessionProvider.getSessionByTaskId(storageTaskId);
        return record?.sessionId ?? null;
      },
    };

    return { service: wakeRepo, resolver };
  } catch (err) {
    log.debug("[mt#1661] buildWakeServiceForBridge threw", {
      error: getErrorMessage(err),
    });
    return null;
  }
}

async function buildMemoryServiceForSpike(
  container: AppContainerInterface
): Promise<MemoryServiceSurface | null> {
  try {
    const persistence = container.has("persistence") ? container.get("persistence") : undefined;
    if (!persistence) return null;

    const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
    if (!(persistence instanceof PersistenceProvider)) return null;
    if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
      return null;
    }
    const connection = await persistence.getDatabaseConnection();
    if (!connection) return null;

    const { createEmbeddingServiceFromConfig } = await import(
      "@minsky/domain/ai/embedding-service-factory"
    );
    const embeddingService = await createEmbeddingServiceFromConfig();

    const { createVectorStorageForDomain } = await import(
      "@minsky/domain/storage/vector/vector-storage-factory"
    );
    const vectorStorage = await createVectorStorageForDomain(
      "memory",
      MEMORY_EMBEDDING_DIMENSION,
      persistence
    );

    const { MemoryService } = await import("@minsky/domain/memory");
    type MemoryServiceDb = import("@minsky/domain/memory/memory-service").MemoryServiceDb;
    return new MemoryService({
      db: connection as MemoryServiceDb,
      vectorStorage,
      embeddingService,
    });
  } catch (err) {
    log.debug("[mt#1588] buildMemoryServiceForSpike threw", {
      error: getErrorMessage(err),
    });
    return null;
  }
}

/**
 * Wire the SubagentDispatchTracker singleton (mt#1738).
 *
 * Calls `SubagentDispatchTracker.setInstance(db)` once the DB connection is
 * resolved. After this call, `debug.systemInfo` returns real dispatch cadence
 * aggregates rather than the zero-filled no-op defaults.
 *
 * Returns null when persistence is unavailable (CLI path, no Postgres
 * connection, or construction failure) — the singleton stays as the no-op
 * null-DB tracker, so `debug.systemInfo.subagentDispatches` returns zeros.
 *
 * A single attempt — no retry of its own. See `wireSubagentDispatchTrackerWithRetry`
 * below for the promise-memoized, bounded-timeout retry wrapper (mt#3044)
 * that callers should generally use instead of calling this directly.
 *
 * @see mt#1738 — this wiring
 * @see mt#1736 — SubagentDispatchTracker implementation
 * @see mt#3044 — retry wrapper (this function had no retry at all before)
 */
export async function buildSubagentDispatchTracker(
  container: AppContainerInterface
): Promise<boolean> {
  try {
    const persistence = container.has("persistence") ? container.get("persistence") : undefined;
    if (!persistence) return false;

    const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
    if (!(persistence instanceof PersistenceProvider)) return false;
    if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
      return false;
    }
    const connection = await persistence.getDatabaseConnection();
    if (!connection) return false;

    const db = connection as import("drizzle-orm/postgres-js").PostgresJsDatabase;
    const { SubagentDispatchTracker } = await import("../../mcp/subagent-dispatch-tracker");
    const { createEventEmitter } = await import("@minsky/domain/events/emitter");
    // mt#3044 R1 BLOCKING #1 (R3: import moved above this check — an
    // awaited dynamic import BETWEEN the check and `setInstance` would
    // reopen the exact race this guard exists to close, since another
    // concurrent attempt could pass its own `isWired()` check during that
    // yield): `wireSubagentDispatchTrackerWithRetry` clears its memo and
    // returns `false` once `SUBAGENT_TRACKER_WIRE_TIMEOUT_MS` elapses, but
    // the `getDatabaseConnection()` call THIS function is awaiting keeps
    // running in the background — it is not cancelable. If it later
    // resolves successfully, without this guard it would call `setInstance`
    // even though a NEWER attempt (triggered by a subsequent retry) may
    // have already wired the singleton first. Re-check immediately before
    // the side effect: NO `await` sits between this check and `setInstance`
    // below (only the synchronous `createEventEmitter(db)` call), so this
    // is genuinely race-free — nothing else can run between them on
    // Node/Bun's single-threaded event loop. Skip entirely when already
    // wired, rather than replacing a working instance with a stale one and
    // leaking the discarded EventEmitter this attempt would otherwise
    // construct.
    if (SubagentDispatchTracker.isWired()) {
      return true;
    }
    SubagentDispatchTracker.setInstance(db, createEventEmitter(db));
    return true;
  } catch (err) {
    log.debug("[mt#1738] buildSubagentDispatchTracker threw", {
      error: getErrorMessage(err),
    });
    return false;
  }
}

/**
 * Bounded-timeout used by `wireSubagentDispatchTrackerWithRetry` below.
 * Mirrors `TRACKER_INIT_TIMEOUT_MS` in registry-setup.ts's `getTracker()`.
 */
const SUBAGENT_TRACKER_WIRE_TIMEOUT_MS = 5000;

/**
 * Promise-memoized state for `wireSubagentDispatchTrackerWithRetry`. Module
 * scoped (not per-call) because there is exactly one MCP server — and
 * therefore exactly one SubagentDispatchTracker singleton — per process,
 * same lifetime assumption `buildSubagentDispatchTracker`'s call site
 * already made.
 */
let subagentTrackerWireAttemptInFlight: Promise<boolean> | null = null;

/**
 * Promise-memoized, bounded-timeout retry wrapper around
 * `buildSubagentDispatchTracker` (mt#3044).
 *
 * Mirrors the pattern mt#3017 added to registry-setup.ts's `getTracker()`
 * for the sibling (closure-cached) tracker path used by `tasks.dispatch` /
 * `tasks.dispatch-recover`:
 *   - A concurrent caller during an in-flight attempt awaits the SAME
 *     resolution rather than kicking off a duplicate DB-connection attempt.
 *   - On failure OR timeout the memo clears, so the NEXT call retries
 *     instead of the singleton latching to the no-op null-DB tracker for
 *     the rest of the process's life (the exact gap `buildSubagentDispatchTracker`
 *     had before mt#3044: it ran exactly once, fire-and-forget, at server
 *     startup, with no way for a failed attempt to ever be retried).
 *   - A hung `getDatabaseConnection()` call (neither resolves nor rejects)
 *     doesn't pin the memo forever — the `Promise.race` against `timeoutMs`
 *     bounds how long a caller (or the retry driver below) waits before the
 *     memo is freed for the next attempt.
 *
 * This function is BOTH the eager first attempt at MCP server startup (see
 * the call site) AND the callback `SubagentDispatchTracker.getInstance()`
 * invokes on every call while the singleton is unwired (registered once via
 * `SubagentDispatchTracker.registerWireAttempt` — see the call site). Using
 * the SAME memoized entry point for both means an eager startup attempt and
 * a `getInstance()`-triggered retry can never race into two concurrent DB
 * connection attempts.
 *
 * `timeoutMs` is exposed (default `SUBAGENT_TRACKER_WIRE_TIMEOUT_MS`) so
 * tests can exercise the bounded-timeout branch without a real 5s wait —
 * mirrors `getTrackerForDispatch`'s `timeoutMs` parameter in
 * dispatch-command.ts.
 *
 * @see mt#3017 — the reference implementation this mirrors (registry-setup.ts's getTracker)
 * @see mt#3044 — this task
 */
export function wireSubagentDispatchTrackerWithRetry(
  container: AppContainerInterface,
  timeoutMs: number = SUBAGENT_TRACKER_WIRE_TIMEOUT_MS
): Promise<boolean> {
  if (subagentTrackerWireAttemptInFlight) {
    return subagentTrackerWireAttemptInFlight;
  }

  const TIMEOUT_SENTINEL = Symbol("subagent-tracker-wire-timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
  });

  // Assigns directly to the outer `subagentTrackerWireAttemptInFlight` — no
  // local binding referencing itself — mirroring registry-setup.ts's
  // `getTracker()` inner-IIFE pattern exactly (`_trackerInitPromise = (async
  // () => { ... finally { _trackerInitPromise = null } })();`). On settle
  // (success, failure, OR timeout — `Promise.race` above is INSIDE this same
  // IIFE, not a separate outer race, so there is no case where a caller times
  // out while this IIFE keeps running independently) the memo unconditionally
  // clears so the NEXT call retries.
  subagentTrackerWireAttemptInFlight = (async () => {
    try {
      const result = await Promise.race([buildSubagentDispatchTracker(container), timeout]);
      return result === TIMEOUT_SENTINEL ? false : result;
    } catch (err) {
      log.debug("[mt#3044] SubagentDispatchTracker wire-retry attempt threw", {
        error: getErrorMessage(err),
      });
      return false;
    } finally {
      // mt#3044 R2 NON-BLOCKING: clear the timer when buildSubagentDispatchTracker
      // wins the race — otherwise it stays pending and fires later, resolving
      // the now-unused `timeout` promise. A tiny leak on its own, but one that
      // can accumulate across many quick retries with a short timeoutMs.
      clearTimeout(timeoutHandle);
      subagentTrackerWireAttemptInFlight = null;
    }
  })();
  return subagentTrackerWireAttemptInFlight;
}

/**
 * Build an EventEmitter for the EmbeddingsHealthTracker from the container's
 * persistence provider, or null when persistence is unavailable (mt#2568).
 *
 * Shared by the eager one-shot wiring attempt (`wireEmbeddingsHealthTracker`
 * below) and the per-call fallback builder registered with
 * `EmbeddingsHealthTracker.registerEventEmitterBuilder` at the call site —
 * so a degradation event that races the eager attempt still resolves the
 * SAME construction path on demand instead of being lost.
 */
async function buildEmbeddingsEventEmitter(
  container: AppContainerInterface
): Promise<EventEmitterWithTryEmit | null> {
  try {
    // mt#4218: both halves now come from shared domain helpers that the cockpit
    // and CLI hosts reach the same way — `resolveContainerPersistence` for the
    // container lookup, `buildEventEmitterFromProvider` for the construction.
    // The explicit `capabilities.sql` test is gone rather than relaxed: both
    // helpers test `getDatabaseConnection` for callability and for a non-null
    // result, which is the operative check and what every other emit site in
    // the codebase already uses.
    const { resolveContainerPersistence } = await import(
      "@minsky/domain/ai/embeddings-health-wiring"
    );
    const { buildEventEmitterFromProvider } = await import(
      "@minsky/domain/events/emit-best-effort"
    );
    return await buildEventEmitterFromProvider(await resolveContainerPersistence(container));
  } catch (err) {
    log.debug("[mt#2568] buildEmbeddingsEventEmitter threw", {
      error: getErrorMessage(err),
    });
    return null;
  }
}

/**
 * Wire the EmbeddingsHealthTracker singleton to a production EventEmitter (mt#2147).
 *
 * Called once the DB connection is resolved. After this call, the tracker can
 * emit `embeddings.provider_degraded` events to the `system_events` table.
 * Without this wiring, the tracker still tracks health in-memory (for
 * debug_systemInfo) but cannot persist events.
 *
 * A single eager attempt — no retry of its own. `registerEventEmitterBuilder`
 * (registered at the call site, mt#2568) gives the tracker a per-call
 * fallback so a degradation that races this eager attempt still emits.
 */
async function wireEmbeddingsHealthTracker(container: AppContainerInterface): Promise<boolean> {
  try {
    const emitter = await buildEmbeddingsEventEmitter(container);
    if (!emitter) return false;

    const { EmbeddingsHealthTracker } = await import("@minsky/domain/ai/embeddings-health-tracker");
    EmbeddingsHealthTracker.getInstance().setEventEmitter(emitter);
    return true;
  } catch (err) {
    log.debug("[mt#2147] wireEmbeddingsHealthTracker threw", {
      error: getErrorMessage(err),
    });
    return false;
  }
}

/**
 * Create the MCP "start" subcommand.
 */
export function createStartCommand(
  externalContainer?: import("@minsky/domain/composition/types").AppContainerInterface
): Command {
  const startCommand = new Command("start");
  startCommand.description("Start the MCP server");
  startCommand
    .option(
      "--repo <path>",
      "Repository path for operations that require repository context (default: current directory)"
    )
    .option("--with-inspector", "Launch MCP inspector alongside the server")
    .option("--inspector-port <port>", "Port for the MCP inspector", INSPECTOR_PORT.toString())
    .option("--http", "Use HTTP transport for remote connections (default: stdio)")
    .option(
      "--port <port>",
      `HTTP port (required for http transport, default: ${DEFAULT_HTTP_PORT})`,
      DEFAULT_HTTP_PORT.toString()
    )
    .option("--host <host>", `HTTP host (default: ${DEFAULT_HTTP_HOST})`, DEFAULT_HTTP_HOST)
    .option(
      "--endpoint <path>",
      `HTTP endpoint path (default: ${DEFAULT_HTTP_ENDPOINT})`,
      DEFAULT_HTTP_ENDPOINT
    )
    .option(
      "--require-auth",
      "Require bearer-token auth on the HTTP MCP endpoint (token from MINSKY_MCP_AUTH_TOKEN env)"
    )
    .option(
      "--local-daemon",
      `Run as the shared local MCP daemon (mt#3814, ADR-038): implies --http, defaults to ` +
        `${DEFAULT_LOCAL_DAEMON_HOST}:${DEFAULT_LOCAL_DAEMON_PORT}, generates and uses the 0600 ` +
        `bearer token, writes a discovery file, adopts-or-fails on a port conflict, and reaps ` +
        `idle sessions after ${LOCAL_DAEMON_IDLE_TIMEOUT_MS / 60000} minutes instead of the ` +
        `hosted 2h default (override with MINSKY_MCP_SESSION_IDLE_TIMEOUT_MS)`
    )
    .action(async (options, command) => {
      try {
        // mt#1745: cold-start profiling. `profileCheckpoint` is shared with
        // `src/cli.ts` so all checkpoint `t=` values are relative to the
        // SAME baseline (set at cli.ts module load).
        profileCheckpoint("action_entry");

        // mt#2464: this subcommand is a long-running SERVER, not a one-shot
        // command, so undo the CLI entry point's blanket declaration. Without
        // this the deployed minsky-mcp — which boots via `minsky mcp start
        // --http` and is therefore a CLI process — would keep discarding every
        // domain `log.info`/`log.warn`, the exact silence this task removes.
        // Safe for the stdio transport too: the sink writes to stderr, never to
        // the stdout channel the JSON-RPC protocol owns.
        setProcessRole("long-running-service");

        // mt#2098: When no container is passed (standalone MCP server boot
        // without the CLI composition root), create one from the portable
        // domain bootstrap. This makes the MCP server independently bootable.
        let container = externalContainer;
        if (!container) {
          const { createDomainContainer } = await import("@minsky/domain/composition/domain");
          container = await createDomainContainer();
        }

        // mt#3814: --local-daemon is a MODE, and the transport is one of the
        // things the mode decides. It implies --http and supplies ADR-038's
        // port/host contract for any value the caller did not pass
        // explicitly. `getOptionValueSource` is what distinguishes "the user
        // typed --port 3000" from "commander filled in its default" — without
        // it, an explicit `--port 3000 --local-daemon` would be silently
        // overridden, which is the same class of surprise as picking a
        // different port on conflict.
        if (options.localDaemon) {
          options.http = true;
          const defaults = resolveLocalDaemonDefaults({
            portFromCli: command.getOptionValueSource("port") === "cli",
            hostFromCli: command.getOptionValueSource("host") === "cli",
            currentPort: options.port,
            currentHost: options.host,
            currentIdleTimeoutMs: process.env.MINSKY_MCP_SESSION_IDLE_TIMEOUT_MS,
          });
          options.port = defaults.port;
          options.host = defaults.host;
          // Assigned before the server is constructed and reads it. Scoped to
          // this branch, so a plain `--http` server keeps the hosted 2h default
          // untouched.
          process.env.MINSKY_MCP_SESSION_IDLE_TIMEOUT_MS = defaults.sessionIdleTimeoutMs;
        }

        // mt#4322: ask the single source rather than re-deriving from flags.
        // Note this is deliberately still read AFTER the mode branch above:
        // `resolveMcpTransport` treats `localDaemon` as implying http itself,
        // so it returns the same answer either side of that `options.http`
        // assignment — which is precisely the property that lets the preAction
        // hook and this body agree without depending on which ran first.
        //
        // PR #3238 R1: resolved ONCE for this whole action body and reused
        // below (the stdin-cleanup branch, the error log). Re-calling it per
        // site would be cheap and correct today, but re-opens in miniature the
        // very thing this task closes — N derivations that a later edit
        // mutating `options` in between could drift apart.
        const transportType = resolveMcpTransport(options).transport;

        // Validate HTTP configuration if using HTTP transport
        if (transportType === "http") {
          const port = parseInt(options.port, 10);
          if (isNaN(port) || port < 1 || port > 65535) {
            log.cliError(`Invalid port: ${options.port}. Must be a number between 1 and 65535`);
            exit(1);
          }
          // Hosted MCP: the developer-setup guard is a dev-laptop UX nudge and
          // does not apply to a server process. See mt#1208.
          //
          // mt#4338: NOT `setHostedMode(true)` — hosted is a narrower question
          // than HTTP, and `--local-daemon` (which implies --http, see the mode
          // branch above) is the local daemon, not the hosted server.
          //
          // mt#4342: that flag identified one local LAUNCHER, not the property.
          // A plain `--http --port N` on a developer machine carries neither
          // flag, so it was indistinguishable from the Dockerfile CMD and had
          // `git.*` refused with git on PATH. The capability probe answers the
          // question the flags only proxied, and runs HERE rather than inside
          // the predicate so the predicate stays pure and directly assertable.
          // Both are documented on `isHostedMcpServer` / `hasLocalGitCapability`.
          //
          // PR #3233 R1: the probe ASCENDS from this directory rather than
          // testing it for `.git`, so starting the server from a subdirectory of
          // a repo is still local. That is the same misclassification mt#4342
          // fixes, one level in.
          setHostedMode(
            isHostedMcpServer({
              ...options,
              hasLocalWorkspace: hasLocalGitCapability(options.repo ?? process.cwd()),
            })
          );
        }

        const projectContext = resolveProjectContext(options.repo);

        // mt#1457, rescoped by mt#4451: build the connection tracker and hand
        // it to MinskyMCPServer for register/unregister of Server instances.
        //
        // It is deliberately NOT set into the container under
        // `clientCapabilityRegistry` any more. That override existed so
        // "routing decisions reflect actual host capabilities", and it did —
        // but it reflected the capabilities of the WHOLE FLEET. Under ADR-038's
        // shared daemon every conversation registers into this one process, so
        // a single elicitation-capable client made `hasElicitation()` true for
        // asks filed by every other connection, and the dispatch then targeted
        // whichever `Server` the `Set` yielded first rather than the caller's.
        //
        // Host capabilities now reach the router per REQUEST instead:
        // `src/mcp/server.ts` builds a `SingleConnectionCapabilityRegistry`
        // from the connection handling each CallTool and passes it down as
        // `CommandExecutionContext.callerCapabilities`. Leaving this key at the
        // container's no-op default is what makes a caller with no resolvable
        // connection resolve to "no elicitation".
        const connectionTracker = new MCPConnectionTracker();

        // mt#1625 spike: compose the static memory bundle BEFORE the
        // MinskyMCPServer constructor so the SDK Server receives the bundle
        // natively via its `instructions` constructor option. No embedding
        // call is needed (list by accessCount, not semantic search), so this
        // adds ~10-50ms to cold start rather than ~835ms. R1 BLOCKING #2 fix
        // — replaces the previous post-construction private-field mutation.
        let instructionsBundle: string | undefined;
        if (isInstructionsBundleEnabled()) {
          if (container) {
            try {
              const memSvcForBundle = await buildMemoryServiceForSpike(container);
              if (memSvcForBundle) {
                const bundle = await composeMemoryBundle(memSvcForBundle);
                if (bundle) {
                  instructionsBundle = bundle;
                  log.debug("[mt#1625] Instructions bundle composed", {
                    bundleChars: bundle.length,
                  });
                }
              }
            } catch (err) {
              log.debug("[mt#1625] Instructions bundle composition failed; proceeding without it", {
                error: getErrorMessage(err),
              });
            }
          } else {
            // R1 NON-BLOCKING #2: explicit diagnostic for the
            // flag-set-but-container-absent case (some test/CLI paths invoke
            // mcp start without a DI container). Previously this was silently
            // skipped, leaving operators puzzled about why the env var had no
            // effect.
            log.cli(
              "[mt#1625] MINSKY_MCP_INSTRUCTIONS_BUNDLE is set but no DI container is available — bundle composition skipped. This flag requires a persistence-backed container."
            );
          }
        }

        // Prepare server configuration
        const serverConfig = {
          name: "Minsky MCP Server",
          version: "1.0.0", // TODO: Import from package.json
          projectContext,
          transportType: transportType as "stdio" | "http",
          connectionTracker,
          ...(instructionsBundle && { instructions: instructionsBundle }),
          ...(transportType === "http" && {
            httpConfig: {
              port: parseInt(options.port, 10),
              host: options.host,
              endpoint: options.endpoint,
            },
          }),
        };

        log.debug("Starting MCP server", {
          transportType: transportType,
          repositoryPath: projectContext?.repositoryPath || process.cwd(),
          withInspector: options.withInspector || false,
          inspectorPort: options.inspectorPort,
          httpConfig: serverConfig.httpConfig,
        });

        // Create server with the specified transport.
        // mt#1816: defer the server.ts + @modelcontextprotocol/sdk load (~60-80ms measured on the
        // `before_mcp_command_load → mcp_command_module_loaded` stage) off the command-registration
        // path. `--version`/`--help`/bare `minsky` load the mcp command module to build the full
        // command tree (cli.ts needsAll) but never run THIS action, so they should not pay the SDK
        // cost. server.ts is the SOLE runtime importer of the SDK; importing MinskyMCPServer here at
        // its only construction site (mirroring this file's function-local dynamic-import pattern for
        // express/persistence/memory above, and mt#1719's lazy command-group loading) keeps loading
        // the mcp command SDK-free until `mcp start` actually runs. The top-level `import type` keeps
        // the MinskyMCPServer type annotation (used below) erased at build time.
        profileCheckpoint("before_sdk_load");
        const { MinskyMCPServer } = await import("../../mcp/server");
        profileCheckpoint("after_sdk_load");
        const server = new MinskyMCPServer(serverConfig);
        profileCheckpoint("server_constructed");

        // Register tools via adapter-based approach. Note: tool DEFINITIONS
        // register synchronously; HANDLERS (which need persistence) await
        // the server's init promise before dispatching — see setInitPromise
        // below and the `await this.initPromise` in server.ts's CallTool
        // handler. The container is NOT initialized inside registerAllTools.
        const commandMapper = new CommandMapper(server, server.getProjectContext());
        profileCheckpoint("mapper_constructed");
        await registerAllTools(commandMapper, container);
        profileCheckpoint("tools_registered");

        // mt#1751: For stdio mode, kick off `container.initialize()` in the
        // background AFTER tool registration but BEFORE `server.start()`.
        // The MCP `initialize` JSON-RPC handshake (~17ms post-connect)
        // doesn't need DI; tool handlers await `initPromise` before running.
        // This drops perceived cold-start time from ~1500ms to ~400ms on
        // the source path (mt#1745 measured DI at 72-75% of total). For
        // HTTP mode, preAction (`src/cli.ts`) has already initialized
        // synchronously — no defer needed (Profile B is long-lived).
        if (container && transportType === "stdio" && !container.has("persistence")) {
          // mt#1962: retry-aware controller. Pre-mt#1962 this site stored a
          // single long-lived `Promise<void>` whose rejection would poison
          // every subsequent tool call indefinitely (promises are at-most-
          // once; the side-effect-only `.catch` for logging didn't reset
          // the original promise's rejected state). A single transient
          // init failure (DB unreachable, missing migrations folder, slow
          // Postgres handshake, port collision) became a hard outage that
          // required `proxy_restart_server` or process kill to clear.
          //
          // The controller tracks attempt state and re-invokes the
          // initializer on demand when a prior attempt rejected (subject
          // to a 30s default backoff so repeated failures don't tight-
          // loop the database; tunable via MINSKY_MCP_INIT_RETRY_INTERVAL_MS
          // for environments with different recovery cadences). Concurrent
          // tool calls during an in-flight retry collapse to a single
          // `container.initialize()` invocation.
          const DEFAULT_INIT_RETRY_INTERVAL_MS = 30_000;
          const rawInterval = Number.parseInt(
            process.env.MINSKY_MCP_INIT_RETRY_INTERVAL_MS ?? "",
            10
          );
          const minRetryIntervalMs =
            Number.isFinite(rawInterval) && rawInterval > 0
              ? rawInterval
              : DEFAULT_INIT_RETRY_INTERVAL_MS;
          if (rawInterval && minRetryIntervalMs !== rawInterval) {
            log.warn("[mt#1962] MINSKY_MCP_INIT_RETRY_INTERVAL_MS invalid; using default", {
              raw: process.env.MINSKY_MCP_INIT_RETRY_INTERVAL_MS,
              defaultMs: DEFAULT_INIT_RETRY_INTERVAL_MS,
            });
          }
          log.debug("[mt#1962] init retry controller", { minRetryIntervalMs });
          const initController = new RetryingInitController({
            initializer: () =>
              container.initialize().then(() => {
                profileCheckpoint("background_container_initialized");
              }),
            minRetryIntervalMs,
            onAttemptSettled: (result) => {
              if (result.error === undefined) {
                if (result.attempt > 1) {
                  // PR #1188 R1 NB1: success-on-retry is good news, not an
                  // actionable warning. Operators expect WARN to be actionable;
                  // log at info instead so transient self-heal doesn't generate
                  // alert noise.
                  log.info("[mt#1962] container.initialize() succeeded on retry", {
                    attempt: result.attempt,
                  });
                }
                return;
              }
              log.error("[mt#1962] container.initialize() failed", {
                attempt: result.attempt,
                consecutiveFailures: result.consecutiveFailures,
                error: getErrorMessage(result.error),
              });
            },
          });

          // PR #1063 R2 BLOCKING (preserved across mt#1962): kick off the
          // first attempt eagerly in the background, preserving mt#1751's
          // cold-start optimization (DI runs while the MCP `initialize`
          // handshake proceeds in parallel). The side-effect-only `.catch`
          // on a FORKED reference consumes the rejection so Node never
          // emits `unhandledRejection` if init fails and no tool call ever
          // awaits — the controller's internal state stays intact and a
          // later tool-call `awaitReady()` surfaces the rejection (or
          // triggers a retry, subject to backoff). The structured log line
          // is emitted via `onAttemptSettled`, not from here.
          initController.awaitReady().catch(() => {
            // Side-effect-only; controller logs via onAttemptSettled.
          });

          server.setInitController(initController);
          profileCheckpoint("background_init_kicked_off");
        }

        // Wire the container into the server so agentId can be written to session records.
        // Safe to call before background init resolves — setContainer just stores the
        // reference; consumers that need resolved services await initPromise.
        if (container) {
          server.setContainer(container);
        }

        // mt#1588 spike: construct a MemoryService and wire it into the server
        // for the enrichment middleware. Gated behind the
        // MINSKY_MCP_MEMORY_ENRICHMENT opt-in env var (default OFF) per PR #974
        // R1 BLOCKING — the spike's "iterate, do not graduate" decision means
        // the wiring must not activate in production unless explicitly opted
        // in. Construction failure leaves the middleware as a no-op.
        //
        // Note (PR #974 R2 NON-BLOCKING): opt-in is read at startup-only here
        // for the wiring decision. `enrichToolResponse` ALSO checks the env
        // var on every call, so toggling MINSKY_MCP_MEMORY_ENRICHMENT to "0"
        // at runtime takes effect immediately (the middleware short-circuits)
        // even though the MemoryService stays wired. Setting the var from
        // unset → "1" at runtime requires a restart for wiring to take effect.
        if (container && isEnrichmentEnabled()) {
          buildMemoryServiceForSpike(container)
            .then((memoryService) => {
              if (memoryService) {
                server.setMemoryService(memoryService);
                log.debug("[mt#1588] Memory enrichment middleware wired (opt-in)");
              }
            })
            .catch((err) => {
              log.debug("[mt#1588] Memory enrichment middleware unavailable", {
                error: getErrorMessage(err),
              });
            });
        }

        // mt#1661 v0: wire wake-pending service + session resolver for the
        // wake-enrichment middleware. When persistence + sessionProvider are
        // available, the middleware drains undelivered `quality.review` Ask
        // wake events on subsequent allowlisted MCP tool calls. v0 covers
        // only the unambiguous addressing case (caller args carry session/task).
        // No env-var gate — the wake_pending table only fills when reconcile
        // runs, so an empty table makes the middleware a quiet no-op.
        if (container) {
          buildWakeServiceForBridge(container)
            .then((wired) => {
              if (wired) {
                server.setWakeService(wired.service, wired.resolver);
                log.debug("[mt#1661] Wake-enrichment middleware wired");
              }
            })
            .catch((err) => {
              log.debug("[mt#1661] Wake-enrichment middleware unavailable", {
                error: getErrorMessage(err),
              });
            });
        }

        // mt#1738: wire the SubagentDispatchTracker singleton so debug.systemInfo
        // returns real dispatch cadence aggregates instead of the zero-filled
        // no-op defaults. The initial call is fire-and-forget — if the DB is
        // unavailable at THIS moment, the singleton stays as the no-op tracker
        // and subagentDispatches returns zero-filled aggregates (graceful
        // degradation).
        //
        // mt#3044: a transient failure here is no longer permanent. Register
        // `wireSubagentDispatchTrackerWithRetry` as the singleton's retry
        // callback (`SubagentDispatchTracker.getInstance()` invokes it on every
        // call while the singleton is unwired — see subagent-dispatch-tracker.ts)
        // so a LATER `debug.systemInfo` or `session.generate_prompt` call
        // retries the wiring instead of the failure latching for the rest of
        // the process's life.
        //
        // R1 BLOCKING #2 fix: registration is AWAITED (not fire-and-forget)
        // so it completes deterministically before this function reaches
        // `server.start()` further down — mirrors the mt#1625 bundle-
        // composition pattern elsewhere in this file ("this MUST be awaited
        // before server.start() so [it] is in place when the first
        // ... handshake arrives"). Without this, a consumer that manages to
        // call `getInstance()` before the dynamic import resolves would see
        // no registered retry callback and get no retry until some LATER
        // call happened to land after registration — a timing-dependent
        // blind window undermining SC#2's "eventually reflects real data"
        // guarantee. The eager wire attempt below stays fire-and-forget
        // (unchanged) — only the REGISTRATION needed the ordering guarantee.
        if (container) {
          try {
            const { SubagentDispatchTracker } = await import("../../mcp/subagent-dispatch-tracker");
            SubagentDispatchTracker.registerWireAttempt(() =>
              wireSubagentDispatchTrackerWithRetry(container)
            );
          } catch (err) {
            log.debug("[mt#3044] Could not register SubagentDispatchTracker wire-retry callback", {
              error: getErrorMessage(err),
            });
          }

          wireSubagentDispatchTrackerWithRetry(container)
            .then((wired) => {
              if (wired) {
                log.debug("[mt#1738] SubagentDispatchTracker wired");
              }
            })
            .catch((err) => {
              log.debug("[mt#1738] SubagentDispatchTracker unavailable", {
                error: getErrorMessage(err),
              });
            });
        }

        // mt#2265: wire the ask state-counts provider so debug.systemInfo
        // surfaces asks count-by-state (the stuck-pipeline detector).
        //
        // mt#2568: the eager setAskStateCountsRepository() attempt below has
        // no retry of its own — if it hasn't completed (or fails outright)
        // by the time getAskStateCounts() is first called (e.g. a proxy/
        // staleness-respawned server, the exact race mt#2562/mt#2567
        // diagnosed for the presence write-path), the provider would stay
        // permanently unavailable for the life of the process, silently
        // defeating the stuck-pipeline detector. registerAskStateCountsBuilder
        // gives getAskStateCounts() a per-call fallback that builds a fresh
        // AskRepository from the container on demand (mirrors
        // buildAskRepository / server.ts's getPresenceClaimRepo, mt#2567) so
        // every call is correct regardless of startup-wiring timing.
        // Registration is AWAITED (not fire-and-forget) so it is in place
        // before server.start() — mirrors the mt#3044
        // SubagentDispatchTracker.registerWireAttempt ordering fix.
        if (container) {
          try {
            const { registerAskStateCountsBuilder } = await import(
              "@minsky/domain/ask/state-counts-provider"
            );
            registerAskStateCountsBuilder(async () => {
              const { buildAskRepository } = await import("../../adapters/shared/commands/asks");
              return buildAskRepository(container);
            });
          } catch (err) {
            log.debug("[mt#2568] Could not register Ask state-counts builder", {
              error: getErrorMessage(err),
            });
          }

          // Eager fast-path attempt (fire-and-forget warm-up; the per-call
          // fallback above means this is purely a perf optimization now).
          import("../../adapters/shared/commands/asks")
            .then(async ({ buildAskRepository }) => {
              const repo = await buildAskRepository(container);
              if (repo) {
                const { setAskStateCountsRepository } = await import(
                  "@minsky/domain/ask/state-counts-provider"
                );
                setAskStateCountsRepository(repo);
                log.debug("[mt#2265] Ask state-counts provider wired");
              }
            })
            .catch((err) => {
              log.debug("[mt#2265] Ask state-counts provider unavailable", {
                error: getErrorMessage(err),
              });
            });
        }

        // mt#2147: wire the EmbeddingsHealthTracker singleton so it can emit
        // embeddings.provider_degraded events to system_events.
        //
        // mt#2568: the eager wireEmbeddingsHealthTracker() attempt below has
        // no retry — and emitDegradationEvent's emittedForCurrentDegradation
        // latch means a degradation that races this wiring PERMANENTLY loses
        // that degradation cycle's event (not just delayed), even though the
        // wiring itself eventually succeeds. registerEventEmitterBuilder
        // gives emitDegradationEvent a per-call fallback that builds a fresh
        // EventEmitter from the container on demand (mirrors
        // buildAskRepository / server.ts's getPresenceClaimRepo, mt#2567).
        // Registration is AWAITED so it is in place before server.start() —
        // mirrors the mt#3044 SubagentDispatchTracker.registerWireAttempt
        // ordering fix.
        if (container) {
          try {
            // mt#4218: registered through the shared host-wiring helper, which
            // the cockpit daemon and the CLI now call the same way. Registering
            // the tracker's builder directly from a host is what this replaces —
            // three hosts each doing it their own way is how two of them came to
            // do it not at all.
            const { registerEmbeddingsHealthEventEmitter, resolveContainerPersistence } =
              await import("@minsky/domain/ai/embeddings-health-wiring");
            registerEmbeddingsHealthEventEmitter(() => resolveContainerPersistence(container));
          } catch (err) {
            log.debug(
              "[mt#2568] Could not register EmbeddingsHealthTracker event-emitter builder",
              {
                error: getErrorMessage(err),
              }
            );
          }

          // Eager fast-path attempt (fire-and-forget warm-up; the per-call
          // fallback above means this is purely a perf optimization now).
          wireEmbeddingsHealthTracker(container)
            .then((wired) => {
              if (wired) {
                log.debug("[mt#2147] EmbeddingsHealthTracker wired");
              }
            })
            .catch((err) => {
              log.debug("[mt#2147] EmbeddingsHealthTracker unavailable", {
                error: getErrorMessage(err),
              });
            });
        }

        // mt#2562/mt#2567: Pre-warm the PresenceClaimRepository so writeTaskClaim's
        // first call skips the per-call DB connection build (fast-path optimization).
        // This is now a WARM-UP ONLY — writeTaskClaim has its own per-call fallback
        // that builds the repo from the container on every call when this hasn't fired.
        // So if this async block doesn't complete before the first tool call (e.g.
        // on a proxy/staleness-respawned server), the write path still works.
        if (container) {
          (async () => {
            try {
              const { buildPresenceClaimRepository } = await import(
                "@minsky/domain/presence/index"
              );
              const provider = container.has("persistence")
                ? (container.get("persistence") as {
                    getDatabaseConnection?: () => Promise<unknown>;
                  })
                : undefined;
              if (provider?.getDatabaseConnection) {
                const db = await provider.getDatabaseConnection();
                const repo = buildPresenceClaimRepository(db);
                if (repo) {
                  server.setPresenceClaimRepository(repo);
                  log.debug("[mt#2562] PresenceClaimRepository pre-warmed");
                }
              }
            } catch (err) {
              log.debug("[mt#2562] PresenceClaimRepository pre-warm unavailable", {
                error: getErrorMessage(err),
              });
            }
          })();
        }

        // Register knowledge MCP resources on the server
        registerKnowledgeResources(server, container);
        profileCheckpoint("knowledge_resources_registered");

        // Resolve the OAuth identity provider for HTTP-mode DCR + discovery endpoints.
        // Requires a SQL-capable persistence provider (Postgres). Falls back to
        // undefined (provider-less mode) when no DB is available — the route handlers
        // return 503/400 gracefully in that case.
        let oauthProvider: OAuthIdentityProvider | undefined;
        if (transportType === "http" && container) {
          try {
            const persistence = container.has("persistence")
              ? container.get("persistence")
              : undefined;
            const persistenceAny = persistence as Record<string, unknown> | undefined;
            if (persistenceAny && typeof persistenceAny["getDatabaseConnection"] === "function") {
              const db = await (
                persistenceAny["getDatabaseConnection"] as () => Promise<
                  import("drizzle-orm/postgres-js").PostgresJsDatabase | null
                >
              )();
              if (db) {
                // Read oauth config from the configuration subsystem (best-effort).
                // Falls back to undefined so the provider uses its defaults
                // (provider = "in-process", issuer derived from request host).
                let oauthConfig: import("@minsky/domain/configuration/schemas/oauth").OAuthConfig;
                try {
                  const { getConfiguration } = await import("@minsky/domain/configuration/index");
                  const fullConfig = getConfiguration() as {
                    oauth?: import("@minsky/domain/configuration/schemas/oauth").OAuthConfig;
                  };
                  oauthConfig = fullConfig.oauth;
                } catch {
                  oauthConfig = undefined;
                }
                // mt#1719 Intervention 2: function-local dynamic import.
                // OAuth provider pulls in oidc-provider + Koa middleware
                // closure; deferring keeps it off the stdio import graph.
                const { resolveOAuthProvider } = await import("@minsky/domain/oauth/registry");
                oauthProvider = resolveOAuthProvider(oauthConfig, {
                  db,
                  endpointPath: normalizeEndpointPath(options.endpoint),
                });
                log.debug("[mt#1664] OAuth provider wired for HTTP DCR + discovery endpoints");
              } else {
                log.warn("[mt#1664] No DB connection available; OAuth provider not wired");
              }
            }
          } catch (err) {
            log.warn("[mt#1664] OAuth provider construction failed; proceeding without it", {
              error: getErrorMessage(err),
            });
          }
        }

        // Launch inspector if requested
        if (options.withInspector) {
          // mt#1719 Intervention 2: function-local dynamic import. Inspector
          // launcher is only needed when --with-inspector is passed; deferring
          // keeps it off every other invocation's import graph.
          const { launchInspector, isInspectorAvailable } = await import(
            "../../mcp/inspector-launcher"
          );
          if (!isInspectorAvailable()) {
            log.cliError(
              "MCP Inspector not found. Please install it with: bun add -d @modelcontextprotocol/inspector"
            );
            exit(1);
          } else {
            const inspectorPort = parseInt(options.inspectorPort, 10);
            const inspectorResult = launchInspector({
              port: inspectorPort,
              openBrowser: true,
              mcpTransportType: transportType === "http" ? "httpStream" : "stdio",
              mcpPort: transportType === "http" ? parseInt(options.port, 10) : undefined,
              mcpHost: transportType === "http" ? options.host : undefined,
            });

            if (inspectorResult.success) {
              log.cli(`MCP Inspector started on port ${inspectorPort}`);
              log.cli(`Open your browser at ${inspectorResult.url} to access the inspector`);
              if (transportType === "http") {
                log.cli(
                  `Inspector will connect to MCP server via HTTP at ${options.host}:${options.port}${options.endpoint}`
                );
              } else {
                log.cli("The inspector will start its own MCP server instance");
              }
            } else {
              log.cliError(`Failed to start MCP Inspector: ${inspectorResult.error}`);
              exit(1);
            }
          }
        }

        // mt#1625 spike: compose the static memory bundle for `instructions`
        // injection at MCP `initialize`. Unlike the mt#1588 middleware (which
        // is fire-and-forget), this MUST be awaited before server.start() so
        // the bundle is in place when the first `initialize` handshake arrives.
        // No embedding call is needed (list by accessCount, not semantic search),
        // so this adds ~10-50ms to cold start rather than ~835ms.
        // R1 BLOCKING #2 fix: bundle is now composed BEFORE server construction
        // and passed via `serverConfig.instructions`. See the block above.

        // Start the server
        if (transportType === "http") {
          await startHttpServer(
            server,
            {
              port: options.port,
              host: options.host,
              endpoint: options.endpoint,
              requireAuth: options.requireAuth,
              localDaemon: Boolean(options.localDaemon),
            },
            projectContext,
            oauthProvider,
            container
          );
        } else {
          // Stdio transport
          if (!options.withInspector) {
            await server.start();
            profileCheckpoint("server_started");
            if (projectContext) {
              log.cli(`Repository path: ${projectContext.repositoryPath}`);
            }
            log.cli("Ready to receive MCP requests via stdin/stdout");
          }
        }

        // Fire-and-forget background embedding sweep for missing tasks
        import("../../adapters/shared/commands/tasks/startup-embedding-sweep")
          .then(({ triggerStartupEmbeddingSweep }) => {
            if (!container) return;
            return triggerStartupEmbeddingSweep(
              container.get("persistence"),
              container.get("taskService")
            );
          })
          // mt#3370: de-silenced, for the same reason mt#2192 de-silenced the
          // transcript ingest registered directly below. This was a bare
          // `.catch(() => {})`, so the recovery layer for missing embeddings
          // could fail entirely and produce no signal anywhere — which is why
          // mt#2861 sat unindexed for 16 days with no explanation available.
          // Best-effort means it must not BLOCK boot; it does not mean it must
          // be invisible when it breaks.
          .catch((err) => {
            log.warn("Startup embedding sweep failed (best-effort)", {
              error: err instanceof Error ? err.message : String(err),
            });
          });

        // Fire-and-forget background transcript ingest for new JSONL sessions (mt#2051)
        import("../../adapters/shared/commands/transcripts/startup-transcript-ingest")
          .then(({ triggerStartupTranscriptIngest }) => {
            if (!container) return;
            return triggerStartupTranscriptIngest(container.get("persistence"));
          })
          // mt#2192 (SC2): de-silence the boot sweep — a failed startup ingest
          // must leave an operator-findable signal, not vanish into .catch(()=>{}).
          .catch((err) => {
            log.warn("Startup transcript ingest failed (best-effort)", {
              error: err instanceof Error ? err.message : String(err),
            });
          });

        // Fire-and-forget background sweep bridging the disconnect-tracker's
        // JSONL log into `system_events` as `mcp.disconnect` rows (mt#2537).
        // HWM-gated internally so repeated boots (the MCP server restarts
        // frequently — see CLAUDE.md's disconnect-cadence rule) only emit new
        // disconnects since the last successful sweep.
        import("../../mcp/disconnect-event-sweep")
          .then(({ triggerMcpDisconnectEventSweep }) => {
            if (!container) return;
            return triggerMcpDisconnectEventSweep(container.get("persistence"));
          })
          .catch((err) => {
            log.warn("mcp.disconnect event sweep failed (best-effort)", {
              error: err instanceof Error ? err.message : String(err),
            });
          });

        // Fire-and-forget second writer of the prod-state cache (mt#3922, implementing
        // mt#3896). Staleness-gated: it refreshes only when the cache is absent or older
        // than one missed daemon sweep, so this server's ~100 restarts a day do not become
        // ~100 ledger reads a day. The cockpit daemon keeps its own sweep — this is
        // redundancy across two process lifetimes, not a relocation.
        import("../../mcp/prod-state-boot-refresh")
          .then(({ triggerProdStateBootRefresh }) => {
            if (!container) return;
            return triggerProdStateBootRefresh(container.get("persistence"));
          })
          .catch((err) => {
            log.warn("Prod-state boot refresh failed (best-effort)", {
              error: err instanceof Error ? err.message : String(err),
            });
          });

        // Start the knowledge sync scheduler (best-effort; non-blocking)
        // ADR-002: scheduler is only constructed here, inside the MCP server start
        // path — never from `minsky --help` or any CLI-only code path.
        const scheduler = await buildAndStartScheduler(container);

        // Hard timeout for drain+close path (mt#1417).
        // Configurable via PG_DRAIN_TIMEOUT_MS; defaults to 5000ms.
        // Sanitize: parseInt produces NaN for non-numeric values, which setTimeout
        // would coerce to 0 and fire the hard-timeout immediately, forcing exit(1)
        // even when a clean drain would have succeeded. Fall back to default and
        // clamp to a sane range (PR #881 R1 BLOCKING).
        const PG_DRAIN_TIMEOUT_DEFAULT_MS = 5000;
        const PG_DRAIN_TIMEOUT_MIN_MS = 100;
        const PG_DRAIN_TIMEOUT_MAX_MS = 60_000;
        // Strict validation: only accept a canonical decimal integer string.
        // parseInt would happily accept "200ms" (200), "0x10" (0), "1e3" (1) —
        // partial/exotic forms that should fall back to the default rather than
        // be silently coerced (PR #881 R3 BLOCKING).
        const rawDrainTimeout = process.env.PG_DRAIN_TIMEOUT_MS;
        const isCanonicalIntegerString = (s: string | undefined): s is string =>
          typeof s === "string" && /^\s*\d+\s*$/.test(s);
        const PG_DRAIN_TIMEOUT_MS = isCanonicalIntegerString(rawDrainTimeout)
          ? Math.min(
              Math.max(parseInt(rawDrainTimeout, 10), PG_DRAIN_TIMEOUT_MIN_MS),
              PG_DRAIN_TIMEOUT_MAX_MS
            )
          : PG_DRAIN_TIMEOUT_DEFAULT_MS;

        // Idempotency flag: once a shutdown race is in flight, skip re-entry.
        let shutdownInFlight = false;

        // Handle termination signals gracefully
        const cleanup = async () => {
          if (shutdownInFlight) return;
          shutdownInFlight = true;

          log.cli("\nStopping Minsky MCP Server...");

          // Race the drain+close path against a hard timeout so the process
          // never hangs indefinitely (e.g. when Claude Code closes the stdio pipe
          // without sending a signal — mt#1417).
          const drainAndClose = async (): Promise<void> => {
            // mt#3814: stop advertising before draining, so a supervisor or a
            // CLI reading the discovery file during the drain window does not
            // hand out a daemon that is on its way out. Guarded on pid, so a
            // process that adopted an incumbent (or lost a bind race) never
            // deletes the winner's record.
            if (options.localDaemon) {
              try {
                removeDiscoveryRecord(process.pid);
              } catch (error) {
                log.warn("Failed to remove the local MCP daemon discovery file (non-fatal)", {
                  error: getErrorMessage(error),
                });
              }
            }
            try {
              // Stop the scheduler first so in-flight syncs complete before closing.
              if (scheduler) {
                await scheduler.stop();
                log.debug("[scheduler] Knowledge sync scheduler stopped");
              }
              await server.drain();
            } catch (error) {
              log.warn("Error during server cleanup", {
                error: getErrorMessage(error),
              });
            }
            // Release DB sockets promptly so another MCP instance (e.g. Railway
            // redeploy rolling over to a new container) can claim pool slots
            // without waiting for TCP timeout (mt#1193).
            try {
              const persistence = container?.has("persistence")
                ? container.get("persistence")
                : undefined;
              if (
                persistence &&
                typeof (persistence as { close?: () => Promise<void> }).close === "function"
              ) {
                await (persistence as { close: () => Promise<void> }).close();
                log.debug("[persistence] PostgreSQL connections closed");
              }
            } catch (error) {
              log.warn("Error closing persistence during shutdown", {
                error: getErrorMessage(error),
              });
            }
          };

          // Capture the timeout handle so we can clear it after the race resolves.
          // Otherwise the timer lingers until process.exit, harmless today but a
          // real footgun if the race shape evolves (PR #881 R1 NON-BLOCKING).
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const hardTimeout = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error("shutdown timeout")),
              PG_DRAIN_TIMEOUT_MS
            );
          });

          try {
            await Promise.race([drainAndClose(), hardTimeout]);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            // Route through the shared exit helper for consistent termination
            // semantics + Bun-vs-Node parity (PR #881 R1 BLOCKING).
            exit(0);
          } catch {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            log.warn(`Shutdown timed out after ${PG_DRAIN_TIMEOUT_MS}ms; forcing exit`);
            exit(1);
          }
        };

        // process.on is on the NodeJS.Process EventEmitter API; direct call
        // satisfies both TS and the no-excessive-as-unknown lint rule.
        // Retired prior bracket-notation cast workaround per mt#1981.
        process.on("SIGTERM", cleanup);
        process.on("SIGINT", cleanup);
        process.on("SIGHUP", cleanup);

        // mt#3764: HTTP-mode orphan/idle process exit path. Prevents an
        // ad-hoc, locally-spawned `mcp start --http` (e.g. a subagent
        // testing a server in a session workspace and never terminating
        // it) from running indefinitely — see src/mcp/orphan-exit.ts for
        // the two mechanisms (parent-death ppid-transition detection,
        // never-connected idle timeout) and why neither affects the
        // Railway/Docker hosted entrypoint (its ppid is 1 from the first
        // tick, per the Dockerfile's shell-form CMD, and stays 1 for the
        // container's lifetime).
        const {
          wireOrphanExitWatchers,
          wireMemoryCeilingWatcher,
          getCurrentProcessPpid,
          getCurrentProcessUptimeSeconds,
          getCurrentProcessMemoryBytes,
          resolveMemoryCeilingBytes,
        } = await import("../../mcp/orphan-exit");
        const { wireMemoryCaptureWatcher } = await import("../../mcp/memory-capture");

        // mt#3814: name the shared daemon distinctly in every memory record.
        // mt#3885's central open premise is that the 40–60GB runaway is NOT
        // attributable — the panic reports carry no argv and `procname` is
        // "bun" for at least four Minsky process classes — so a breach record
        // reading `mcp start (http)` for both a one-off HTTP server and the
        // shared daemon would reproduce exactly that ambiguity in the one
        // place set up to resolve it.
        const processRole = options.localDaemon
          ? "mcp start (local-daemon)"
          : `mcp start (${transportType})`;

        if (transportType === "http") {
          wireOrphanExitWatchers({
            initialPpid: getCurrentProcessPpid(),
            getCurrentPpid: getCurrentProcessPpid,
            hasEverConnected: () => server.hasEverHadHttpSession(),
            onExit: () => void cleanup(),
          });
        }

        // mt#3886: resident-memory ceiling. Deliberately OUTSIDE the
        // HTTP gate above — the per-conversation fleet that panicked the
        // machine on 2026-08-08 (three `bun` processes at 15.5/54.2/59.9
        // GB against 64 GB of RAM) runs this server over STDIO, so an
        // HTTP-only guard would not have covered a single one of them.
        wireMemoryCeilingWatcher({
          initialPpid: getCurrentProcessPpid(),
          processRole,
          getUptimeSeconds: getCurrentProcessUptimeSeconds,
          getDiagnostics: () =>
            transportType === "http" ? { everConnected: server.hasEverHadHttpSession() } : {},
          onExit: () => void cleanup(),
        });

        // mt#3973: the forensic half. A SEPARATE one-shot watcher at a lower
        // watermark writes what this process was DOING — the MCP tool calls in
        // flight and their elapsed times — which the ceiling's breach record
        // does not carry and mt#3885 cannot proceed without. Deliberately not
        // folded into the ceiling watcher above: the self-terminate is the
        // machine's protection against a kernel panic and must not be able to
        // fail, or be delayed, because a diagnostic did.
        wireMemoryCaptureWatcher({
          processRole,
          ceilingBytes: resolveMemoryCeilingBytes(),
          getResidentBytes: getCurrentProcessMemoryBytes,
          getUptimeSeconds: getCurrentProcessUptimeSeconds,
          getInFlightToolCalls: () => server.getInFlightToolCalls(),
          getDiagnostics: () =>
            transportType === "http" ? { everConnected: server.hasEverHadHttpSession() } : {},
        });

        // mt#3814: the graceful step BEFORE the ceiling. The ceiling's exit is
        // already graceful for in-flight work — `onExit` runs the same
        // `cleanup` as SIGTERM, which calls `server.drain()` (new tool calls
        // rejected, up to 5s for in-flight ones, then close) — so nothing here
        // re-implements draining. What it adds is the state between "serving
        // normally" and "gone": above the watermark, refuse NEW sessions while
        // established ones keep working. Armed only for the shared daemon,
        // because refusing a session is a behavior change and the hosted
        // Railway surface is out of this task's scope.
        if (options.localDaemon) {
          const watermarkBytes = resolveAdmissionWatermarkBytes(resolveMemoryCeilingBytes());
          if (watermarkBytes !== null) {
            server.setSessionAdmissionGate(
              createAdmissionGate({
                getResidentBytes: getCurrentProcessMemoryBytes,
                watermarkBytes,
              })
            );
            log.cli(
              `Local MCP daemon session-admission watermark: ` +
                `${Math.round(watermarkBytes / (1024 * 1024))}MB`
            );
          }
        }

        // When the Claude Code parent closes its stdio pipe (without sending a signal),
        // trigger the same shutdown path (mt#1417). The `shutdownInFlight` guard
        // inside `cleanup` makes this listener idempotent even if it fires more
        // than once (PR #881 R1 NON-BLOCKING). Only attach for stdio transport —
        // HTTP-mode containers don't use stdin and may run with stdin closed at
        // startup, which would falsely trigger.
        if (transportType === "stdio") {
          process.stdin.on("close", cleanup);
        }

        // Print readiness AFTER all shutdown handlers are attached (PR #881 R2 BLOCKING):
        // tests + parent processes use this line as the deterministic ready signal,
        // so emitting it before handlers register opens a race window where an
        // immediate shutdown event hits the kernel default action and bypasses cleanup.
        log.cli("Press Ctrl+C to stop");

        // Keep the process alive by waiting indefinitely
        await new Promise(() => {});
      } catch (error) {
        log.error("Failed to start MCP server", {
          // Re-resolved rather than reusing the `transportType` binding above:
          // that const lives inside the `try`, and a throw before it is reached
          // means it never existed. This is the "once per EXECUTION PATH" the
          // R1 finding asks for — the catch is a different path, not a repeat
          // of the same one.
          transportType: resolveMcpTransport(options).transport,
          withInspector: options.withInspector || false,
          error: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        log.cliError(`Failed to start MCP server: ${getErrorMessage(error)}`);
        exit(1);
      }
    });

  return startCommand;
}
