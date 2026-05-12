/**
 * InProcessOAuthProvider — mt#1663
 *
 * Default OAuth 2.1 / OpenID Connect identity provider that runs in-process.
 * Wraps Filip Skokan's `oidc-provider` library with a Postgres adapter
 * (backed by the schema from mt#1662).
 *
 * Capabilities:
 *   - RFC 7591 Dynamic Client Registration (DCR)
 *   - RFC 7636 PKCE (S256 only; `plain` rejected)
 *   - RFC 8707 Resource Indicators (audience binding)
 *   - RFC 8414 Authorization Server Metadata discovery
 *   - RFC 9728 Protected Resource Metadata discovery
 *   - Refresh-token rotation
 *
 * Signing key:
 *   - Sourced from `config.signingKey` (env-var ref `env:MY_KEY` or raw JWK JSON).
 *   - If absent, generates an ephemeral RSA-2048 keypair at first construction.
 *     WARNING: ephemeral keys invalidate all existing tokens on restart.
 *     Set a persistent key in config for production deployments (see mt#1667).
 *
 * Issuer:
 *   - Sourced from `config.issuer` if present.
 *   - Otherwise derived from the first incoming request's Host header via
 *     `composeRequestBaseUrl`. Cached after first derivation.
 *
 * Route handlers are NOT wired here -- that is mt#1634c/d/e. This provider
 * exposes capability methods that route handlers call.
 */

import { generateKeyPairSync, createPublicKey } from "crypto";
import type { Request, Response } from "express";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { log } from "../../../utils/logger";
import { oauthAccessTokensTable } from "../../storage/schemas/oauth-schema";
import { createAdapterFactory, sha256 } from "./in-process-postgres-adapter";
import type {
  OAuthIdentityProvider,
  OAuthServerMetadata,
  OAuthProtectedResourceMetadata,
  OAuthClientRegistrationRequest,
  OAuthClientRegistrationResponse,
  OAuthValidationResult,
} from "../types";

// ---------------------------------------------------------------------------
// oidc-provider import
// Note: oidc-provider is ESM-only and emits a runtime warning about Bun.
// The warning is cosmetic; the library works under Bun for our use case.
// ---------------------------------------------------------------------------

// require() is intentional: oidc-provider is ESM-only but Bun resolves it
// via CJS interop at runtime. A static import would cause top-level-await issues.
const oidcProvider = require("oidc-provider");
type OidcProvider = InstanceType<typeof oidcProvider.Provider>;

// ---------------------------------------------------------------------------
// JWK helpers
// ---------------------------------------------------------------------------

interface JwkKeyPair {
  privateJwk: Record<string, unknown>;
  publicJwk: Record<string, unknown>;
}

/**
 * Generates an ephemeral RSA-2048 signing key pair.
 * Returns the private JWK (for signing) and public JWK (for JWKS endpoint).
 */
function generateEphemeralKeyPair(): JwkKeyPair {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateJwk = {
    ...privateKey.export({ format: "jwk" }),
    use: "sig",
    alg: "RS256",
  };
  const publicJwk = {
    ...createPublicKey(privateKey).export({ format: "jwk" }),
    use: "sig",
    alg: "RS256",
  };
  return { privateJwk, publicJwk };
}

/**
 * Resolves the signing JWK from config.
 * - `env:MY_VAR` -> reads JSON from the named env var.
 * - raw JSON string -> parses and returns.
 * - absent -> generates ephemeral key (logs WARN).
 */
function resolveSigningKey(signingKey: string | undefined): JwkKeyPair {
  if (!signingKey) {
    log.warn(
      "[InProcessOAuthProvider] No signingKey configured -- generating ephemeral RSA-2048 key. " +
        "Tokens will be invalidated on restart. Set oauth.signingKey in config for production. " +
        "See mt#1667 for the production key-management guide."
    );
    return generateEphemeralKeyPair();
  }

  if (signingKey.startsWith("env:")) {
    const envVar = signingKey.slice(4);
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(
        `[InProcessOAuthProvider] env var "${envVar}" referenced by oauth.signingKey is not set`
      );
    }
    const parsed = JSON.parse(envValue) as Record<string, unknown>;
    const publicJwk = { ...parsed };
    // Remove private key material from the public copy
    delete publicJwk.d;
    delete publicJwk.p;
    delete publicJwk.q;
    delete publicJwk.dp;
    delete publicJwk.dq;
    delete publicJwk.qi;
    return { privateJwk: parsed, publicJwk };
  }

  // Raw JWK JSON string
  const parsed = JSON.parse(signingKey) as Record<string, unknown>;
  const publicJwk = { ...parsed };
  delete publicJwk.d;
  delete publicJwk.p;
  delete publicJwk.q;
  delete publicJwk.dp;
  delete publicJwk.dq;
  delete publicJwk.qi;
  return { privateJwk: parsed, publicJwk };
}

