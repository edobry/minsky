/**
 * OAuth Identity Provider abstraction — mt#1634 Architecture § OAuthIdentityProvider
 *
 * Capability-based abstraction (ADR-002 pattern) for the OAuth 2.1 identity layer.
 * Express route handlers in `start-command.ts` consume the resolved provider;
 * they never import concrete implementations directly.
 *
 * Interface shape is the authoritative source for mt#1634 children:
 *   - mt#1663 (InProcessOAuthProvider — wraps oidc-provider)
 *   - mt#1664 (DCR + discovery routes)
 *   - mt#1665 (authorize + token endpoints)
 *   - mt#1666 (validation middleware)
 */

import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Discovery / metadata result types
// ---------------------------------------------------------------------------

/**
 * RFC 8414 authorization server metadata.
 * The `protectedResourceMetadata` call returns RFC 9728 resource metadata;
 * the shape overlaps enough that we use the same record type.
 */
export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  jwks_uri?: string;
  response_types_supported: string[];
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  [key: string]: unknown;
}

/**
 * RFC 9728 protected resource metadata.
 * Returned by `/.well-known/oauth-protected-resource`.
 */
export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

/**
 * Client registration request body per RFC 7591 §2.
 */
export interface OAuthClientRegistrationRequest {
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  [key: string]: unknown;
}

/**
 * Client registration response per RFC 7591 §3.2.1.
 */
export interface OAuthClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  registration_access_token?: string;
  registration_client_uri?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Token validation result
// ---------------------------------------------------------------------------

/**
 * The principal extracted from a valid token.
 */
export interface OAuthPrincipal {
  /** OAuth `sub` claim — unique identifier for the resource owner. */
  sub: string;
  /** Client that was granted the token. */
  clientId: string;
  /**
   * Minsky agent identity string, format: `oauth:claude-ai:user-<sub>[@conv-<convId>]`
   * as defined in mt#1634 Decision B and ADR-006 Layer 0.
   */
  agentId: string;
}

/**
 * Discriminated union returned by `validateToken`.
 *
 * - `{ valid: true }` — token is valid; principal, scopes, and audience are populated.
 * - `{ valid: false }` — token is invalid or expired; `reason` explains why.
 */
export type OAuthValidationResult =
  | {
      valid: true;
      principal: OAuthPrincipal;
      /** Granted scopes. */
      scopes: string[];
      /**
       * RFC 8707 audience — the resource server the token was issued for.
       * Null when the token predates audience binding.
       */
      audience: string | null;
    }
  | {
      valid: false;
      /**
       * Machine-readable reason code.
       * - `"expired"` — token TTL exceeded.
       * - `"revoked"` — token was explicitly revoked.
       * - `"malformed"` — bearer string could not be parsed / verified.
       * - `"not_found"` — token hash not in store.
       */
      reason: "expired" | "revoked" | "malformed" | "not_found";
    };

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Capability-based OAuth identity provider abstraction.
 *
 * Implementations:
 * - `InProcessOAuthProvider` (mt#1663) — wraps `oidc-provider` with a Postgres adapter.
 * - Future: `CloudflareWorkerOAuthProvider`, `Auth0OAuthProvider`, `ClerkOAuthProvider`.
 *
 * Route handlers receive a resolved `OAuthIdentityProvider` instance; they call
 * these methods and forward the results as HTTP responses. The provider is responsible
 * for all protocol-level correctness (PKCE enforcement, RFC 8707 audience binding, etc.).
 */
export interface OAuthIdentityProvider {
  /**
   * Returns RFC 8414 authorization-server metadata.
   * Used by `GET /.well-known/oauth-authorization-server`.
   *
   * @param req - Express request (provider may use host/X-Forwarded-Host to derive issuer URL).
   */
  discoveryMetadata(req: Request): Promise<OAuthServerMetadata>;

  /**
   * Returns RFC 9728 protected-resource metadata.
   * Used by `GET /.well-known/oauth-protected-resource`.
   *
   * @param req - Express request (provider may use host to derive resource URI).
   */
  protectedResourceMetadata(req: Request): Promise<OAuthProtectedResourceMetadata>;

  /**
   * Handles Dynamic Client Registration per RFC 7591.
   * Used by `POST /register`.
   *
   * @param body - Parsed DCR request body.
   */
  registerClient(body: OAuthClientRegistrationRequest): Promise<OAuthClientRegistrationResponse>;

  /**
   * Handles the authorization endpoint (PKCE-enforced).
   * Used by `GET/POST /oauth/authorize`.
   * The provider writes the HTTP response directly (redirect, HTML form, etc.).
   *
   * @param req - Express request.
   * @param res - Express response (provider calls res.redirect / res.send).
   */
  authorize(req: Request, res: Response): Promise<void>;

  /**
   * Handles the token endpoint (issue, refresh, rotation).
   * Used by `POST /oauth/token`.
   * The provider writes the HTTP response directly (JSON token response or error).
   *
   * @param req - Express request.
   * @param res - Express response.
   */
  token(req: Request, res: Response): Promise<void>;

  /**
   * Forwards requests to the oidc-provider Koa app at oidc-provider's internal
   * path (no URL rewrite). Used for paths where the Express route name and
   * oidc-provider's internal route name already match exactly — passes
   * `req.path` through unchanged.
   *
   * Wired callers in `start-command.ts`:
   * - `app.all(/^\/interaction\/[^/]+/, ...)` — devInteractions consent UI
   *   (mt#1731). When `devInteractions: { enabled: true }` is configured,
   *   oidc-provider registers GET/POST `/interaction/:uid` internally; Express
   *   has no matching routes without this method, so the authorize → interaction
   *   redirect would 404.
   * - `app.all(/^\/auth\/[^/]+/, ...)` — post-interaction authorization
   *   continuation (mt#1753). After consent submit, oidc-provider redirects to
   *   `/auth/:uid` to issue the auth code; mirrors the /interaction shape.
   *
   * The method name is retained from its original /interaction-only use; despite
   * the name, the contract is "forward any oidc-provider internal path without
   * URL rewrite." Use `authorize()` and `token()` for the paths that DO require
   * URL rewrite (`/oauth/authorize` → `/auth`, `/oauth/token` → `/token`).
   *
   * @param req - Express request.
   * @param res - Express response.
   */
  forwardInteraction(req: Request, res: Response): Promise<void>;

  /**
   * Validates a Bearer token extracted from an Authorization header.
   * Called by the `/mcp` validation middleware.
   *
   * @param bearer - The raw bearer token string (without "Bearer " prefix).
   * @returns Validation result — discriminated union.
   */
  validateToken(bearer: string): Promise<OAuthValidationResult>;
}
