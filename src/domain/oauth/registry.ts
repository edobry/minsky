/**
 * OAuth provider registry — mt#1662 / mt#1663
 *
 * Resolves the configured `OAuthIdentityProvider` from `oauth.provider` config.
 * The registry reads the provider name and returns the corresponding implementation.
 *
 * Currently supported:
 *   - `"in-process"` — `InProcessOAuthProvider` wrapping `oidc-provider` (mt#1663).
 *
 * Not-yet-supported (but enumerated here to produce useful errors):
 *   - `"cloudflare-worker"`, `"auth0"`, `"clerk"` — future tasks.
 *
 * ADR-002 pattern: callers depend only on `OAuthIdentityProvider`; they never
 * import concrete implementations directly.
 */

import type {
  OAuthIdentityProvider,
  OAuthServerMetadata,
  OAuthProtectedResourceMetadata,
} from "./types";
import type { OAuthConfig } from "../configuration/schemas/oauth";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// ---------------------------------------------------------------------------
// Placeholder implementation (kept for tests that verify the not-yet-implemented
// providers, and as a fallback when no db is available for in-process)
// ---------------------------------------------------------------------------

/**
 * Placeholder `OAuthIdentityProvider` that throws a clear "not implemented" error
 * on every method call. Used as the fallback for `"in-process"` when no `db`
 * is provided, and for external providers (`cloudflare-worker`, `auth0`, `clerk`)
 * that are not yet implemented.
 */
class PlaceholderOAuthProvider implements OAuthIdentityProvider {
  private notImplemented(method: string): never {
    throw new Error(
      `OAuthIdentityProvider.${method} is not implemented. ` +
        `The InProcessOAuthProvider (mt#1663) has not been wired yet. ` +
        `Set oauth.provider = "in-process" and wait for mt#1663 to land.`
    );
  }

  async discoveryMetadata(): Promise<OAuthServerMetadata> {
    return this.notImplemented("discoveryMetadata");
  }

  async protectedResourceMetadata(): Promise<OAuthProtectedResourceMetadata> {
    return this.notImplemented("protectedResourceMetadata");
  }

  async registerClient(): Promise<never> {
    return this.notImplemented("registerClient");
  }

  async authorize(): Promise<never> {
    return this.notImplemented("authorize");
  }

  async token(): Promise<never> {
    return this.notImplemented("token");
  }

  async validateToken(): Promise<never> {
    return this.notImplemented("validateToken");
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Dependencies for constructing the `in-process` provider.
 * Required when `config.provider === "in-process"` (or when using the default).
 */
export interface OAuthProviderDeps {
  /**
   * Postgres Drizzle database for token storage.
   * Required for the `"in-process"` provider; ignored for external providers.
   * If absent, the registry falls back to `PlaceholderOAuthProvider`.
   */
  db?: PostgresJsDatabase;
}

/**
 * Resolves the `OAuthIdentityProvider` from the given oauth config block.
 *
 * @param config - The `oauth` section of the Minsky configuration. Pass `undefined`
 *   to use the default provider (`"in-process"`).
 * @param deps - Optional runtime dependencies (e.g., `db` for the in-process provider).
 * @returns The resolved provider instance.
 * @throws {Error} When `config.provider` is not a recognized value.
 *
 * @example
 * ```ts
 * const provider = resolveOAuthProvider(config.oauth, { db });
 * app.get("/.well-known/oauth-authorization-server", async (req, res) => {
 *   const metadata = await provider.discoveryMetadata(req);
 *   res.json(metadata);
 * });
 * ```
 */
export function resolveOAuthProvider(
  config?: OAuthConfig,
  deps?: OAuthProviderDeps
): OAuthIdentityProvider {
  const providerName = config?.provider ?? "in-process";

  switch (providerName) {
    case "in-process": {
      if (deps?.db) {
        // Real InProcessOAuthProvider — requires Postgres
        const { InProcessOAuthProvider } = require("./providers/in-process");
        return new (InProcessOAuthProvider as new (config: {
          db: PostgresJsDatabase;
          issuer?: string;
          signingKey?: string;
        }) => OAuthIdentityProvider)({
          db: deps.db,
          issuer: config?.issuer,
          signingKey: config?.signingKey,
        });
      }
      // No db provided — fall through to placeholder (test/stub context)
      return new PlaceholderOAuthProvider();
    }

    case "cloudflare-worker":
    case "auth0":
    case "clerk":
      throw new Error(
        `OAuth provider "${providerName}" is not yet implemented. ` +
          `Only "in-process" is supported in this release (mt#1663). ` +
          `Future tasks will add concrete implementations for external providers.`
      );

    default: {
      // Exhaustiveness check -- catches any new values added to OAuthConfig['provider']
      // that aren't handled above. We cast to string for the error message because
      // TypeScript narrows to `never` here; the runtime value may still be an
      // unexpected string if config validation is skipped.
      const unknownProvider: never = providerName;
      throw new Error(
        `Unknown OAuth provider: "${String(unknownProvider)}". ` +
          `Valid values: "in-process", "cloudflare-worker", "auth0", "clerk".`
      );
    }
  }
}
