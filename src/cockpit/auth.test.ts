/**
 * Unit tests for src/cockpit/auth.ts (mt#2538).
 *
 * Covers the pure/testable pieces of the cockpit daemon's auth posture:
 * token generation/persistence, cookie parsing/serialization, Host-header
 * extraction + allowlist construction, and the mutation-auth / host-allowlist
 * middleware functions in isolation (via minimal fake req/res objects).
 *
 * The end-to-end HTTP-level contract (real server, real requests) is covered
 * separately in server-security.test.ts.
 */
/* eslint-disable custom/no-real-fs-in-tests -- getOrCreateCockpitToken's contract IS reading/writing a real file; a temp dir keeps it isolated from ~/.local/state/minsky */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildAllowedHosts,
  COCKPIT_COOKIE_NAME,
  cookieBootstrapMiddleware,
  extractHostname,
  getOrCreateCockpitToken,
  hostAllowlistMiddleware,
  isLoopbackHost,
  mutationAuthMiddleware,
  parseCookies,
  serializeCockpitCookie,
} from "./auth";

const TEMP_DIR_PREFIX = "cockpit-auth-test-";

// ---------------------------------------------------------------------------
// Token generation / persistence
// ---------------------------------------------------------------------------

describe("getOrCreateCockpitToken", () => {
  test("generates a fresh token when no file exists, persisted with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const tokenPath = join(dir, "cockpit-token");
      const token = getOrCreateCockpitToken(tokenPath);
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);

      const onDisk = readFileSync(tokenPath, { encoding: "utf-8" });
      expect(onDisk).toBe(token);

      // mode & 0o777 isolates the permission bits from the file-type bits.
      const mode = statSync(tokenPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reuses the persisted token across calls (does not regenerate)", () => {
    const dir = mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const tokenPath = join(dir, "cockpit-token");
      const first = getOrCreateCockpitToken(tokenPath);
      const second = getOrCreateCockpitToken(tokenPath);
      expect(second).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two distinct token files get distinct tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const tokenA = getOrCreateCockpitToken(join(dir, "token-a"));
      const tokenB = getOrCreateCockpitToken(join(dir, "token-b"));
      expect(tokenA).not.toBe(tokenB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cookie parsing / serialization
// ---------------------------------------------------------------------------

describe("parseCookies", () => {
  test("returns an empty object for an undefined header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  test("parses a single cookie", () => {
    expect(parseCookies("minsky_cockpit=abc123")).toEqual({ minsky_cockpit: "abc123" });
  });

  test("parses multiple semicolon-separated cookies", () => {
    expect(parseCookies("a=1; b=2; minsky_cockpit=tok")).toEqual({
      a: "1",
      b: "2",
      minsky_cockpit: "tok",
    });
  });

  test("URL-decodes cookie values", () => {
    expect(parseCookies("minsky_cockpit=a%2Fb%3Dc")).toEqual({ minsky_cockpit: "a/b=c" });
  });
});

describe("serializeCockpitCookie", () => {
  test("includes the cookie name, HttpOnly, SameSite=Strict, and no Secure attribute", () => {
    const value = serializeCockpitCookie("my-token");
    expect(value).toContain(`${COCKPIT_COOKIE_NAME}=my-token`);
    expect(value).toContain("HttpOnly");
    expect(value).toContain("SameSite=Strict");
    expect(value).not.toContain("Secure");
  });

  test("URL-encodes the token value", () => {
    const value = serializeCockpitCookie("has spaces/slashes");
    expect(value).toContain(encodeURIComponent("has spaces/slashes"));
  });
});

// ---------------------------------------------------------------------------
// Host allowlist
// ---------------------------------------------------------------------------

describe("isLoopbackHost", () => {
  test("returns true for the standard loopback aliases", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  test("returns false for a non-loopback host", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
  });
});

describe("buildAllowedHosts", () => {
  test("always includes the standard loopback aliases", () => {
    const hosts = buildAllowedHosts();
    expect(hosts.has("localhost")).toBe(true);
    expect(hosts.has("127.0.0.1")).toBe(true);
    expect(hosts.has("::1")).toBe(true);
  });

  test("adds the explicit --host opt-in value on top", () => {
    const hosts = buildAllowedHosts("192.168.1.5");
    expect(hosts.has("192.168.1.5")).toBe(true);
    expect(hosts.has("127.0.0.1")).toBe(true);
  });
});

describe("extractHostname", () => {
  test("returns null for an undefined header", () => {
    expect(extractHostname(undefined)).toBeNull();
  });

  test("strips a trailing port from an IPv4 host", () => {
    expect(extractHostname("127.0.0.1:3737")).toBe("127.0.0.1");
  });

  test("strips a trailing port from a hostname", () => {
    expect(extractHostname("localhost:3737")).toBe("localhost");
  });

  test("returns the hostname unchanged when there is no port", () => {
    expect(extractHostname("localhost")).toBe("localhost");
  });

  test("handles bracketed IPv6 hosts with a port", () => {
    expect(extractHostname("[::1]:3737")).toBe("::1");
  });

  test("handles bracketed IPv6 hosts without a port", () => {
    expect(extractHostname("[::1]")).toBe("::1");
  });
});

// ---------------------------------------------------------------------------
// Middleware — minimal fake req/res, no real HTTP server
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number | null;
  jsonBody: unknown;
  headers: Record<string, string>;
  redirectedTo: string | null;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  setHeader(name: string, value: string): void;
  redirect(code: number, url: string): void;
}

function makeFakeResponse(): FakeResponse {
  const res: FakeResponse = {
    statusCode: null,
    jsonBody: undefined,
    headers: {},
    redirectedTo: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    redirect(code: number, url: string) {
      res.statusCode = code;
      res.redirectedTo = url;
    },
  };
  return res;
}

describe("hostAllowlistMiddleware", () => {
  test("calls next() for an allowed Host header", () => {
    const middleware = hostAllowlistMiddleware(buildAllowedHosts());
    const req = { headers: { host: "127.0.0.1:3737" } };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  test("rejects a disallowed Host header with 403", () => {
    const middleware = hostAllowlistMiddleware(buildAllowedHosts());
    const req = { headers: { host: "evil.example.com" } };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  test("accepts a mixed-case allowed Host header (mt#2538 R1)", () => {
    // Hostnames are case-insensitive; `LOCALHOST` must not 403.
    const middleware = hostAllowlistMiddleware(buildAllowedHosts());
    const req = { headers: { host: "LOCALHOST:3737" } };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  test("accepts a mixed-case --host opt-in value (mt#2538 R1)", () => {
    const middleware = hostAllowlistMiddleware(buildAllowedHosts("Cockpit.Internal"));
    const req = { headers: { host: "cockpit.internal:3737" } };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});

describe("cookieBootstrapMiddleware", () => {
  const TOKEN = "the-real-token";

  test("mints the cookie on a cookieless GET when bound to loopback", () => {
    const middleware = cookieBootstrapMiddleware(TOKEN, true);
    const req = { method: "GET", headers: {}, query: {} };
    const res = makeFakeResponse();
    middleware(req as any, res as any, () => {});
    expect(String(res.headers["Set-Cookie"] ?? "")).toContain(`${COCKPIT_COOKIE_NAME}=`);
  });

  test("does NOT mint the cookie when bound to a non-loopback host (mt#2538 R1)", () => {
    // The Secure-less cookie must never be handed to a browser talking to a
    // routable address; non-loopback binds require an Authorization header.
    const middleware = cookieBootstrapMiddleware(TOKEN, false);
    const req = { method: "GET", headers: {}, query: {} };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });
});

describe("mutationAuthMiddleware", () => {
  const TOKEN = "the-real-token";

  test("passes GET/HEAD/OPTIONS through without checking auth", () => {
    const middleware = mutationAuthMiddleware(TOKEN);
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const req = { method, headers: {} };
      const res = makeFakeResponse();
      let nextCalled = false;
      middleware(req as any, res as any, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    }
  });

  test("rejects a mutation with no token or cookie with 401", () => {
    const middleware = mutationAuthMiddleware(TOKEN);
    const req = { method: "POST", headers: {} };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test("accepts a mutation with a valid bearer token", () => {
    const middleware = mutationAuthMiddleware(TOKEN);
    const req = { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  test("rejects a mutation with an invalid bearer token", () => {
    const middleware = mutationAuthMiddleware(TOKEN);
    const req = { method: "POST", headers: { authorization: "Bearer wrong-token" } };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test("accepts a mutation with a valid cockpit cookie", () => {
    const middleware = mutationAuthMiddleware(TOKEN);
    const req = { method: "POST", headers: { cookie: `${COCKPIT_COOKIE_NAME}=${TOKEN}` } };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  test("rejects a cross-origin mutation even with a valid token", () => {
    const middleware = mutationAuthMiddleware(TOKEN);
    const req = {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: "http://evil.example.com",
      },
    };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  test("accepts a same-origin mutation Origin header with a valid token", () => {
    const middleware = mutationAuthMiddleware(TOKEN);
    const req = {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: "http://127.0.0.1:3737",
        host: "127.0.0.1:3737",
      },
    };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  test("rejects a same-host, DIFFERENT-port Origin with a valid token (mt#2538 R1)", () => {
    // The daemon is on :3737; a page on :1234 shares the hostname but is a
    // different origin. The prior hostname-only check let this through.
    const middleware = mutationAuthMiddleware(TOKEN);
    const req = {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: "http://127.0.0.1:1234",
        host: "127.0.0.1:3737",
      },
    };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  test("accepts a mixed-case same-origin Origin header (mt#2538 R1)", () => {
    // Hostnames are case-insensitive; a mixed-case Origin must still match.
    const middleware = mutationAuthMiddleware(TOKEN);
    const req = {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: "http://LocalHost:3737",
        host: "localhost:3737",
      },
    };
    const res = makeFakeResponse();
    let nextCalled = false;
    middleware(req as any, res as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});
