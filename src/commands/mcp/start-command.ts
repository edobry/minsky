import fs from "fs";
import path from "path";
import { Command } from "commander";
import express from "express";
import { MinskyMCPServer } from "../../mcp/server";
import { CommandMapper } from "../../mcp/command-mapper";
import { log } from "../../utils/logger";
import { SharedErrorHandler } from "../../adapters/shared/error-handling";
import { getErrorMessage } from "../../errors/index";
import { launchInspector, isInspectorAvailable } from "../../mcp/inspector-launcher";
import { createProjectContext } from "../../types/project";
import { exit } from "../../utils/process";
import { registerDebugTools } from "../../adapters/mcp/debug";
import { registerGitTools } from "../../adapters/mcp/git";
import { registerRepoTools } from "../../adapters/mcp/repo";
import { registerInitTools } from "../../adapters/mcp/init";
import { registerRulesTools } from "../../adapters/mcp/rules";
import { registerSessionTools } from "../../adapters/mcp/session";
import { registerSessionWorkspaceTools } from "../../adapters/mcp/session-workspace";
import { registerPersistenceTools } from "../../adapters/mcp/persistence";
import { registerTaskTools } from "../../adapters/mcp/tasks";
import { registerChangesetTools } from "../../adapters/mcp/changeset";
import { registerConfigTools } from "../../adapters/mcp/config";
import { registerSessionFileTools } from "../../adapters/mcp/session-files";
import { registerSessionEditTools } from "../../adapters/mcp/session-edit-tools";
import { registerValidateTools } from "../../adapters/mcp/validate";
import { registerMcpManagementTools } from "../../adapters/mcp/mcp-commands";
import { registerKnowledgeResources } from "../../adapters/mcp/knowledge-resources";
import { registerMemoryTools } from "../../adapters/mcp/memory";
import { registerDetectorsTools } from "../../adapters/mcp/detectors";
import { buildAndStartScheduler } from "./scheduler-wiring";
import { setHostedMode } from "../../domain/configuration/guard";
import { MCPClientCapabilityRegistry } from "../../mcp/client-capabilities";
import type { MemoryServiceSurface } from "../../domain/memory/memory-service";
import type { AppContainerInterface } from "../../composition/types";
import { isEnrichmentEnabled } from "../../mcp/middleware/memory-enrichment";
import { resolveOAuthProvider } from "../../domain/oauth/registry";
import type { OAuthIdentityProvider, OAuthValidationResult } from "../../domain/oauth/types";
import { AGENT_ID_META_KEY } from "../../domain/agent-identity/layer2";
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
 * Register all MCP tool adapters on the given command mapper.
 */
