/**
 * Tests for TokenProvider implementations and factory.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { FallbackTokenProvider } from "./fallback-token-provider";
import { GitHubAppTokenProvider } from "./github-app-token-provider";
import { createTokenProvider } from "./index";
import type { GitHubConfig } from "../configuration/schemas/github";
import { githubServiceAccountSchema } from "../configuration/schemas/github";

// ---------------------------------------------------------------------------
// Test RSA private key (PKCS#1) — generated for testing only
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEoQIBAAKCAQEAuUhZwlRuwNsMAy/JmdD2tk24/c0myXkCwfBL6aPU/WpJM57V
+z05/peRhntj9oI3Pxj4nv14J2h80eWU80HDBFwlc2EbYroxDNDCDAdwZ9fRuh/9
xZg8foNoMpVk8riAID4TRE/9tYfeyaOa9W5KITAK/aHMYGoemxMnD1W1ZYcf517V
bnY+x+/wmyGRbPMSmBopg+o88ZiUhqSW9qOgun/PHh4MKg4/kgMqc4WOWWmZQ0a7
zCNrUlK51jC/Z9yVkSnxR6zTjjO4tqKdU2klcEwJ2h3REncfDMFZVX0ROxzXAIGD
oDkaYh99zHLSj3T5Y7KiMR9x3oDi4UoDI1/I4wIDAQABAoH/NtOt9NFEPeGoHBR3
wlOLYKvsVPU9ix/MDIdR711pBNlEERCcFKHe2r6dpM5oq8RCL0s6d5CmMEg3AMkR
fUu1X3Je579w73K/p1ZXzFf1azbhsivp3hbXDMmY3Q3F36uouEttQ4qxPZrAQAMX
dBcgj1gkCPXJrzgA5sIfjdXM5e5+c5UzVEBly8TBWTdvfIE6JJMuN1rfRK+uGial
Qx2j1pDWHJA4WRukeZLmdHjd9ea/fRTUD60e5VKgYBvctwd81lkkPmF9AanWQJ3J
5WbvDDI83DRADCLPOXcBZloe6qRP/ZjB04GQzDCZfxbyaZrYZq0clY8RCfDrdiaa
YaDNAoGBAO/YXIx1i31K/uy3Ysycz7PqRbctKlKmyjJ4o9dK5tenl9A3D2SaEL3F
g8LRCapATnwBnStcd4v2z1hytxe7ZppOFNcOpSegbO+17PpMbeL3rV5xSB+MM4xH
1lD9ecT9I/9/ZSYess9OWiiWBNQTWxEEsZGYt0ym+KqEoshik0EvAoGBAMXDK3oc
GztOaOPK2AoTJj4MnIGUzJj8SyNJOtzZk0a/qG6L27pyvzw96ftRP1eZa1OQZLfW
DkdB4FhMGOpvVCx47drwKff4QpScsYdVWX256sKNdAsPHEhOCQS5cy0iepNV3I3N
O9tj4MuqUxHy9G04CrsR/0cpxjUtc8+vXL6NAoGAE9fEoGJBLhZ8TL1HUUJP9MSX
C/aSn8/ovpA4jeFGg+T7rGBBx8LvS6QBqKZ+tDUpyRyhEitOQKgks16aQz5f2LhJ
BRnTFBozqQlWF8cm+DYhg8S/gMyqnxp6Yqz13BRNXCAAEE1N4dTLpLv0nk8To67N
ugv2bkMKI6Fhjk6JfEUCgYA8HOxNTNfWOipV+6WZwmJggBLerK1YX3AzhKH42cYT
vlRjbe3XieOpWySReQvpA8CFASIsY0upy1N3Y4I7WKXcctHSOCh5sKQEanDoM0Bl
oCrFApxgdDJjpBzHq9tfv9hEitfk3pqwQHbnUZm4ngJAZMWWQY04Q3F1XqCSY7qs
TQKBgQCXM/aW8gdLFvyAglkxFmLPE4RlgvCcy8OXjqopgfI7+8BDXQAP6uKcy9H1
gicj+Lu66GNJFYrrIDc+RkME8xGNo38CEkoO6W7dITIw1ip2oMkxBX9LLZTy+v8w
SiWZtxA1AOVEz0flzOck3r0Falfb+Gc6mlG9zTPv/0m0BEuziA==
-----END RSA PRIVATE KEY-----`;

// ---------------------------------------------------------------------------
// FallbackTokenProvider
// ---------------------------------------------------------------------------

describe("FallbackTokenProvider", () => {
  const userToken = "ghp_usertoken123";
  let provider: FallbackTokenProvider;

  beforeEach(() => {
    provider = new FallbackTokenProvider(userToken);
  });

  it("getServiceToken returns the user token", async () => {
    expect(await provider.getServiceToken()).toBe(userToken);
  });

  it("getServiceToken ignores repo argument and still returns user token", async () => {
    expect(await provider.getServiceToken("owner/repo")).toBe(userToken);
  });

  it("getUserToken returns the user token", async () => {
    expect(await provider.getUserToken()).toBe(userToken);
  });

  it("getServiceIdentity returns null", async () => {
    expect(await provider.getServiceIdentity()).toBeNull();
  });

  it("isServiceAccountConfigured returns false", () => {
    expect(provider.isServiceAccountConfigured()).toBe(false);
  });

  it("isRoleConfigured returns false for both implementer and reviewer", () => {
    // Fallback mode has no service-account credentials at all, so neither
    // role is "configured" in the strict sense — even though getToken always
    // succeeds by returning the user token.
    expect(provider.isRoleConfigured("implementer")).toBe(false);
    expect(provider.isRoleConfigured("reviewer")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GitHubAppTokenProvider helpers
// ---------------------------------------------------------------------------

/** Build a provider with the test key injected via privateKeyLoader. */
function makeProvider(
  overrides: Partial<ConstructorParameters<typeof GitHubAppTokenProvider>[0]> = {}
): GitHubAppTokenProvider {
  return new GitHubAppTokenProvider({
    appId: 12345,
    privateKeyFile: "/fake/path/key.pem",
    installationId: 67890,
    userToken: "ghp_usertoken456",
    privateKeyLoader: () => TEST_PRIVATE_KEY,
    ...overrides,
  });
}

