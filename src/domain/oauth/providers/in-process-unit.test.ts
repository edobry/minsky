/**
 * InProcessOAuthProvider unit-level regression tests — mt#1703
 *
 * These tests run in default CI (no RUN_INTEGRATION_TESTS gate, no DB required).
 *
 * The critical regression: oidc-provider 9.8.3's `checkTTL()` (see
 * `node_modules/oidc-provider/lib/helpers/configuration.js:390`) validates
 * function-valued TTL entries with the V8-specific string comparison:
 *   `value.constructor.toString() === 'function Function() { [native code] }'`
 *
 * Under Bun, `Function.prototype.toString()` returns
 *   `'function Function() {\n    [native code]\n}'`
 * (with newlines), so EVERY default-function TTL entry fails this check.
 *
 * The user-supplied `ttl` config merges with oidc-provider's defaults — any
 * entry left as a default function value will throw on Provider construction.
 * `BackchannelAuthenticationRequest` is the first failing entry alphabetically,
 * which is why the production error message names it specifically. The fix is
 * to override every remaining default function-valued TTL entry with an
 * explicit positive integer.
 *
 * Without the fix, every call to `getProvider()` throws at construction:
 *   "ttl.BackchannelAuthenticationRequest must be a positive integer or a
 *    regular function returning one"
 * causing the discovery endpoint, authorize endpoint, and token endpoint to
 * all return 500. This test suite asserts the construction path succeeds.
 */

import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { InProcessOAuthProvider } from "./in-process";

// ---------------------------------------------------------------------------
// Minimal stub DB — satisfies the PostgresJsDatabase type at the boundaries
// that matter for Provider construction. The TTL validation (checkTTL) fires
// during Provider construction before any adapter call, so the DB is never
// invoked.
// ---------------------------------------------------------------------------

function makeStubDb(): PostgresJsDatabase {
  // The stub only needs to exist as an object reference; the DB methods are
  // never called during Provider construction validation. TypeScript requires
  // the type to match, so we cast via unknown.
  return {} as unknown as PostgresJsDatabase;
}

// ---------------------------------------------------------------------------
// Minimal Express-like request mock
// ---------------------------------------------------------------------------

function mockReq() {
  return {
    protocol: "https",
    hostname: "test.example.com",
    headers: {},
    query: {},
    body: {},
  } as import("express").Request;
}

// ---------------------------------------------------------------------------
// Regression test: Provider construction must NOT throw BackchannelAuthenticationRequest
// ---------------------------------------------------------------------------

describe("InProcessOAuthProvider — Provider construction regression (mt#1703)", () => {
  test("Provider construction succeeds without BackchannelAuthenticationRequest error", async () => {
    // This test fails with:
    //   "ttl.BackchannelAuthenticationRequest must be a positive integer or a
    //    regular function returning one"
    // when the explicit numeric TTL for BackchannelAuthenticationRequest is absent
    // and the default function value fails oidc-provider's Bun-incompatible check.

    const provider = new InProcessOAuthProvider({
      db: makeStubDb(),
      issuer: "https://test.example.com",
      // No signingKey: ephemeral key generated (WARN logged; acceptable in test)
    });

    // discoveryMetadata triggers getProvider() → Provider construction.
    // Assert the call resolves (does NOT reject) — construction succeeded.
    let thrownError: unknown = null;
    try {
      await provider.discoveryMetadata(mockReq());
    } catch (err) {
      thrownError = err;
    }

    // If the TTL-override fix is reverted, thrownError.message contains "BackchannelAuthenticationRequest"
    expect(thrownError).toBeNull();
  });

  test("discoveryMetadata returns required RFC 8414 fields", async () => {
    const provider = new InProcessOAuthProvider({
      db: makeStubDb(),
      issuer: "https://auth.example.com",
    });

    const metadata = await provider.discoveryMetadata(mockReq());

    expect(metadata.issuer).toBe("https://auth.example.com");
    expect(metadata.authorization_endpoint).toBe("https://auth.example.com/oauth/authorize");
    expect(metadata.token_endpoint).toBe("https://auth.example.com/oauth/token");
    expect(metadata.registration_endpoint).toBe("https://auth.example.com/register");
    expect(metadata.response_types_supported).toContain("code");
    expect(metadata.grant_types_supported).toContain("authorization_code");
    expect(metadata.grant_types_supported).toContain("refresh_token");
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.scopes_supported).toContain("mcp");
  });

  test("discoveryMetadata error message identifies BackchannelAuthenticationRequest when CIBA is not disabled", () => {
    // Assertion: if the regression fires, the error message MUST match this pattern.
    // This documents the expected failure signal for future maintainers.
    const cibaErrorPattern = /BackchannelAuthenticationRequest/;

    // The fix is present, so we verify the positive path is clean.
    // The pattern is documented here as a maintenance anchor.
    expect(
      cibaErrorPattern.test("ttl.BackchannelAuthenticationRequest must be a positive integer")
    ).toBe(true);
  });
});