async function registerAllTools(
  commandMapper: CommandMapper,
  container?: import("../../composition/types").AppContainerInterface
): Promise<void> {
  // Ensure the container is initialized before registering tools.
  // MCP tool invocations bypass Commander's preAction hook, so initialization
  // must happen here — making it impossible to register tools without persistence.
  if (container && !container.has("persistence")) {
    await container.initialize();
    profileCheckpoint("container_initialized_inline");
    log.debug("Container initialized for MCP server");
  }

  // Health check: verify critical dependencies are available after init
  if (container && !container.has("sessionProvider")) {
    log.error(
      "MCP startup health check failed: sessionProvider not available after container init. " +
        "Session tools will fail. Check database connectivity."
    );
  }

  // Register debug tools first to ensure they're available for debugging
  registerDebugTools(commandMapper, container);

  // Register main application tools
  log.debug("[MCP] About to register task tools");
  registerTaskTools(commandMapper, container);
  log.debug("[MCP] About to register session tools");
  registerSessionTools(commandMapper, container);
  registerSessionWorkspaceTools(commandMapper, container);
  registerSessionFileTools(commandMapper, container);
  registerSessionEditTools(commandMapper, container);

  // Register persistence tools for agent querying
  log.debug("[MCP] About to register persistence tools");
  registerPersistenceTools(commandMapper, container);

  registerGitTools(commandMapper, container);
  registerRepoTools(commandMapper, container);

  registerInitTools(commandMapper, container);
  registerRulesTools(commandMapper, container);
  registerConfigTools(commandMapper, container);
  registerChangesetTools(commandMapper, container);
  registerValidateTools(commandMapper, container);
  registerMcpManagementTools(commandMapper, container);
  registerMemoryTools(commandMapper, container);
  registerDetectorsTools(commandMapper, container);
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
  },
  projectContext?: ReturnType<typeof createProjectContext>,
  oauthProvider?: OAuthIdentityProvider
): Promise<void> {
  const app = express();
  // Trust exactly one proxy hop (Railway's edge / TLS terminator). Scoping
  // to `1` rather than `true` limits the X-Forwarded-* trust to one upstream
  // and avoids the unbounded-chain risk where a malicious client could spoof
  // their `req.ip`/`req.protocol` by injecting forged X-Forwarded-* headers
  // along multiple unverified hops. Required for the OAuth Discovery
  // endpoints to advertise the correct public `https://` URL.
  app.set("trust proxy", 1);
  app.use(express.json());

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
          res.status(401).json({
            error: errorCode,
            error_description: description,
          });
          return;
        }

        // Inject agentId into the MCP request body's params._meta so Layer 2 picks it up.
        // Only inject for POST requests that carry a body — GET (SSE) connections
        // don't carry a JSON body and don't have tool-call context.
        //
        // mt#1765: _meta MUST live inside params._meta, NOT as a top-level envelope key.
        // The MCP SDK's JSONRPCRequestSchema is .strict() (types.js:114-120) — any extra
        // top-level key fails union-parse and the SDK returns -32700 "Parse error: Invalid
        // JSON-RPC message". The SDK reads request-scoped _meta from request.params._meta
        // (shared/protocol.js:321) and surfaces it to handlers as RequestHandlerExtra._meta
        // — the same location Layer 2's readLayer2 reads from.
        if (req.method === "POST" && req.body && typeof req.body === "object") {
          // For a batch request (array), inject into each item; for a single
          // request (object), inject into the single message.
          const injectMeta = (msg: Record<string, unknown>): Record<string, unknown> => {
            const existingParams =
              msg.params && typeof msg.params === "object" && !Array.isArray(msg.params)
                ? (msg.params as Record<string, unknown>)
                : {};
            const existingParamsMeta =
              existingParams._meta &&
              typeof existingParams._meta === "object" &&
              !Array.isArray(existingParams._meta)
                ? (existingParams._meta as Record<string, unknown>)
                : {};
            // Only inject if the caller has not already declared an agentId
            // (cooperative Layer 2: caller-declared params._meta wins over OAuth-derived).
            if (existingParamsMeta[AGENT_ID_META_KEY]) return msg;
            return {
              ...msg,
              params: {
                ...existingParams,
                _meta: {
                  ...existingParamsMeta,
                  [AGENT_ID_META_KEY]: oauthResult.agentId,
                },
              },
            };
          };

          if (Array.isArray(req.body)) {
            req.body = req.body.map((item: unknown) =>
              item && typeof item === "object" && !Array.isArray(item)
                ? injectMeta(item as Record<string, unknown>)
                : item
            );
          } else {
            req.body = injectMeta(req.body as Record<string, unknown>);
          }
        }
      } else {
        // No OAuth provider available; static-bearer check already failed.
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
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "Minsky MCP Server",
      transport: "http",
      timestamp: new Date().toISOString(),
    });
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
  app.listen(httpPort, options.host, () => {
    log.cli("Minsky MCP Server started with HTTP transport");
    log.cli(`Server listening on ${options.host}:${httpPort}`);
    log.cli(`MCP endpoint: http://${options.host}:${httpPort}${options.endpoint}`);
    log.cli(`Health check: http://${options.host}:${httpPort}/health`);
    if (projectContext) {
      log.cli(`Repository path: ${projectContext.repositoryPath}`);
    }
    log.cli("Ready to receive MCP requests via HTTP");
  });

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

    const { PersistenceProvider } = await import("../../domain/persistence/types");
    if (!(persistence instanceof PersistenceProvider)) return null;
    if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
      return null;
    }
    const connection = await persistence.getDatabaseConnection();
    if (!connection) return null;

    const { DrizzleWakePendingRepository } = await import(
      "../../domain/ask/wake-pending-repository"
    );
    const wakeRepo = new DrizzleWakePendingRepository(
      connection as import("drizzle-orm/postgres-js").PostgresJsDatabase
    );

    const sessionProvider = container.has("sessionProvider")
      ? (container.get(
          "sessionProvider"
        ) as import("../../domain/session/types").SessionProviderInterface)
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

    const { PersistenceProvider } = await import("../../domain/persistence/types");
    if (!(persistence instanceof PersistenceProvider)) return null;
    if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
      return null;
    }
    const connection = await persistence.getDatabaseConnection();
    if (!connection) return null;

    const { createEmbeddingServiceFromConfig } = await import(
      "../../domain/ai/embedding-service-factory"
    );
    const embeddingService = await createEmbeddingServiceFromConfig();

    const { createVectorStorageForDomain } = await import(
      "../../domain/storage/vector/vector-storage-factory"
    );
    const vectorStorage = await createVectorStorageForDomain(
      "memory",
      MEMORY_EMBEDDING_DIMENSION,
      persistence
    );

    const { MemoryService } = await import("../../domain/memory");
    type MemoryServiceDb = import("../../domain/memory/memory-service").MemoryServiceDb;
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
 * Create the MCP "start" subcommand.
 */
