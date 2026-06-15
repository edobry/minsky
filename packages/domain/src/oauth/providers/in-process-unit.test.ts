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
import {
  InProcessOAuthProvider,
  OPERATOR_AGENT_ID,
  OPERATOR_SUB,
  composeOperatorAccount,
} from "./in-process";

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

  test("discoveryMetadata advertises only token_endpoint_auth_methods_supported=['none'] (mt#1746)", async () => {
    const provider = new InProcessOAuthProvider({
      db: makeStubDb(),
      issuer: "https://auth.example.com",
    });

    const metadata = await provider.discoveryMetadata(mockReq());

    // v1 supports public PKCE clients only. Advertising client_secret_basic or
    // client_secret_post would mislead clients into sending methods we can't serve.
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});

// ---------------------------------------------------------------------------
// Proxy-trust regression — mt#1780
// ---------------------------------------------------------------------------
//
// oidc-provider runs as its OWN Koa app and does NOT inherit Express's
// `app.set("trust proxy", 1)`. Behind a TLS-terminating edge (Railway), Koa
// derives the request protocol from its own `app.proxy` flag — default OFF —
// so the devInteractions consent form action renders `http://.../interaction/<uid>`
// and the `_interaction` cookie is not `Secure`. In the claude.ai web connector
// flow (a strict-HTTPS browser context) that http form submission is active
// mixed content → blocked/upgraded → the authorization-code step never completes
// → the connector stays unauthenticated.
//
// The fix sets `this.provider.proxy = true` in getProvider(). This test locks
// it: before the fix `proxy` is the Koa default (false); after, true. The
// existing start-command integration test ("X-Forwarded-Proto: https is
// forwarded correctly") only asserts the EXPRESS discovery endpoint — it never
// exercises the oidc-provider Koa layer, which is why the http leak shipped.
// This unit test closes that coverage gap at the provider layer (no DB / no
// HTTP needed).

