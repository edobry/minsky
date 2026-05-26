/**
 * OAuth Configuration Schema — mt#1662
 *
 * Zod schema for the `oauth.*` config block. Controls which OAuth identity
 * provider is active and how it is configured.
 *
 * Provider selection is config-driven per mt#1634 Decision A:
 *   - `"in-process"` (default) — wraps `oidc-provider` in-process (mt#1663).
 *   - Future: `"cloudflare-worker"`, `"auth0"`, `"clerk"` (separate tasks).
 */

import { z } from "zod";

/**
 * Supported OAuth provider names.
 * `"in-process"` is the only implemented provider today; the others are
 * enumerated for forward-compatibility and to produce useful config errors.
 */
export const oauthProviderSchema = z.enum(["in-process", "cloudflare-worker", "auth0", "clerk"]);

export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

/**
 * OAuth configuration schema.
 *
 * All fields are optional — the entire block may be absent, and each field
 * falls back to a sensible default at runtime (e.g., provider defaults to
 * `"in-process"`, issuer is derived from the incoming request host).
 */
export const oauthConfigSchema = z
  .strictObject({
    /**
     * Which OAuth identity provider to use.
     * Default: `"in-process"` — runs OAuth flows in-process using `oidc-provider`.
     */
    provider: oauthProviderSchema.default("in-process"),

    /**
     * Issuer URL advertised in OAuth metadata and token `iss` claims.
     * Must be an absolute URL (e.g. `https://minsky-mcp-production.up.railway.app`).
     * If absent, the provider derives the issuer from the incoming request's
     * `Host` / `X-Forwarded-Host` headers at startup time.
     */
    issuer: z.string().url().optional(),

    /**
     * JWK signing key used to sign tokens, or the name of an environment
     * variable that holds the key material.
     *
     * Accepted forms:
     * - `"env:MY_SIGNING_KEY"` — reads the JWK JSON from the named env var.
     * - A raw JWK JSON string (not recommended for config files; prefer env refs).
     *
     * If absent, the `InProcessOAuthProvider` generates an ephemeral signing key
     * at first startup (note: ephemeral keys invalidate tokens on restart; set
     * a persistent key for production deployments).
     */
    signingKey: z.string().optional(),
  })
  .optional();

export type OAuthConfig = z.infer<typeof oauthConfigSchema>;