export function createStartCommand(
  container?: import("../../composition/types").AppContainerInterface
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
    .action(async (options) => {
      try {
        // mt#1745: cold-start profiling. `profileCheckpoint` is shared with
        // `src/cli.ts` so all checkpoint `t=` values are relative to the
        // SAME baseline (set at cli.ts module load).
        profileCheckpoint("action_entry");

        // Determine transport type from --http flag
        const transportType = options.http ? "http" : "stdio";

        // Validate HTTP configuration if using HTTP transport
        if (transportType === "http") {
          const port = parseInt(options.port, 10);
          if (isNaN(port) || port < 1 || port > 65535) {
            log.cliError(`Invalid port: ${options.port}. Must be a number between 1 and 65535`);
            exit(1);
          }
          // Hosted MCP: the developer-setup guard is a dev-laptop UX nudge and
          // does not apply to a server process. See mt#1208.
          setHostedMode(true);
        }

        const projectContext = resolveProjectContext(options.repo);

        // mt#1457: build the MCP-backed capability registry and wire it both
        // into the container (for asks.create / router consumers) and into
        // the MinskyMCPServer (for register/unregister of Server instances).
        // The CLI composition root (`createCliContainer`) registers a no-op
        // by default; this override replaces it for MCP-server execution so
        // routing decisions reflect actual host capabilities.
        const clientCapabilityRegistry = new MCPClientCapabilityRegistry();
        if (container) {
          container.set("clientCapabilityRegistry", clientCapabilityRegistry);
        }

        // Prepare server configuration
        const serverConfig = {
          name: "Minsky MCP Server",
          version: "1.0.0", // TODO: Import from package.json
          projectContext,
          transportType: transportType as "stdio" | "http",
          clientCapabilityRegistry,
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

        // Create server with the specified transport
        const server = new MinskyMCPServer(serverConfig);
        profileCheckpoint("server_constructed");

        // Register tools via adapter-based approach (initializes container if needed)
        const commandMapper = new CommandMapper(server, server.getProjectContext());
        profileCheckpoint("mapper_constructed");
        await registerAllTools(commandMapper, container);
        profileCheckpoint("tools_registered");

        // Wire the container into the server so agentId can be written to session records
        // (must happen after registerAllTools which triggers container.initialize())
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
                let oauthConfig: import("../../domain/configuration/schemas/oauth").OAuthConfig;
                try {
                  const { getConfiguration } = await import("../../domain/configuration/index");
                  const fullConfig = getConfiguration() as {
                    oauth?: import("../../domain/configuration/schemas/oauth").OAuthConfig;
                  };
                  oauthConfig = fullConfig.oauth;
                } catch {
                  oauthConfig = undefined;
                }
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

        // Start the server
        if (transportType === "http") {
          await startHttpServer(
            server,
            {
              port: options.port,
              host: options.host,
              endpoint: options.endpoint,
              requireAuth: options.requireAuth,
            },
            projectContext,
            oauthProvider
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
          .catch(() => {}); // Embedding sweep is best-effort

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

        const proc = process as Record<string, unknown>;
        (proc["on"] as (signal: string, handler: () => void) => void)("SIGTERM", cleanup);
        (proc["on"] as (signal: string, handler: () => void) => void)("SIGINT", cleanup);
        (proc["on"] as (signal: string, handler: () => void) => void)("SIGHUP", cleanup);

        // When the Claude Code parent closes its stdio pipe (without sending a signal),
        // trigger the same shutdown path (mt#1417). The `shutdownInFlight` guard
        // inside `cleanup` makes this listener idempotent even if it fires more
        // than once (PR #881 R1 NON-BLOCKING). Only attach for stdio transport —
        // HTTP-mode containers don't use stdin and may run with stdin closed at
        // startup, which would falsely trigger.
        if (!options.http) {
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
          transportType: options.http ? "http" : "stdio",
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