// ---------------------------------------------------------------------------
// Config shape accepted by InProcessOAuthProvider
// ---------------------------------------------------------------------------

export interface InProcessOAuthProviderConfig {
  /** Postgres Drizzle database instance for token storage. */
  db: PostgresJsDatabase;
  /** Explicit issuer URL. If absent, derived from first request's Host header. */
  issuer?: string;
  /**
   * JWK signing key reference:
   * - `"env:MY_VAR"` -> reads from env var
   * - raw JWK JSON string -> parsed inline
   * - absent -> ephemeral key generated (WARN logged)
   */
  signingKey?: string;
  /**
   * MCP endpoint path (the path component of the protected resource URL).
   * Used by `protectedResourceMetadata()` to advertise the resource and by
   * the audience-binding check in start-command.ts to enforce equality.
   * Defaults to `/mcp` when unset. Must match the `--endpoint` flag passed
   * to the MCP server's HTTP transport.
   */
  endpointPath?: string;
}

// ---------------------------------------------------------------------------
// InProcessOAuthProvider implementation
// ---------------------------------------------------------------------------

/**
 * Concrete `OAuthIdentityProvider` that wraps `oidc-provider`.
 *
 * The `oidc-provider` `Provider` instance is lazy-constructed on the first
 * method call that requires it, because the issuer URL may need to be derived
 * from the first incoming request.
 */
export class InProcessOAuthProvider implements OAuthIdentityProvider {
  private readonly config: InProcessOAuthProviderConfig;
  private provider: OidcProvider | null = null;
  private resolvedIssuer: string | null = null;
  private readonly keyPair: JwkKeyPair;

  constructor(config: InProcessOAuthProviderConfig) {
    this.config = config;
    if (config.issuer) {
      this.resolvedIssuer = config.issuer;
    }
    this.keyPair = resolveSigningKey(config.signingKey);
  }

  // ---------------------------------------------------------------------------
  // Provider initialization
  // ---------------------------------------------------------------------------