/** Replace globalThis.fetch with a mock for the duration of fn. */
async function withFetch(fakeFetch: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// GitHubAppTokenProvider
// ---------------------------------------------------------------------------

describe("GitHubAppTokenProvider", () => {
  describe("isServiceAccountConfigured", () => {
    it("returns true", () => {
      expect(makeProvider().isServiceAccountConfigured()).toBe(true);
    });
  });

  describe("isRoleConfigured", () => {
    it("implementer is always configured when GitHubAppTokenProvider is in use", () => {
      const provider = makeProvider();
      expect(provider.isRoleConfigured("implementer")).toBe(true);
    });

    it("reviewer is NOT configured when reviewerConfig is absent (single-App mode)", () => {
      // No reviewerConfig — reviewer falls back silently in getToken, but
      // isRoleConfigured must report false so callers can detect the absence
      // and refuse to silently fall back when posting APPROVE / REQUEST_CHANGES.
      const provider = makeProvider();
      expect(provider.isRoleConfigured("reviewer")).toBe(false);
    });

    it("reviewer IS configured when reviewerConfig is supplied (dual-App mode)", () => {
      const provider = makeProvider({
        reviewerConfig: {
          appId: 99999,
          installationId: 88888,
          privateKeyLoader: () => TEST_PRIVATE_KEY,
        },
      });
      expect(provider.isRoleConfigured("reviewer")).toBe(true);
      expect(provider.isRoleConfigured("implementer")).toBe(true);
    });
  });

  describe("getUserToken", () => {
    it("returns the user token passed at construction", async () => {
      const provider = makeProvider({ userToken: "ghp_mytoken" });
      expect(await provider.getUserToken()).toBe("ghp_mytoken");
    });
  });

  describe("generateJwt", () => {
    it("produces a three-part dot-separated JWT", () => {
      const jwt = makeProvider().generateJwt();
      expect(jwt.split(".")).toHaveLength(3);
    });

    it("header encodes alg RS256 and typ JWT", () => {
      const jwt = makeProvider().generateJwt();
      const headerJson = Buffer.from(jwt.split(".")[0] ?? "", "base64url").toString("utf8");
      const header = JSON.parse(headerJson) as { alg: string; typ: string };
      expect(header.alg).toBe("RS256");
      expect(header.typ).toBe("JWT");
    });

    it("payload contains iss equal to appId", () => {
      const provider = makeProvider({ appId: 99999 });
      const jwt = provider.generateJwt();
      const payloadJson = Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8");
      const payload = JSON.parse(payloadJson) as { iss: number; iat: number; exp: number };
      expect(payload.iss).toBe(99999);
      expect(payload.exp).toBeGreaterThan(payload.iat);
    });
  });

  describe("getServiceToken — caching", () => {
    it("caches the installation token and returns the same value on second call", async () => {
      let fetchCallCount = 0;
      const fakeFetch = mock(async (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.toString()
              : (url as Request).url;
        if (urlStr.includes("/access_tokens")) {
          fetchCallCount++;
          return new Response(JSON.stringify({ token: "ghs_installtoken" }), { status: 201 });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = makeProvider();
        const token1 = await provider.getServiceToken();
        const token2 = await provider.getServiceToken();
        const expectedToken = "ghs_installtoken";
        expect(token1).toBe(expectedToken);
        expect(token2).toBe(expectedToken);
        expect(fetchCallCount).toBe(1); // cached — only one HTTP call
      });
    });

    it("refreshes the token when it is close to expiry", async () => {
      let fetchCallCount = 0;
      const fakeFetch = mock(async (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.toString()
              : (url as Request).url;
        if (urlStr.includes("/access_tokens")) {
          fetchCallCount++;
          return new Response(JSON.stringify({ token: `ghs_token_${fetchCallCount}` }), {
            status: 201,
          });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = makeProvider();

        // Inject a cached token that expires in 3 minutes (below the 5-min threshold)
        // Set expiry to epoch 0 — always in the past, always triggers refresh
        const soonExpiry = new Date(0);
        // cachedToken now lives on the implementerClient inside the provider
        const impl = (provider as unknown as Record<string, unknown>)["implementerClient"] as {
          _cachedToken: { token: string; expiresAt: Date } | null;
        };
        impl._cachedToken = {
          token: "ghs_old_token",
          expiresAt: soonExpiry,
        };

        const token = await provider.getServiceToken();
        expect(token).toBe("ghs_token_1"); // refreshed
        expect(fetchCallCount).toBe(1);
      });
    });
  });

  describe("getServiceToken — repo scoping", () => {
    it("passes repository name in request body when repo is specified", async () => {
      let capturedBody: unknown;
      const fakeFetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse((init?.body as string) ?? "{}");
        return new Response(JSON.stringify({ token: "ghs_scoped" }), { status: 201 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = makeProvider();
        const token = await provider.getServiceToken("edobry/minsky");
        expect(token).toBe("ghs_scoped");
        expect((capturedBody as { repositories: string[] }).repositories).toEqual(["minsky"]);
      });
    });

    it("extracts repo name from owner/repo format", async () => {
      let capturedBody: unknown;
      const fakeFetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse((init?.body as string) ?? "{}");
        return new Response(JSON.stringify({ token: "ghs_scoped2" }), { status: 201 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = makeProvider();
        await provider.getServiceToken("owner/my-repo");
        expect((capturedBody as { repositories: string[] }).repositories).toEqual(["my-repo"]);
      });
    });

    it("sends no body when repo is not specified", async () => {
      let capturedInit: RequestInit | undefined;
      const fakeFetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify({ token: "ghs_noscope" }), { status: 201 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = makeProvider();
        await provider.getServiceToken();
        expect(capturedInit?.body).toBeUndefined();
      });
    });
  });

  describe("getServiceIdentity", () => {
    it("returns login with [bot] suffix from app slug", async () => {
      const fakeFetch = mock(async () => {
        return new Response(JSON.stringify({ slug: "minsky-ai", id: 12345 }), { status: 200 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = makeProvider();
        const identity = await provider.getServiceIdentity();
        expect(identity).toEqual({ login: "minsky-ai[bot]", type: "app" });
      });
    });

    it("caches the app identity after first fetch", async () => {
      let fetchCount = 0;
      const fakeFetch = mock(async () => {
        fetchCount++;
        return new Response(JSON.stringify({ slug: "minsky-ai" }), { status: 200 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = makeProvider();
        await provider.getServiceIdentity();
        await provider.getServiceIdentity();
        expect(fetchCount).toBe(1);
      });
    });

    it("throws when GitHub API returns an error", async () => {
      const fakeFetch = mock(async () => {
        return new Response("Unauthorized", { status: 401 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = makeProvider();
        await expect(provider.getServiceIdentity()).rejects.toThrow(
          "Failed to fetch GitHub App info"
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Private-key resolution: env-var (inline) vs file vs neither.
  // These tests do NOT inject `privateKeyLoader` — they exercise the real
  // `resolvePrivateKey` method end-to-end, which is the whole point of mt#1138.
  // -------------------------------------------------------------------------
  describe("private key resolution", () => {
    it("resolves from inline privateKey without touching the filesystem", () => {
      const provider = new GitHubAppTokenProvider({
        appId: 1,
        privateKey: TEST_PRIVATE_KEY,
        privateKeyFile: "/definitely/does/not/exist.pem",
        installationId: 1,
        userToken: "u",
      });
      // JWT generation exercises the full resolution path through crypto.sign.
      // If the key came from the nonexistent file, we'd get ENOENT; if the key
      // came from `privateKey` inline, signing succeeds and we get 3 dot-parts.
      const jwt = provider.generateJwt();
      expect(jwt.split(".")).toHaveLength(3);
    });

    it("privateKey takes precedence over privateKeyFile", () => {
      // Same setup — both set, file path bogus. Only precedence makes this work.
      const provider = new GitHubAppTokenProvider({
        appId: 1,
        privateKey: TEST_PRIVATE_KEY,
        privateKeyFile: "/definitely/does/not/exist.pem",
        installationId: 1,
        userToken: "u",
      });
      expect(() => provider.generateJwt()).not.toThrow();
    });

    it("normalizes single-line \\n-escaped PEM (Railway multiline flattening) to real newlines", () => {
      const flattened = TEST_PRIVATE_KEY.replace(/\n/g, "\\n");
      // Sanity check: flattened form genuinely has no real newlines.
      expect(flattened.includes("\n")).toBe(false);
      expect(flattened.includes("\\n")).toBe(true);

      const provider = new GitHubAppTokenProvider({
        appId: 1,
        privateKey: flattened,
        installationId: 1,
        userToken: "u",
      });
      // Without normalization, crypto.sign rejects the PEM; JWT generation throws.
      // With normalization, signing succeeds.
      expect(() => provider.generateJwt()).not.toThrow();
    });

    it("throws a clear error mentioning the env var name when neither is set", () => {
      const provider = new GitHubAppTokenProvider({
        appId: 1,
        installationId: 1,
        userToken: "u",
      });
      expect(() => provider.generateJwt()).toThrow(/MINSKY_GITHUB_APP_PRIVATE_KEY/);
      expect(() => provider.generateJwt()).toThrow(/privateKeyFile/);
    });

    it("throws when privateKey is malformed PEM", () => {
      const provider = new GitHubAppTokenProvider({
        appId: 1,
        privateKey:
          "-----BEGIN RSA PRIVATE KEY-----\nnot-actually-valid-base64-content\n-----END RSA PRIVATE KEY-----",
        installationId: 1,
        userToken: "u",
      });
      expect(() => provider.generateJwt()).toThrow();
    });

    it("does not leak PEM content in the 'neither set' error message", () => {
      const provider = new GitHubAppTokenProvider({
        appId: 1,
        installationId: 1,
        userToken: "u",
      });
      try {
        provider.generateJwt();
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain("-----BEGIN");
        expect(msg).not.toContain("-----END");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Acceptance test 1: per-role token isolation (dual-App mode)
  // When reviewer credentials are configured, implementer and reviewer tokens
  // come from different App installations.
  // -------------------------------------------------------------------------
  describe("getToken — dual-App routing (acceptance test 1)", () => {
    it("returns different tokens for implementer and reviewer roles when reviewer App configured", async () => {
      // Implementer App returns "ghs_implementer_token", reviewer App returns "ghs_reviewer_token".
      const fakeFetch = mock(async (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.toString()
              : (url as Request).url;
        if (urlStr.includes("/installations/11111/access_tokens")) {
          return new Response(JSON.stringify({ token: "ghs_implementer_token" }), { status: 201 });
        }
        if (urlStr.includes("/installations/22222/access_tokens")) {
          return new Response(JSON.stringify({ token: "ghs_reviewer_token" }), { status: 201 });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = new GitHubAppTokenProvider({
          appId: 10000,
          installationId: 11111,
          userToken: "ghp_user",
          privateKeyLoader: () => TEST_PRIVATE_KEY,
          reviewerConfig: {
            appId: 20000,
            installationId: 22222,
            privateKeyLoader: () => TEST_PRIVATE_KEY,
          },
        });

        const implToken = await provider.getToken("implementer");
        const reviewerToken = await provider.getToken("reviewer");

        expect(implToken).toBe("ghs_implementer_token");
        expect(reviewerToken).toBe("ghs_reviewer_token");
        // They must differ — different App identities
        expect(implToken).not.toBe(reviewerToken);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Acceptance test 2: single-App fallback when reviewer config is absent
  // Both roles must return the same implementer token without error.
  // -------------------------------------------------------------------------
  describe("getToken — single-App fallback (acceptance test 2)", () => {
    it("both roles return the same token when reviewer config is absent", async () => {
      const SINGLE_APP_TOKEN = "ghs_single_app_token";
      const fakeFetch = mock(async (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.toString()
              : (url as Request).url;
        if (urlStr.includes("/access_tokens")) {
          return new Response(JSON.stringify({ token: SINGLE_APP_TOKEN }), { status: 201 });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        // No reviewerConfig supplied — single-App mode
        const provider = makeProvider();

        const implToken = await provider.getToken("implementer");
        // The cache means only 1 HTTP call happened; reviewer falls back to same client.
        const reviewerToken = await provider.getToken("reviewer");

        expect(implToken).toBe(SINGLE_APP_TOKEN);
        expect(reviewerToken).toBe(SINGLE_APP_TOKEN);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Acceptance test 3: cache isolation per role
  // Each role maintains its own cache; a cache hit for one role must not
  // suppress a fetch for the other role.
  // -------------------------------------------------------------------------
  describe("getToken — cache isolation per role (acceptance test 3)", () => {
    it("caches tokens independently per role in dual-App mode", async () => {
      const IMPL_CACHED_TOKEN = "ghs_impl_cached";
      const REVIEWER_CACHED_TOKEN = "ghs_reviewer_cached";
      let implFetchCount = 0;
      let reviewerFetchCount = 0;

      const fakeFetch = mock(async (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.toString()
              : (url as Request).url;
        if (urlStr.includes("/installations/33333/access_tokens")) {
          implFetchCount++;
          return new Response(JSON.stringify({ token: IMPL_CACHED_TOKEN }), { status: 201 });
        }
        if (urlStr.includes("/installations/44444/access_tokens")) {
          reviewerFetchCount++;
          return new Response(JSON.stringify({ token: REVIEWER_CACHED_TOKEN }), { status: 201 });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = new GitHubAppTokenProvider({
          appId: 30000,
          installationId: 33333,
          userToken: "ghp_user",
          privateKeyLoader: () => TEST_PRIVATE_KEY,
          reviewerConfig: {
            appId: 40000,
            installationId: 44444,
            privateKeyLoader: () => TEST_PRIVATE_KEY,
          },
        });

        // Each role fetches once, then serves from cache on subsequent calls.
        const impl1 = await provider.getToken("implementer");
        const impl2 = await provider.getToken("implementer");
        const rev1 = await provider.getToken("reviewer");
        const rev2 = await provider.getToken("reviewer");

        expect(impl1).toBe(IMPL_CACHED_TOKEN);
        expect(impl2).toBe(IMPL_CACHED_TOKEN);
        expect(rev1).toBe(REVIEWER_CACHED_TOKEN);
        expect(rev2).toBe(REVIEWER_CACHED_TOKEN);

        // Exactly one HTTP call per role — cache prevents extra fetches
        expect(implFetchCount).toBe(1);
        expect(reviewerFetchCount).toBe(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Acceptance test 4: backward-compat — no role arg defaults to implementer
  // -------------------------------------------------------------------------
  describe("getToken — backward-compat (acceptance test 4)", () => {
    it("calling getToken with no role arg returns the implementer token", async () => {
      const IMPL_DEFAULT_TOKEN = "ghs_impl_default";
      const REVIEWER_DEFAULT_TOKEN = "ghs_reviewer_default";
      const fakeFetch = mock(async (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.toString()
              : (url as Request).url;
        if (urlStr.includes("/installations/55555/access_tokens")) {
          return new Response(JSON.stringify({ token: IMPL_DEFAULT_TOKEN }), { status: 201 });
        }
        if (urlStr.includes("/installations/66666/access_tokens")) {
          return new Response(JSON.stringify({ token: REVIEWER_DEFAULT_TOKEN }), { status: 201 });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = new GitHubAppTokenProvider({
          appId: 50000,
          installationId: 55555,
          userToken: "ghp_user",
          privateKeyLoader: () => TEST_PRIVATE_KEY,
          reviewerConfig: {
            appId: 60000,
            installationId: 66666,
            privateKeyLoader: () => TEST_PRIVATE_KEY,
          },
        });

        // No role argument — must behave identically to "implementer"
        const tokenNoRole = await provider.getToken();
        const tokenImplicit = await provider.getToken("implementer");

        expect(tokenNoRole).toBe(IMPL_DEFAULT_TOKEN);
        expect(tokenImplicit).toBe(IMPL_DEFAULT_TOKEN);
        // Both come from the implementer installation — not the reviewer installation
        expect(tokenNoRole).not.toBe(REVIEWER_DEFAULT_TOKEN);
      });
    });
  });

  // -------------------------------------------------------------------------
  // expires_at honoured: cache expiry comes from GitHub's response, not a
  // hardcoded 1-hour assumption. (mt#1509 R1 BLOCKING fix.)
  // -------------------------------------------------------------------------
  describe("getToken — expires_at honoured", () => {
    it("uses GitHub's expires_at timestamp for the cache entry", async () => {
      // GitHub policy can issue tokens with a shorter window than 1h. Use a
      // fixed reference point so we don't need wall-clock arithmetic at test time.
      const REFERENCE_NOW = 1_750_000_000_000;
      const githubExpiry = new Date(REFERENCE_NOW + 30 * 60 * 1000).toISOString();

      const fakeFetch = mock(async () => {
        return new Response(
          JSON.stringify({ token: "ghs_short_lived", expires_at: githubExpiry }),
          { status: 201 }
        );
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = makeProvider();
        await provider.getToken();
        const cached = (
          provider as unknown as { implementerClient: { _cachedToken: { expiresAt: Date } | null } }
        ).implementerClient._cachedToken;

        if (cached === null) throw new Error("expected cached token to be set");
        // The cached expiry should match GitHub's timestamp exactly (parsed back from ISO).
        expect(cached.expiresAt.getTime()).toBe(Date.parse(githubExpiry));
      });
    });

    it("falls back to ~1-hour expiry when expires_at is missing from the response", async () => {
      const fakeFetch = mock(async () => {
        return new Response(JSON.stringify({ token: "ghs_no_expiry" }), { status: 201 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const before = Date.now();
        const provider = makeProvider();
        await provider.getToken();
        const after = Date.now();
        const cached = (
          provider as unknown as { implementerClient: { _cachedToken: { expiresAt: Date } | null } }
        ).implementerClient._cachedToken;

        if (cached === null) throw new Error("expected cached token to be set");
        // Fallback expiry should be ~1 hour from when the fetch resolved.
        const expiryMs = cached.expiresAt.getTime();
        expect(expiryMs).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
        expect(expiryMs).toBeLessThanOrEqual(after + 60 * 60 * 1000);
      });
    });
  });

  // -------------------------------------------------------------------------
  // getServiceIdentity is role-aware: implementer and reviewer Apps return
  // their own slugs; cache is keyed per-role. (mt#1509 R1 BLOCKING fix.)
  // -------------------------------------------------------------------------
  describe("getServiceIdentity — role-aware", () => {
    it("returns implementer slug for implementer role and reviewer slug for reviewer role", async () => {
      let implFetchCount = 0;
      let reviewerFetchCount = 0;

      const fakeFetch = mock(async (url: string | URL | Request) => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.toString()
              : (url as Request).url;
        if (urlStr.endsWith("/app")) {
          // Differentiate by JWT signed with each App's key — but our mock
          // can't inspect the JWT, so instead we use installation ID hint:
          // the test calls getAppInfo only via the per-role client, and the
          // SingleAppClient returned by clientForRole is the correct one.
          // Since GitHub's /app endpoint returns the App for the JWT issuer,
          // we just count which call came when by call order.
          if (implFetchCount + reviewerFetchCount === 0) {
            implFetchCount++;
            return new Response(JSON.stringify({ slug: "minsky-ai" }), { status: 200 });
          }
          reviewerFetchCount++;
          return new Response(JSON.stringify({ slug: "minsky-reviewer" }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = new GitHubAppTokenProvider({
          appId: 70000,
          installationId: 77777,
          userToken: "ghp_user",
          privateKeyLoader: () => TEST_PRIVATE_KEY,
          reviewerConfig: {
            appId: 80000,
            installationId: 88888,
            privateKeyLoader: () => TEST_PRIVATE_KEY,
          },
        });

        const implIdentity = await provider.getServiceIdentity("implementer");
        const reviewerIdentity = await provider.getServiceIdentity("reviewer");

        expect(implIdentity).toEqual({ login: "minsky-ai[bot]", type: "app" });
        expect(reviewerIdentity).toEqual({ login: "minsky-reviewer[bot]", type: "app" });

        // Each role fetched exactly once — per-role cache, not shared.
        expect(implFetchCount).toBe(1);
        expect(reviewerFetchCount).toBe(1);
      });
    });

    it("caches identity per-role independently", async () => {
      let totalFetchCount = 0;
      const fakeFetch = mock(async () => {
        totalFetchCount++;
        return new Response(JSON.stringify({ slug: "minsky-ai" }), { status: 200 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        const provider = new GitHubAppTokenProvider({
          appId: 90000,
          installationId: 99999,
          userToken: "ghp_user",
          privateKeyLoader: () => TEST_PRIVATE_KEY,
          reviewerConfig: {
            appId: 90001,
            installationId: 99998,
            privateKeyLoader: () => TEST_PRIVATE_KEY,
          },
        });

        // 2 implementer calls + 2 reviewer calls = exactly 2 fetches (one per role)
        await provider.getServiceIdentity("implementer");
        await provider.getServiceIdentity("implementer");
        await provider.getServiceIdentity("reviewer");
        await provider.getServiceIdentity("reviewer");

        expect(totalFetchCount).toBe(2);
      });
    });

    it("falls back to implementer identity when reviewer requested but not configured", async () => {
      const fakeFetch = mock(async () => {
        return new Response(JSON.stringify({ slug: "minsky-ai" }), { status: 200 });
      }) as unknown as typeof fetch;

      await withFetch(fakeFetch, async () => {
        // No reviewerConfig — single-App mode
        const provider = makeProvider();

        const reviewerIdentity = await provider.getServiceIdentity("reviewer");
        expect(reviewerIdentity).toEqual({ login: "minsky-ai[bot]", type: "app" });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Schema-level validation: at-least-one-of privateKey/privateKeyFile required
// when serviceAccount is configured.
// ---------------------------------------------------------------------------
describe("githubServiceAccountSchema", () => {
  const base = { type: "github-app" as const, appId: 1, installationId: 1 };

  it("accepts serviceAccount with only privateKeyFile", () => {
    const result = githubServiceAccountSchema.safeParse({
      ...base,
      privateKeyFile: "/path/to/key.pem",
    });
    expect(result.success).toBe(true);
  });

  it("accepts serviceAccount with only privateKey", () => {
    const result = githubServiceAccountSchema.safeParse({
      ...base,
      privateKey: "some-pem-content",
    });
    expect(result.success).toBe(true);
  });

  it("accepts serviceAccount with both privateKey and privateKeyFile set", () => {
    const result = githubServiceAccountSchema.safeParse({
      ...base,
      privateKey: "pem",
      privateKeyFile: "/path/to/key.pem",
    });
    expect(result.success).toBe(true);
  });

  it("rejects serviceAccount with neither privateKey nor privateKeyFile", () => {
    const result = githubServiceAccountSchema.safeParse({ ...base });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createTokenProvider factory
// ---------------------------------------------------------------------------

describe("createTokenProvider", () => {
  it("returns FallbackTokenProvider when serviceAccount is not configured", () => {
    const config: GitHubConfig = { token: "ghp_user" };
    const provider = createTokenProvider(config, "ghp_user");
    expect(provider).toBeInstanceOf(FallbackTokenProvider);
    expect(provider.isServiceAccountConfigured()).toBe(false);
  });

  it("returns GitHubAppTokenProvider when serviceAccount is configured", () => {
    const config: GitHubConfig = {
      token: "ghp_user",
      serviceAccount: {
        type: "github-app",
        appId: 3436626,
        privateKeyFile: "~/.config/minsky/minsky-app.pem",
        installationId: 125403046,
      },
    };
    const provider = createTokenProvider(config, "ghp_user");
    expect(provider).toBeInstanceOf(GitHubAppTokenProvider);
    expect(provider.isServiceAccountConfigured()).toBe(true);
  });

  it("FallbackTokenProvider passes user token through for both service and user", async () => {
    const config: GitHubConfig = {};
    const provider = createTokenProvider(config, "ghp_fallback");
    expect(await provider.getServiceToken()).toBe("ghp_fallback");
    expect(await provider.getUserToken()).toBe("ghp_fallback");
  });

  it("returns GitHubAppTokenProvider with reviewer routing when reviewer.serviceAccount is configured", () => {
    const config: GitHubConfig = {
      token: "ghp_user",
      serviceAccount: {
        type: "github-app",
        appId: 10001,
        privateKeyFile: "~/.config/minsky/minsky-app.pem",
        installationId: 77777,
      },
      reviewer: {
        serviceAccount: {
          type: "github-app",
          appId: 20001,
          privateKeyFile: "~/.config/minsky/minsky-reviewer.pem",
          installationId: 88888,
        },
      },
    };

    // The factory should produce a GitHubAppTokenProvider with reviewer credentials wired.
    // The dual-App routing itself is tested in the GitHubAppTokenProvider suite above.
    const provider = createTokenProvider(config, "ghp_user");
    expect(provider).toBeInstanceOf(GitHubAppTokenProvider);
    expect(provider.isServiceAccountConfigured()).toBe(true);
  });
});
