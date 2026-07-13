/**
 * Cockpit daemon auth (mt#2538).
 *
 * Bearer-token generation/storage, mutation-auth middleware, cookie
 * bootstrap, and the Host-header allowlist (DNS-rebinding defense).
 *
 * Threat model / design notes (mirrors the mt#2538 spec's Plan decision):
 *  - Loopback bind alone is NOT a sufficient auth posture: (a) any local
 *    process of any user on the machine can reach loopback, (b) DNS
 *    rebinding can drive a victim browser at localhost, and (c) the Rung 2A
 *    driven-session WS channel (mt#2750) needs a token model regardless.
 *  - Mutation (non-GET/HEAD/OPTIONS) and future WS endpoints MUST enforce
 *    the token. Read-only GET/SSE surfaces are exempt: the loopback bind
 *    already restricts them to the local machine, and plumbing the token to
 *    every GET consumer (tray Rust health poll, dev canary, curl operators)
 *    is disproportionate at this tier.
 */
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import type { NextFunction, Request, Response } from "express";
import { getStateDir } from "./lifecycle";

export const COCKPIT_COOKIE_NAME = "minsky_cockpit";

// ---------------------------------------------------------------------------
// Token generation / storage
// ---------------------------------------------------------------------------

/** Path to the persisted bearer token — `~/.local/state/minsky/cockpit-token`. */
export function getCockpitTokenPath(): string {
  return path.join(getStateDir(), "cockpit-token");
}

/**
 * Read the persisted token, generating and persisting a fresh one (mode
 * 0600) on first boot. Reused across restarts so consumers plumbed with a
 * token at one boot (tray supervisor, CLI) keep working across the next.
 */
export function getOrCreateCockpitToken(tokenPath: string = getCockpitTokenPath()): string {
  try {
    const contents = fs.readFileSync(tokenPath, { encoding: "utf-8" });
    const existing = String(contents).trim();
    if (existing.length > 0) return existing;
  } catch {
    // Missing file, unreadable, or empty — fall through and (re)generate.
  }
  // Byte-by-byte hex encoding (rather than `Buffer#toString("hex")`) sidesteps
  // an ambient-typing ambiguity between this project's root @types/node and
  // bun-types' bundled copy over the Buffer class's `toString` overload set.
  const token = Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, "0")).join("");
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  try {
    // Belt-and-suspenders: writeFileSync's `mode` option already covers most
    // platforms, but an existing file (recreated after deletion, or created
    // by an older Minsky version) may have inherited a wider mode from the
    // process umask. Force it closed.
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // Best-effort.
  }
  return token;
}

// ---------------------------------------------------------------------------
// Cookie parsing / serialization
//
// No `cookie-parser` dependency — the cockpit sets exactly one cookie, so a
// tiny hand-rolled parser avoids pulling in a new package for one field.
// ---------------------------------------------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key.length > 0) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * Serialize the `minsky_cockpit` Set-Cookie value.
 *
 * - `HttpOnly` — JS can't read it (mitigates XSS token exfiltration).
 * - `SameSite=Strict` — never sent cross-site; defends against CSRF-style
 *   cross-origin mutation attempts riding the cookie.
 * - No `Secure` attribute — the daemon serves plain HTTP on loopback;
 *   requiring `Secure` would make the browser refuse to store the cookie
 *   at all over http.
 */
export function serializeCockpitCookie(token: string): string {
  return (
    `${COCKPIT_COOKIE_NAME}=${encodeURIComponent(token)}; ` + `HttpOnly; SameSite=Strict; Path=/`
  );
}

// ---------------------------------------------------------------------------
// Host-header allowlist (DNS-rebinding defense)
// ---------------------------------------------------------------------------

const DEFAULT_LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** True when `host` is one of the standard loopback aliases. */
export function isLoopbackHost(host: string): boolean {
  return (DEFAULT_LOOPBACK_HOSTS as string[]).includes(host);
}

/**
 * The set of Host-header values the daemon accepts. Always includes the
 * standard loopback aliases; `explicitHost` (the `--host` opt-in value, if
 * not itself already a loopback alias) is added on top.
 */