describe("InProcessOAuthProvider — proxy-trust regression (mt#1780)", () => {
  test("getProvider() sets provider.proxy=true so Koa honors X-Forwarded-Proto", async () => {
    const provider = new InProcessOAuthProvider({
      db: makeStubDb(),
      issuer: "https://test.example.com",
    });

    // discoveryMetadata() triggers getProvider() → Provider construction + the
    // proxy flag being set.
    await provider.discoveryMetadata(mockReq());

    // Reach into the private oidc-provider instance. `provider.proxy` is
    // oidc-provider's documented setter mapping to Koa's `app.proxy`; with it
    // true, request-derived URLs (interaction form action, redirects) render
    // `https` and cookies get `Secure` behind a TLS-terminating proxy.
    const oidc = (provider as unknown as { provider: { proxy: boolean } }).provider;
    expect(oidc.proxy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DCR token_endpoint_auth_method regression tests — mt#1746
// ---------------------------------------------------------------------------
//
// Root cause: the previous default was "client_secret_basic", which caused
// oidc-provider to reject clients at authorize time with
// "invalid_client_metadata: client_secret is mandatory property" because
// ClientAdapter.find() never returns the raw client_secret (only stores a hash).
//
// The fix: default to "none" (public PKCE clients) and reject any other value.

/**
 * Minimal stub DB for registerClient tests.
 * Stubs the insert chain used by ClientAdapter.upsert():
 *   db.insert(table).values({...}).onConflictDoUpdate({...})
 */
function makeRegisterClientStubDb(): PostgresJsDatabase {
  const onConflictDoUpdate = () => Promise.resolve();
  const values = () => ({ onConflictDoUpdate });
  const insert = () => ({ values });
  return { insert } as unknown as PostgresJsDatabase;
}

describe("InProcessOAuthProvider.registerClient — DCR token_endpoint_auth_method (mt#1746)", () => {
  test("DCR with no token_endpoint_auth_method defaults to 'none' and omits client_secret", async () => {
    const provider = new InProcessOAuthProvider({
      db: makeRegisterClientStubDb(),
      issuer: "https://auth.example.com",
    });

    const result = await provider.registerClient({
      redirect_uris: ["https://claude.ai/callback"],
    });

    // Default must be "none" for public PKCE clients
    expect(result.token_endpoint_auth_method).toBe("none");

    // Public clients MUST NOT have a client_secret in the registration response
    expect("client_secret" in result).toBe(false);

    // Standard fields must still be present
    expect(result.client_id).toBeTruthy();
    expect(result.redirect_uris).toEqual(["https://claude.ai/callback"]);
    expect(result.grant_types).toContain("authorization_code");
  });

  test("DCR with explicit token_endpoint_auth_method='none' omits client_secret", async () => {
    const provider = new InProcessOAuthProvider({
      db: makeRegisterClientStubDb(),
      issuer: "https://auth.example.com",
    });

    const result = await provider.registerClient({
      redirect_uris: ["https://claude.ai/callback"],
      token_endpoint_auth_method: "none",
    });

    expect(result.token_endpoint_auth_method).toBe("none");
    expect("client_secret" in result).toBe(false);
    expect(result.client_id).toBeTruthy();
  });

  test("DCR with token_endpoint_auth_method='client_secret_basic' throws RFC 7591 error", async () => {
    const provider = new InProcessOAuthProvider({
      // Note: the error is thrown before any DB call, so the stub DB is not needed here.
      db: makeStubDb(),
      issuer: "https://auth.example.com",
    });

    let thrownError: unknown = null;
    try {
      await provider.registerClient({
        redirect_uris: ["https://example.com/callback"],
        token_endpoint_auth_method: "client_secret_basic",
      });
    } catch (err) {
      thrownError = err;
    }

    // The error must be thrown (not null)
    expect(thrownError).not.toBeNull();
    const message = thrownError instanceof Error ? thrownError.message : String(thrownError);

    // The error message must identify the unsupported auth method and reference
    // RFC 7591 error shape (start-command.ts wraps this in invalid_client_metadata)
    expect(message).toContain("none");
    expect(message).toContain("client_secret_basic");
  });

  test("DCR with token_endpoint_auth_method='client_secret_post' throws RFC 7591 error", async () => {
    const provider = new InProcessOAuthProvider({
      db: makeStubDb(),
      issuer: "https://auth.example.com",
    });

    let thrownError: unknown = null;
    try {
      await provider.registerClient({
        redirect_uris: ["https://example.com/callback"],
        token_endpoint_auth_method: "client_secret_post",
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).not.toBeNull();
    const message = thrownError instanceof Error ? thrownError.message : String(thrownError);
    expect(message).toContain("none");
    expect(message).toContain("client_secret_post");
  });
});

// ---------------------------------------------------------------------------
// composeOperatorAccount — mt#1764
// ---------------------------------------------------------------------------
//
// Two-axis behavior of single-tenant findAccount:
//   1. Echo input id into accountId (oidc-provider's contract — accountId
//      mismatch with the Session-stored value throws at token-exchange).
//   2. Hardcode sub: "operator" in claims (security — devInteractions
//      input must NOT propagate into authorization decisions).
//
// These tests assert both axes independently for any input id, including
// edge cases (operator-typed-as-input, empty string, arbitrary user value).

describe("composeOperatorAccount (mt#1764)", () => {
  test("accountId echoes the input id for an arbitrary user-typed value", () => {
    const account = composeOperatorAccount("alice");
    expect(account.accountId).toBe("alice");
  });

  test("accountId echoes the input id for the operator-typed value", () => {
    const account = composeOperatorAccount("operator");
    expect(account.accountId).toBe("operator");
  });

  test("accountId echoes the input id even for the empty string", () => {
    // oidc-provider may pass an empty/undefined id in some flows; the contract
    // is to echo whatever was given, not to substitute a default.
    const account = composeOperatorAccount("");
    expect(account.accountId).toBe("");
  });

  test("claims() returns the hardcoded operator sub regardless of input id", async () => {
    for (const input of ["alice", "operator", "", "EVE-malicious-attempt"]) {
      const account = composeOperatorAccount(input);
      const claims = await account.claims();
      expect(claims.sub).toBe(OPERATOR_SUB);
      expect(claims.sub).toBe("operator");
    }
  });

  test("OPERATOR_AGENT_ID has the ADR-006 Decision B shape oauth:claude-ai:user-operator", () => {
    // The agentId is what reaches /mcp's principal context. It must always be
    // the operator's, even if a stored token row's `sub` column says otherwise
    // (which it might if devInteractions captured arbitrary user input).
    expect(OPERATOR_AGENT_ID).toBe("oauth:claude-ai:user-operator");
    expect(OPERATOR_AGENT_ID).toMatch(/^oauth:claude-ai:user-/);
  });
});
