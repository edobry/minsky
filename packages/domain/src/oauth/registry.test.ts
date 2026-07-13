/**
 * Tests for the OAuth provider registry — mt#1662
 *
 * Verifies:
 * 1. resolveOAuthProvider returns a provider instance for "in-process".
 * 2. The returned placeholder throws on every method call (not-yet-implemented).
 * 3. resolveOAuthProvider throws on unknown provider strings.
 * 4. resolveOAuthProvider throws on valid-but-unimplemented providers (auth0, clerk, etc.).
 * 5. resolveOAuthProvider uses "in-process" as the default when no config is passed.
 */

import { describe, test, expect } from "bun:test";
import { resolveOAuthProvider } from "./registry";

describe("resolveOAuthProvider", () => {
  test('returns a provider instance for provider "in-process"', () => {
    const provider = resolveOAuthProvider({ provider: "in-process" });
    expect(provider).toBeDefined();
    expect(typeof provider.discoveryMetadata).toBe("function");
    expect(typeof provider.protectedResourceMetadata).toBe("function");
    expect(typeof provider.registerClient).toBe("function");
    expect(typeof provider.authorize).toBe("function");
    expect(typeof provider.token).toBe("function");
    expect(typeof provider.validateToken).toBe("function");
  });

  test("uses in-process as default when config is undefined", () => {
    const provider = resolveOAuthProvider(undefined);
    expect(provider).toBeDefined();
    expect(typeof provider.validateToken).toBe("function");
  });

  test("uses in-process as default when provider field is absent", () => {
    // OAuthConfig with no provider field — should default to "in-process"
    const provider = resolveOAuthProvider({} as { provider: "in-process" });
    expect(provider).toBeDefined();
  });

  test("placeholder throws on discoveryMetadata (not-yet-implemented)", async () => {
    const provider = resolveOAuthProvider({ provider: "in-process" });
    await expect(provider.discoveryMetadata({} as never)).rejects.toThrow(/not implemented/i);
  });

  test("placeholder throws on protectedResourceMetadata (not-yet-implemented)", async () => {
    const provider = resolveOAuthProvider({ provider: "in-process" });
    await expect(provider.protectedResourceMetadata({} as never)).rejects.toThrow(
      /not implemented/i
    );
  });

  test("placeholder throws on registerClient (not-yet-implemented)", async () => {
    const provider = resolveOAuthProvider({ provider: "in-process" });
    await expect(provider.registerClient({} as never)).rejects.toThrow(/not implemented/i);
  });

  test("placeholder throws on authorize (not-yet-implemented)", async () => {
    const provider = resolveOAuthProvider({ provider: "in-process" });
    await expect(provider.authorize({} as never, {} as never)).rejects.toThrow(/not implemented/i);
  });

  test("placeholder throws on token (not-yet-implemented)", async () => {
    const provider = resolveOAuthProvider({ provider: "in-process" });
    await expect(provider.token({} as never, {} as never)).rejects.toThrow(/not implemented/i);
  });

  test("placeholder throws on validateToken (not-yet-implemented)", async () => {
    const provider = resolveOAuthProvider({ provider: "in-process" });
    await expect(provider.validateToken("some-bearer-token")).rejects.toThrow(/not implemented/i);
  });

  test("placeholder error message references mt#1663", async () => {
    const provider = resolveOAuthProvider({ provider: "in-process" });
    await expect(provider.discoveryMetadata({} as never)).rejects.toThrow(/mt#1663/);
  });

  test('throws for unimplemented provider "cloudflare-worker"', () => {
    expect(() => resolveOAuthProvider({ provider: "cloudflare-worker" })).toThrow(
      /not yet implemented/i
    );
  });

  test('throws for unimplemented provider "auth0"', () => {
    expect(() => resolveOAuthProvider({ provider: "auth0" })).toThrow(/not yet implemented/i);
  });

  test('throws for unimplemented provider "clerk"', () => {
    expect(() => resolveOAuthProvider({ provider: "clerk" })).toThrow(/not yet implemented/i);
  });

  test("throws for completely unknown provider string (runtime guard)", () => {
    // Cast to bypass TypeScript to simulate runtime misconfiguration
    expect(() => resolveOAuthProvider({ provider: "completely-unknown" as "in-process" })).toThrow(
      /unknown oauth provider/i
    );
  });
});