  /**
   * Returns (or creates) the oidc-provider Provider instance.
   * If issuer is not yet known, `issuerHint` is used to derive it.
   */
  private getProvider(issuerHint: string): OidcProvider {
    if (!this.resolvedIssuer) {
      this.resolvedIssuer = issuerHint;
      log.debug(`[InProcessOAuthProvider] Derived issuer from request: ${issuerHint}`);
    }

    if (this.provider) return this.provider;

    // PR #1055 R1: surface the v1 security posture explicitly. devInteractions
    // is enabled (mt#1665 placeholder) and the consent step is therefore
    // unauthenticated UI theatre — the user's input is discarded by findAccount,
    // which hardcodes sub="operator". This means tokens always represent the
    // single operator principal, but the public OAuth flow is reachable to
    // anyone. mt#1683 replaces devInteractions with token-gated consent.
    log.warn(
      "[InProcessOAuthProvider] OAuth v1 security posture: devInteractions UI is unauthenticated; all issued tokens use sub=operator. See mt#1683 for the token-gated consent UI that supersedes this placeholder."
    );

    const adapterFactory = createAdapterFactory(this.config.db);
    const issuer = this.resolvedIssuer;
    const privateJwk = this.keyPair.privateJwk;

    this.provider = new oidcProvider.Provider(issuer, {
      adapter: adapterFactory,

      // Signing keys: RSA-2048 private JWK
      jwks: {
        keys: [privateJwk],
      },

      // RFC 7591 Dynamic Client Registration
      features: {
        registration: {
          enabled: true,
          idFactory: () => generateRandomId(),
        },
        // RFC 8707 Resource Indicators
        resourceIndicators: {
          enabled: true,
          defaultResource: (ctx: unknown) => {
            // No default resource; clients must specify audience explicitly
            void ctx;
            return undefined;
          },
          getResourceServerInfo: (_ctx: unknown, resourceIndicator: string) => {
            return {
              scope: "mcp",
              audience: resourceIndicator,
              accessTokenTTL: 3600,
              accessTokenFormat: "opaque",
            };
          },
        },
        // mt#1665: enable oidc-provider's built-in consent UI. Without this,
        // the authorization-code flow stalls at /interaction/:uid (404) because
        // no custom interaction handlers are registered. The built-in UI is
        // intentionally minimal HTML — sufficient for v1; a Minsky-branded
        // custom consent template can land as a follow-up.
        devInteractions: { enabled: true },
        introspection: { enabled: false },
        revocation: { enabled: false },
      },

      // PKCE: S256 only, plain rejected
      pkce: {
        methods: ["S256"],
        required: () => true,
      },

      // Refresh token rotation
      rotateRefreshToken: true,

      // Token TTLs
      // NOTE: oidc-provider 9.8.3's checkTTL() validates function values with
      // `value.constructor.toString() === 'function Function() { [native code] }'`.
      // Under Bun, Function.prototype.toString() includes newlines, so the check
      // fails for ALL default TTL function values. Every entry must be an explicit
      // number to satisfy the validator when running under Bun.
      ttl: {
        AccessToken: 3600,
        AuthorizationCode: 300,
        RefreshToken: 86400 * 30, // 30 days
        Interaction: 3600,
        Session: 86400 * 14, // 14 days
        // Sentinel values for unused features (CIBA, device flow, client credentials,
        // grant, id-token) — never exercised but must be present to pass checkTTL().
        BackchannelAuthenticationRequest: 600,
        ClientCredentials: 3600,
        DeviceCode: 600,
        Grant: 86400 * 14,
        IdToken: 3600,
      },

      // Scopes
      scopes: ["openid", "mcp", "offline_access"],

      // Claims mapping for OpenID Connect
      claims: {
        openid: ["sub"],
        profile: ["sub"],
      },

      // Response types
      responseTypes: ["code"],

      // Grant types
      grantTypes: ["authorization_code", "refresh_token"],

      // Clients: none pre-configured; DCR handles registration
      clients: [],

      // Cookie secrets for session (ephemeral; acceptable for v1)
      cookies: {
        short: { signed: false },
        long: { signed: false },
        keys: ["ephemeral-cookie-secret"],
      },

      // mt#1754: minimal findAccount for single-tenant Minsky v1.
      // SECURITY: returns a FIXED operator identity regardless of what input
      // the user typed in devInteractions. The username field in the dev UI is
      // theatre — entered text is discarded. The sub claim is always "operator",
      // which means any token issued by this server represents the same single
      // operator principal. This is the correct posture for single-tenant Minsky
      // MCP, where there is no user-account model.
      //
      // Why not echo the devInteractions input (PR #1055 R1 BLOCKING): with DCR
      // enabled and devInteractions enabled, ANY reachable client could
      // self-assert an arbitrary `sub` by typing it in the login form, and that
      // value would propagate into `agentId` and authorization decisions. The
      // hardcode neutralizes that surface — there is exactly one identity that
      // can be issued.
      //
      // mt#1683 will replace devInteractions with token-gated consent UI
      // (operator presents MINSKY_MCP_AUTH_TOKEN), at which point this
      // placeholder either disappears or stays as the same fixed identity but
      // the consent step actually authenticates the operator.
      findAccount: async (_ctx: unknown, _id: string) => ({
        accountId: "operator",
        async claims() {
          return { sub: "operator" };
        },
      }),

      // mt#1757: override oidc-provider's default renderError so internal
      // exceptions get logged at error-level (with stack trace) AND surfaced
      // visibly to the user. The default renderer returns an opaque "oops!"
      // HTML page and silently swallows the underlying Error — which makes
      // OAuth-flow debugging unusably slow (each iteration requires another
      // deploy just to discover what was actually broken).
      renderError: async (ctx: unknown, out: unknown, err: unknown) => {
        const errAsError = err instanceof Error ? err : null;
        const errAsAny = err as { statusCode?: number } | null;
        const outAsObj = (out ?? {}) as {
          error?: string;
          error_description?: string;
          status?: number;
          headers?: Record<string, string>;
        };

        // Server-side: full error with stack for debugging.
        log.error("oidc-provider renderError invoked", {
          error: errAsError?.message ?? String(err),
          stack: errAsError?.stack,
          errorClass: errAsError?.constructor?.name ?? typeof err,
          out: outAsObj,
          // Read ctx fields defensively — Koa context, not a plain object.
          path: (ctx as { path?: string } | null)?.path,
          method: (ctx as { method?: string } | null)?.method,
        });

        // PR #1057 R1: operate on the real Koa context (no `?? {}` fallback —
        // that would create a detached plain object and the response would
        // never actually be written). Set status, headers, type, and body
        // through the Koa context APIs.
        const kctx = ctx as {
          type?: string;
          status?: number;
          body?: string;
          set?: (k: string, v: string) => void;
        };

        // Propagate oidc-provider's intended status (prefer out.status; fall
        // back to err.statusCode if it's a Koa-style HTTP error; default 500).
        kctx.status = outAsObj.status ?? errAsAny?.statusCode ?? 500;

        // Propagate any headers oidc-provider supplied (e.g., WWW-Authenticate
        // for auth-class errors). Use kctx.set if available; otherwise skip.
        if (outAsObj.headers && typeof kctx.set === "function") {
          for (const [k, v] of Object.entries(outAsObj.headers)) {
            kctx.set(k, v);
          }
        }

        // Client-side: page with the exception class + message (no stack).
        kctx.type = "html";
        kctx.body = `<!DOCTYPE html>
<html><head><title>OAuth flow error</title></head>
<body style="font-family: system-ui; max-width: 700px; margin: 2em auto; padding: 1em;">
  <h1>OAuth flow error</h1>
  <p>The OAuth authorization server encountered an internal error.</p>
  <pre style="background: #f0f0f0; padding: 1em; border-radius: 4px; overflow-x: auto;">
error:             ${escapeHtml(outAsObj.error ?? "unknown")}
error_description: ${escapeHtml(outAsObj.error_description ?? "unknown")}
exception:         ${escapeHtml(errAsError?.constructor?.name ?? "Error")}: ${escapeHtml(errAsError?.message ?? String(err))}
  </pre>
  <p><small>This information is also logged server-side. mt#1757 added this diagnostic surface.</small></p>
</body></html>`;
      },

      // For Bun/non-standard runtime compatibility
      httpOptions: () => ({ timeout: 30000 }),
    }) as OidcProvider;

    return this.provider;
  }

