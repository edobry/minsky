/**
 * Unit tests for the cockpit passkey gate's decision logic (mt#4023).
 *
 * Everything here runs against a fake store and a controlled clock — no
 * database, no browser, no real WebAuthn ceremony. The parts that genuinely
 * need a browser (the ceremony itself) are covered by the live verification
 * script instead; what is testable in isolation is the part that decides who
 * gets in, which is the part that matters if it is wrong.
 */
import { describe, test, expect } from "bun:test";

import {
  CeremonyStore,
  clearSessionCookie,
  extractSessionToken,
  hashSessionToken,
  isPublicPath,
  isSecureRequest,
  serializeSessionCookie,
  sessionCookieName,
  SESSION_COOKIE_INSECURE,
  SESSION_COOKIE_SECURE,
} from "./passkey-auth";
import type { Request } from "express";

/** Extracted so the header name is stated once (custom/no-magic-string-duplication). */
const FORWARDED_PROTO_HEADER = "x-forwarded-proto";

function fakeRequest(
  headers: Record<string, string | string[]>,
  extra?: Partial<Request>
): Request {
  return { headers, protocol: "http", ...extra } as unknown as Request;
}

describe("isPublicPath — what may be reached without a session", () => {
  test("the health endpoint is public (the deploy healthcheck depends on it)", () => {
    expect(isPublicPath("/api/health")).toBe(true);
  });

  test("the auth routes are public — otherwise signing in would require being signed in", () => {
    expect(isPublicPath("/api/auth/status")).toBe(true);
    expect(isPublicPath("/api/auth/passkey/login/start")).toBe(true);
  });

  test("data routes are gated", () => {
    expect(isPublicPath("/api/tasks")).toBe(false);
    expect(isPublicPath("/api/asks")).toBe(false);
    expect(isPublicPath("/api/cockpit/session-film/sessions")).toBe(false);
  });

  test("an unknown API route is gated by DEFAULT, not by enumeration", () => {
    // The property that matters: a route added tomorrow is closed on arrival,
    // with no action required from whoever adds it.
    expect(isPublicPath("/api/some-route-that-does-not-exist-yet")).toBe(false);
  });

  test("the SPA shell and its assets are public — they carry no data", () => {
    expect(isPublicPath("/")).toBe(true);
    expect(isPublicPath("/conversation/abc")).toBe(true);
    expect(isPublicPath("/assets/index-abc123.js")).toBe(true);
  });
});

describe("session cookie", () => {
  test("uses the __Host- prefixed name over TLS and the plain name otherwise", () => {
    expect(sessionCookieName(true)).toBe(SESSION_COOKIE_SECURE);
    expect(sessionCookieName(false)).toBe(SESSION_COOKIE_INSECURE);
  });

  test("the secure cookie carries Secure, HttpOnly, SameSite and Path=/", () => {
    const cookie = serializeSessionCookie("tok", true);
    expect(cookie).toContain(`${SESSION_COOKIE_SECURE}=tok`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  test("omits Secure on a plain-HTTP context, which could not store a __Host- cookie", () => {
    const cookie = serializeSessionCookie("tok", false);
    expect(cookie).toContain(`${SESSION_COOKIE_INSECURE}=tok`);
    expect(cookie).not.toContain("Secure");
  });

  test("clearing expires the cookie immediately", () => {
    expect(clearSessionCookie(true)).toContain("Max-Age=0");
  });

  test("reads the token under either cookie name", () => {
    expect(extractSessionToken(fakeRequest({ cookie: `${SESSION_COOKIE_SECURE}=abc` }))).toBe(
      "abc"
    );
    expect(extractSessionToken(fakeRequest({ cookie: `${SESSION_COOKIE_INSECURE}=def` }))).toBe(
      "def"
    );
    expect(extractSessionToken(fakeRequest({}))).toBeNull();
  });

  test("stores only a hash of the token", () => {
    const hash = hashSessionToken("secret-token");
    expect(hash).not.toContain("secret-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic, so a lookup by hash actually finds the row.
    expect(hashSessionToken("secret-token")).toBe(hash);
  });
});

describe("isSecureRequest", () => {
  test("trusts x-forwarded-proto — Railway terminates TLS at its proxy", () => {
    // Without this the production deployment would permanently pick the
    // insecure cookie, on the one instance this gate exists to protect.
    expect(isSecureRequest(fakeRequest({ [FORWARDED_PROTO_HEADER]: "https" }))).toBe(true);
  });

  test("reads only the first hop of a comma-joined forwarded chain", () => {
    expect(isSecureRequest(fakeRequest({ [FORWARDED_PROTO_HEADER]: "https,http" }))).toBe(true);
    expect(isSecureRequest(fakeRequest({ [FORWARDED_PROTO_HEADER]: "http,https" }))).toBe(false);
  });

  test("is false for a plain-HTTP request with no forwarding header", () => {
    expect(isSecureRequest(fakeRequest({}))).toBe(false);
  });
});

describe("CeremonyStore", () => {
  test("a challenge round-trips under its ceremony id", () => {
    const store = new CeremonyStore();
    const id = store.create("registration", "challenge-1");
    expect(store.consume(id, "registration")).toBe("challenge-1");
  });

  test("a ceremony is single-use — a replayed finish call finds nothing", () => {
    const store = new CeremonyStore();
    const id = store.create("authentication", "challenge-2");
    expect(store.consume(id, "authentication")).toBe("challenge-2");
    expect(store.consume(id, "authentication")).toBeNull();
  });

  test("a registration ceremony cannot be consumed as an authentication one", () => {
    const store = new CeremonyStore();
    const id = store.create("registration", "challenge-3");
    expect(store.consume(id, "authentication")).toBeNull();
  });

  test("an expired ceremony is not consumable", () => {
    let now = 1_000_000;
    const store = new CeremonyStore(() => now);
    const id = store.create("authentication", "challenge-4");
    now += 6 * 60 * 1000; // past the 5-minute TTL
    expect(store.consume(id, "authentication")).toBeNull();
  });

  test("concurrent ceremonies do not clobber one another", () => {
    // Two browser tabs mid-ceremony is ordinary, and a single shared slot
    // would make whichever finished second fail.
    const store = new CeremonyStore();
    const first = store.create("authentication", "challenge-a");
    const second = store.create("authentication", "challenge-b");
    expect(first).not.toBe(second);
    expect(store.consume(second, "authentication")).toBe("challenge-b");
    expect(store.consume(first, "authentication")).toBe("challenge-a");
  });

  test("an unknown ceremony id yields nothing", () => {
    expect(new CeremonyStore().consume("never-issued", "registration")).toBeNull();
  });
});
