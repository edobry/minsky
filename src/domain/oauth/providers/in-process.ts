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
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
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

    const clientId = generateRandomId();
    const clientSecret = generateRandomSecret();
    const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];
    const authMethod = body.token_endpoint_auth_method ?? "client_secret_basic";

    // Persist via the adapter (DCR registration stores in oauth_clients)
    const adapterFactory = createAdapterFactory(this.config.db);
    const clientAdapter = new adapterFactory("Client");
    await clientAdapter.upsert(
      clientId,
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: body.redirect_uris,
        grant_types: grantTypes,
        token_endpoint_auth_method: authMethod,
        client_name: body.client_name,
      },
      // No expiry for clients (0 = permanent)
      Number.MAX_SAFE_INTEGER
    );

    return {
      client_id: clientId,
      client_secret: clientSecret,
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

    // Forward to the oidc-provider Koa app via the Node.js http callback.
    // The Provider extends Koa, which exposes a callback() method returning a
    // standard Node.js (req, res) => void handler compatible with Express.
    await forwardToKoaProvider(provider, req, res);
  }

  async token(req: Request, res: Response): Promise<void> {
    const issuer = deriveIssuer(req, this.config.issuer ?? this.resolvedIssuer);
    const provider = this.getProvider(issuer);
    await forwardToKoaProvider(provider, req, res);
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

/** Generates a URL-safe random ID (16 bytes = 32 hex chars). */
function generateRandomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generates a URL-safe random client secret (32 bytes = 64 hex chars). */
function generateRandomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Forwards an Express req/res pair to a Koa-based oidc-provider instance.
 * The Provider class extends Koa, which exposes `callback()` returning a
 * standard Node.js `(req, res) => void` handler compatible with Express.
 */
function forwardToKoaProvider(provider: OidcProvider, req: Request, res: Response): Promise<void> {
  const handler = (
    provider as {
      callback: () => (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
    }
  ).callback();
  return new Promise<void>((resolve, reject) => {
    handler(req, res, (err?: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    });
  });
}