export function buildAllowedHosts(explicitHost?: string): Set<string> {
  const hosts = new Set<string>(DEFAULT_LOOPBACK_HOSTS);
  if (explicitHost) hosts.add(explicitHost);
  return hosts;
}

/**
 * Extract the hostname portion of a `Host` header value, stripping a
 * trailing `:<port>` (and handling the bracketed IPv6 form, `[::1]:3737`).
 */
export function extractHostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const ipv6Match = hostHeader.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (ipv6Match?.[1]) return ipv6Match[1];
  const idx = hostHeader.lastIndexOf(":");
  return idx === -1 ? hostHeader : hostHeader.slice(0, idx);
}

/**
 * Rejects any request whose Host header does not resolve to a name in
 * `allowedHosts`. This is the DNS-rebinding defense: an attacker-controlled
 * DNS name that resolves to 127.0.0.1 still carries its own Host header
 * value, which will not be in the allowlist.
 */
export function hostAllowlistMiddleware(allowedHosts: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hostname = extractHostname(req.headers.host);
    if (!hostname || !allowedHosts.has(hostname)) {
      res.status(403).json({
        error: `Host header '${req.headers.host ?? ""}' is not in the cockpit daemon's allowlist`,
      });
      return;
    }
    next();
  };
}

/** True when `origin`'s hostname is in `allowedHosts`. */
function originMatchesAllowedHosts(origin: string, allowedHosts: Set<string>): boolean {
  try {
    const url = new URL(origin);
    return allowedHosts.has(url.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cookie bootstrap
// ---------------------------------------------------------------------------

/**
 * On any GET/HEAD:
 *  - If a `?token=<t>` query param is present and matches the real token,
 *    set the cookie and redirect to the same path with the param stripped.
 *    This is the explicit bootstrap path for a future non-loopback opt-in
 *    consumer; the loopback SPA doesn't need it (see the plain-GET branch
 *    below).
 *  - Otherwise, if the `minsky_cockpit` cookie is absent, mint it. This is
 *    what lets the SPA's same-origin mutation fetches work with zero
 *    URL/localStorage token plumbing: the very first page load sets the
 *    cookie, and every subsequent same-origin `fetch()` from the browser
 *    automatically carries it.
 */
export function cookieBootstrapMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    const queryToken = req.query["token"];
    if (typeof queryToken === "string") {
      if (queryToken === token) {
        res.setHeader("Set-Cookie", serializeCockpitCookie(token));
        const strippedUrl = new URL(req.originalUrl, "http://internal.invalid");
        strippedUrl.searchParams.delete("token");
        res.redirect(302, strippedUrl.pathname + strippedUrl.search);
        return;
      }
      // Invalid bootstrap token: fall through without setting a cookie.
      // Read-only GETs still work either way; a subsequent mutation attempt
      // without a valid cookie/bearer token will 401.
      next();
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    if (!cookies[COCKPIT_COOKIE_NAME]) {
      res.setHeader("Set-Cookie", serializeCockpitCookie(token));
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Mutation-auth middleware
// ---------------------------------------------------------------------------

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Require a valid bearer token (`Authorization: Bearer <token>`) or a valid
 * `minsky_cockpit` cookie on every non-GET/HEAD/OPTIONS request.
 *
 * Also enforces the "no permissive CORS" policy defensively: a mutation
 * carrying a cross-origin `Origin` header is rejected outright, even if it
 * somehow carried a valid token/cookie. Browsers already won't send the
 * `SameSite=Strict` cookie cross-site, and there is no
 * `Access-Control-Allow-Origin` response header anywhere in this server for
 * a cross-origin `fetch()` to succeed against in the first place — this
 * check is defense in depth for non-browser HTTP clients that set `Origin`
 * manually.
 */
export function mutationAuthMiddleware(token: string, allowedHosts: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (origin && !originMatchesAllowedHosts(origin, allowedHosts)) {
      res.status(403).json({ error: "Cross-origin mutation rejected" });
      return;
    }

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ") && authHeader.slice(7) === token) {
      next();
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    if (cookies[COCKPIT_COOKIE_NAME] === token) {
      next();
      return;
    }

    res.status(401).json({ error: "Missing or invalid cockpit auth token" });
  };
}
