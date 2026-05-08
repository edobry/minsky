/**
 * OAuth provider registry — mt#1662
 *
 * Resolves the configured `OAuthIdentityProvider` from `oauth.provider` config.
 * The registry reads the provider name and returns the corresponding implementation.
 *
 * Currently supported:
 *   - `"in-process"` — placeholder; the real `InProcessOAuthProvider` ships in mt#1663.
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

// ---------------------------------------------------------------------------
// Placeholder implementation (removed when mt#1663 lands)
// ---------------------------------------------------------------------------

/**
 * Placeholder `OAuthIdentityProvider` that throws a clear "not implemented" error
 * on every method call. Used as the default until `InProcessOAuthProvider` lands
 * in mt#1663.
 *
 * All methods throw rather than returning empty/stub data to prevent callers
 * from silently succeeding with incorrect behavior.
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
 * Resolves the `OAuthIdentityProvider` from the given oauth config block.
 *
 * @param config - The `oauth` section of the Minsky configuration. Pass `undefined`
 *   to use the default provider (`"in-process"`).
 * @returns The resolved provider instance.
 * @throws {Error} When `config.provider` is not a recognized value.
 *
 * @example
 * ```ts
 * const provider = resolveOAuthProvider(config.oauth);
 * app.get("/.well-known/oauth-authorization-server", async (req, res) => {
 *   const metadata = await provider.discoveryMetadata(req);
 *   res.json(metadata);
 * });
 * ```
 */
export function resolveOAuthProvider(config?: OAuthConfig): OAuthIdentityProvider {
  const providerName = config?.provider ?? "in-process";

  switch (providerName) {
    case "in-process":
      // InProcessOAuthProvider ships in mt#1663. Until then, return the placeholder.
      return new PlaceholderOAuthProvider();

    case "cloudflare-worker":
    case "auth0":
    case "clerk":
      throw new Error(
        `OAuth provider "${providerName}" is not yet implemented. ` +
          `Only "in-process" is supported in this release (mt#1662). ` +
          `Future tasks will add concrete implementations for external providers.`
      );

    default: {
      // Exhaustiveness check — catches any new values added to OAuthConfig['provider']
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