  // ---------------------------------------------------------------------------
  // OAuthIdentityProvider interface
  // ---------------------------------------------------------------------------

  async discoveryMetadata(req: Request): Promise<OAuthServerMetadata> {
    const issuer = deriveIssuer(req, this.config.issuer ?? this.resolvedIssuer);
    const provider = this.getProvider(issuer);

    // Build RFC 8414 metadata document. The provider.issuer property is the
    // canonical issuer string set at construction time.
    const providerIssuer = provider.issuer as string;

    // mt#1667 R3 fix: advertise the URLs that Express actually mounts, not
    // oidc-provider's library defaults (`/auth`, `/token`, `/reg`, `/jwks`).
    // The Express routes are wired in `src/commands/mcp/start-command.ts`:
    //   /oauth/authorize  (mt#1665)
    //   /oauth/token      (mt#1665)
    //   /register         (mt#1664)
    // claude.ai web follows RFC 8414 discovery to the advertised URLs, so
    // these strings MUST match the mounted handlers or the OAuth flow breaks
    // with 404s. JWKS is intentionally omitted from advertising — the in-
    // process provider's keys are private to this server and we don't expose
    // a JWKS endpoint; clients consume access tokens as opaque bearers.
    return {
      issuer: providerIssuer,
      authorization_endpoint: `${providerIssuer}/oauth/authorize`,
      token_endpoint: `${providerIssuer}/oauth/token`,
      registration_endpoint: `${providerIssuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      // v1 supports public PKCE clients only (token_endpoint_auth_method=none).
      // client_secret_basic and client_secret_post are not supported because
      // ClientAdapter.find() does not return the raw client_secret (only stores
      // a hash), so oidc-provider would reject those clients at authorize time
      // with invalid_client_metadata. See mt#1746.
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["openid", "mcp", "offline_access"],
      code_challenge_methods_supported: ["S256"],
    };
  }

  async protectedResourceMetadata(req: Request): Promise<OAuthProtectedResourceMetadata> {
    const issuer = deriveIssuer(req, this.config.issuer ?? this.resolvedIssuer);
    // mt#1667 R3 fix: parameterize resource path. The middleware in
    // start-command.ts enforces audience equality against
    // `composeRequestBaseUrl(req) + normalizeEndpointPath(options.endpoint)`.
    // If an operator runs with a non-default --endpoint, hardcoding `/mcp`
    // here would break the OAuth flow. The provider config now carries the
    // configured endpoint path (defaulting to `/mcp` when not supplied).
    const endpointPath = this.config.endpointPath ?? "/mcp";

    return {
      resource: `${issuer}${endpointPath}`,
      authorization_servers: [issuer],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    };
  }

  async registerClient(
    body: OAuthClientRegistrationRequest
  ): Promise<OAuthClientRegistrationResponse> {
    // Validate required fields
    if (!body.redirect_uris || body.redirect_uris.length === 0) {
      throw new Error("redirect_uris is required for client registration");
    }

    // v1 supports public PKCE clients only (token_endpoint_auth_method=none).
    // Reject non-none auth methods per RFC 7591: client_secret_basic and
    // client_secret_post cannot be supported because ClientAdapter.find() stores
    // only a bcrypt hash of the secret — not the raw secret — so oidc-provider's
    // authorize handler would reject those clients with invalid_client_metadata.
    // PKCE (S256) is enforced via pkce.required: () => true. See mt#1746.
    const authMethod = body.token_endpoint_auth_method ?? "none";
    if (authMethod !== "none") {
      throw new Error(
        `Only token_endpoint_auth_method='none' (public PKCE clients) is supported; ` +
          `received '${authMethod}'. Re-register with token_endpoint_auth_method='none'.`
      );
    }

    const clientId = generateRandomId();
    // Public clients (none auth method) do NOT get a client_secret.
    // The adapter's upsert conditionally stores a hash only when client_secret is present
    // (see in-process-postgres-adapter.ts line ~166).
    const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];

    // Persist via the adapter (DCR registration stores in oauth_clients)
    const adapterFactory = createAdapterFactory(this.config.db);
    const clientAdapter = new adapterFactory("Client");
    await clientAdapter.upsert(
      clientId,
      {
        client_id: clientId,
        // Intentionally omit client_secret for public PKCE clients (authMethod=none).
        // The adapter stores a hash only when client_secret is present; omitting it
        // here means no secret is stored and oidc-provider can load the client cleanly.
        redirect_uris: body.redirect_uris,
        grant_types: grantTypes,
        token_endpoint_auth_method: authMethod,
        client_name: body.client_name,
      },
      // No expiry for clients (0 = permanent)
      Number.MAX_SAFE_INTEGER
    );

    // Public clients: do NOT include client_secret in the response.
    // RFC 7591 §3.2.1 allows omitting client_secret when the client is public.
    return {
      client_id: clientId,
      client_name: body.client_name,
      redirect_uris: body.redirect_uris,
      grant_types: grantTypes,
      token_endpoint_auth_method: authMethod,
    };
  }

  async authorize(req: Request, res: Response): Promise<void> {
    const issuer = deriveIssuer(req, this.config.issuer ?? this.resolvedIssuer);
    const provider = this.getProvider(issuer);

    // Enforce PKCE: reject requests without code_challenge
    const query = req.query as Record<string, string>;
    if (!query.code_challenge) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "PKCE code_challenge is required (S256 method)",
      });
      return;
    }
    if (query.code_challenge_method && query.code_challenge_method !== "S256") {
      res.status(400).json({
        error: "invalid_request",
        error_description: "Only S256 code_challenge_method is supported; plain is rejected",
      });
      return;
    }

    // mt#1746 R2: legacy-client runtime guard. Pre-mt#1746 clients in the DB
    // may have token_endpoint_auth_method set to client_secret_basic/post.
    // ClientAdapter.find() does not return the raw secret (only stores a hash),
    // so oidc-provider would reject those clients at authorize with an opaque
    // "invalid_client_metadata: client_secret is mandatory property" error.
    // Catch them here with an actionable "re-register" message.
    if (query.client_id) {
      const legacyCheck = await this.checkLegacyClient(query.client_id);
      if (legacyCheck.isLegacy) {
        res.status(400).json({
          error: "invalid_client",
          error_description:
            `This client was registered with token_endpoint_auth_method='${legacyCheck.authMethod}', ` +
            `which is no longer supported. Remove and re-add the MCP integration to re-register ` +
            `as a public PKCE client (token_endpoint_auth_method='none').`,
        });
        return;
      }
    }

    // Forward to the oidc-provider Koa app via the Node.js http callback.
    // The Provider extends Koa, which exposes a callback() method returning a
    // standard Node.js (req, res) => void handler compatible with Express.
    // Internal path "/auth" is the oidc-provider default for the authorization endpoint
    // (see node_modules/oidc-provider/lib/helpers/defaults.js routes.authorization).
    await forwardToKoaProvider(provider, req, res, "/auth");
  }

  async token(req: Request, res: Response): Promise<void> {
    const issuer = deriveIssuer(req, this.config.issuer ?? this.resolvedIssuer);
    const provider = this.getProvider(issuer);

    // mt#1746 R2: legacy-client runtime guard (parallel to authorize). Catches
    // the case where a cached auth code is exchanged against a legacy client.
    // The client_id may be in form body (client_secret_post-style) or basic auth header.
    // For "none" clients, RFC 7591 requires client_id in form body.
    const body = req.body as Record<string, string> | undefined;
    const clientId = body?.client_id;
    if (clientId) {
      const legacyCheck = await this.checkLegacyClient(clientId);
      if (legacyCheck.isLegacy) {
        res.status(400).json({
          error: "invalid_client",
          error_description:
            `This client was registered with token_endpoint_auth_method='${legacyCheck.authMethod}', ` +
            `which is no longer supported. Remove and re-add the MCP integration to re-register ` +
            `as a public PKCE client (token_endpoint_auth_method='none').`,
        });
        return;
      }
    }

    // Internal path "/token" is the oidc-provider default for the token endpoint
    // (see node_modules/oidc-provider/lib/helpers/defaults.js routes.token).
    await forwardToKoaProvider(provider, req, res, "/token");
  }

  /**
   * Forwards requests to the oidc-provider Koa app at oidc-provider's internal
   * path (no URL rewrite). Used by routes where the Express path and
   * oidc-provider's internal path already match exactly — passes req.path
   * through unchanged.
   *
   * Wired Express callers:
   * - `app.all(/^\/interaction\/[^/]+/, ...)` — devInteractions consent UI
   *   (mt#1731). `/interaction/:uid` and subroutes.
   * - `app.all(/^\/auth\/[^/]+/, ...)` — post-interaction authorization
   *   continuation (mt#1753). `/auth/:uid` issues the auth code after consent.
   *
   * Despite the method name (retained for backward-compat), the contract is
   * "forward any oidc-provider internal path that doesn't need URL rewrite."
   * For paths that DO need rewrite (`/oauth/authorize` → `/auth`, etc.), use
   * `authorize()` and `token()` instead.
   */
  async forwardInteraction(req: Request, res: Response): Promise<void> {
    const issuer = deriveIssuer(req, this.config.issuer ?? this.resolvedIssuer);
    const provider = this.getProvider(issuer);
    // req.path is the path without query string, e.g. "/interaction/abc123" or
    // "/auth/abc123". oidc-provider's internal router knows both natively.
    await forwardToKoaProvider(provider, req, res, req.path);
  }

  async validateToken(bearer: string): Promise<OAuthValidationResult> {
    const tokenHash = sha256(bearer);

    let rows;
    try {
      rows = await this.config.db
        .select()
        .from(oauthAccessTokensTable)
        .where(eq(oauthAccessTokensTable.tokenHash, tokenHash))
        .limit(1);
    } catch (err) {
      log.error(
        "[InProcessOAuthProvider] validateToken DB error:",
        err instanceof Error ? err : { error: String(err) }
      );
      return { valid: false, reason: "malformed" };
    }

    const row = rows[0];
    if (!row) return { valid: false, reason: "not_found" };

    const now = new Date();
    if (row.expiresAt < now) return { valid: false, reason: "expired" };
    if (row.revokedAt !== null) return { valid: false, reason: "revoked" };

    let scopes: string[];
    try {
      scopes = JSON.parse(row.scopes) as string[];
    } catch {
      return { valid: false, reason: "malformed" };
    }

    return {
      valid: true,
      principal: {
        sub: row.sub,
        clientId: row.clientId,
        // ADR-006 Decision B format: oauth:claude-ai:user-<sub>
        // conv-<convId> suffix is omitted in v1 — conversation propagation
        // is not yet wired through the HTTP layer. See mt#1666.
        agentId: `oauth:claude-ai:user-${row.sub}`,
      },
      scopes,
      audience: row.audience ?? null,
    };
  }

  /**
   * Look up a client by id and check whether it was registered with a non-"none"
   * token_endpoint_auth_method. Returns `{ isLegacy: true, authMethod }` for
   * pre-mt#1746 clients that should be rejected with a re-register message.
   * Returns `{ isLegacy: false }` for current-shape clients OR for missing
   * clients (let oidc-provider produce the standard "invalid_client" response).
   */
  private async checkLegacyClient(
    clientId: string
  ): Promise<{ isLegacy: true; authMethod: string } | { isLegacy: false }> {
    try {
      const adapterFactory = createAdapterFactory(this.config.db);
      const clientAdapter = new adapterFactory("Client");
      const client = await clientAdapter.find(clientId);
      if (!client) return { isLegacy: false };
      const authMethod = (client as { token_endpoint_auth_method?: string })
        .token_endpoint_auth_method;
      if (authMethod && authMethod !== "none") {
        return { isLegacy: true, authMethod };
      }
      return { isLegacy: false };
    } catch {
      // DB lookup failed: don't block — let oidc-provider produce its own error.
      return { isLegacy: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derives the issuer URL from either an explicit config value or the request.
 * Caches the derived value via `resolvedIssuer` side-channel on the provider
 * instance (handled by `getProvider`).
 */
function deriveIssuer(req: Request, explicit: string | null | undefined): string {
  if (explicit) return explicit;
  const host = req.hostname || "localhost";
  return `${req.protocol}://${host}`;
}

/**
 * Minimal HTML-escape for user-visible error pages.
 * Escapes the 5 characters that have special meaning in HTML text content.
 * mt#1757.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Generates a URL-safe random ID (16 bytes = 32 hex chars). */
function generateRandomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Forwards an Express req/res pair to a Koa-based oidc-provider instance,
 * rewriting `req.url` to oidc-provider's internal path before delegation.
 *
 * oidc-provider's Koa router uses its own internal paths (e.g. `/auth`, `/token`,
 * `/interaction/:uid`) regardless of how Express mounted the endpoint. Express
 * routes are at `/oauth/authorize` and `/oauth/token`, but the Koa router only
 * knows `/auth` and `/token`. Without the rewrite, Koa returns 404 for every
 * Express-originated request.
 *
 * The query string is preserved; only the path component is replaced.
 *
 * @param provider      - The oidc-provider Provider instance (extends Koa).
 * @param req           - Express request.
 * @param res           - Express response.
 * @param internalPath  - The oidc-provider-internal path, e.g. "/auth" or "/token".
 */
function forwardToKoaProvider(
  provider: OidcProvider,
  req: Request,
  res: Response,
  internalPath: string
): Promise<void> {
  // Rewrite req.url so Koa's internal router matches the right route.
  // Express path: /oauth/authorize?... → Koa path: /auth?...
  const original = req.url;
  const queryIdx = original.indexOf("?");
  req.url = queryIdx >= 0 ? internalPath + original.slice(queryIdx) : internalPath;

  // PR #1042 R1 BLOCKING: Koa's `app.callback()` returns a Node-style
  // `(req, res) => void` handler — there is NO `next` parameter. The earlier
  // implementation awaited a Promise resolved via that nonexistent `next`,
  // which Koa never calls, producing a silent deadlock in the Express handler.
  // Resolve on the response's `finish`/`close` events instead, and reject on
  // `error`. Also restore `req.url` in finally so downstream middleware /
  // logging observes the original public URL, not the rewritten internal path.
  const handler = (
    provider as {
      callback: () => (req: unknown, res: unknown) => void;
    }
  ).callback();

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.removeListener("finish", onFinish);
      res.removeListener("close", onClose);
      res.removeListener("error", onError);
      req.url = original;
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    res.once("finish", onFinish);
    res.once("close", onClose);
    res.once("error", onError);

    try {
      handler(req, res);
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
