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

/** The canonical token shape: exactly 64 lowercase hex chars (32 bytes). */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Read the persisted token, generating and persisting a fresh one (mode
 * 0600) on first boot. Reused across restarts so consumers plumbed with a
 * token at one boot (tray supervisor, CLI) keep working across the next.
 *
 * A persisted token is only trusted when it matches the canonical 64-hex-char
 * shape — a corrupt or externally-mangled file (log concatenation, a stray
 * editor save) is discarded and regenerated rather than propagated into every
 * request header/cookie.
 */
export function getOrCreateCockpitToken(tokenPath: string = getCockpitTokenPath()): string {
  try {
    const contents = fs.readFileSync(tokenPath, { encoding: "utf-8" });
    const existing = String(contents).trim();
    if (TOKEN_PATTERN.test(existing)) return existing;
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
 *
 * This cookie is ONLY ever minted on a loopback bind (see
 * `cookieBootstrapMiddleware` — the non-loopback `--host` opt-in disables
 * cookie bootstrap entirely and requires an explicit `Authorization` header
 * instead). That gate is what makes omitting `Secure` safe: a plain-HTTP
 * cookie is never handed to a browser talking to a routable, network-reachable
 * address where it could leak cross-origin over the wire (mt#2538 R1).
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

/**
 * Normalize a hostname for comparison. Hostnames are case-insensitive per
 * RFC 3986 / HTTP, so every allowlist entry and every extracted request
 * hostname is lowercased before it is stored or looked up — otherwise
 * `Host: LOCALHOST` or `--host Cockpit.Internal` would 403 spuriously
 * (mt#2538 R1).
 */
function normalizeHost(host: string): string {
  return host.toLowerCase();
}

/** True when `host` is one of the standard loopback aliases (case-insensitive). */
export function isLoopbackHost(host: string): boolean {
  return (DEFAULT_LOOPBACK_HOSTS as string[]).includes(normalizeHost(host));
}

/**
 * The set of Host-header values the daemon accepts (all lowercased). Always
 * includes the standard loopback aliases; `explicitHost` (the `--host` opt-in
 * value, if not itself already a loopback alias) is added on top.
 */
export function buildAllowedHosts(explicitHost?: string): Set<string> {
  const hosts = new Set<string>(DEFAULT_LOOPBACK_HOSTS);
  if (explicitHost) hosts.add(normalizeHost(explicitHost));
  return hosts;
}

/**
 * Extract the (lowercased) hostname portion of a `Host` header value,
 * stripping a trailing `:<port>` (and handling the bracketed IPv6 form,
 * `[::1]:3737`).
 */
export function extractHostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const ipv6Match = hostHeader.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (ipv6Match?.[1]) return normalizeHost(ipv6Match[1]);
  const idx = hostHeader.lastIndexOf(":");
  return normalizeHost(idx === -1 ? hostHeader : hostHeader.slice(0, idx));
}

/**
 * True when `hostHeader` resolves to a hostname in `allowedHosts`. Shared by
 * `hostAllowlistMiddleware` (Express requests) below and the Rung 2A
 * driven-session WS upgrade handler (mt#2750,
 * ./driven-session-ws.ts#attachDrivenSessionWebSocket) — WS upgrades bypass
 * Express's middleware pipeline entirely (they're plain HTTP GETs with
 * `Connection: Upgrade`, handled by a listener on the raw `http.Server`, not
 * by any mounted middleware), so that handler calls this predicate directly
 * rather than being able to reuse the middleware wrapper itself.
 */
export function isHostAllowed(hostHeader: string | undefined, allowedHosts: Set<string>): boolean {
  const hostname = extractHostname(hostHeader);
  return hostname !== null && allowedHosts.has(hostname);
}

/**
 * Rejects any request whose Host header does not resolve to a name in
 * `allowedHosts`. This is the DNS-rebinding defense: an attacker-controlled
 * DNS name that resolves to 127.0.0.1 still carries its own Host header
 * value, which will not be in the allowlist.
 */
export function hostAllowlistMiddleware(allowedHosts: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isHostAllowed(req.headers.host, allowedHosts)) {
      res.status(403).json({
        error: `Host header '${req.headers.host ?? ""}' is not in the cockpit daemon's allowlist`,
      });
      return;
    }
    next();
  };
}

/**
 * True when `origin` is the SAME origin as the request itself — exact match on
 * scheme + host + port, not hostname alone.
 *
 * Comparing only the hostname (the prior implementation) let a page served
 * from a DIFFERENT port on the same host — `http://127.0.0.1:1234` hitting the
 * cockpit on `:3737` — pass the check, and since the two are same-*site* the
 * browser would attach the `SameSite=Strict` cookie, enabling authenticated
 * cross-origin mutations from any other local service (mt#2538 R1). The fix is
 * an exact-origin comparison: the request's Origin authority must equal the
 * request's own Host authority (host + port), and the scheme must be the
 * plain-HTTP the daemon actually serves.
 *
 * The daemon's own origin is derived from `req.headers.host` (what the browser
 * addressed) rather than a static value, so it is correct regardless of which
 * port the daemon bound. `req.headers.host` was already validated against the
 * Host allowlist by `hostAllowlistMiddleware`, so it is trustworthy here.
 */
function isSameOrigin(origin: string, requestHost: string | undefined): boolean {
  if (!requestHost) return false;
  try {
    const originUrl = new URL(origin);
    // Loopback daemon serves plain HTTP; a cross-scheme Origin (e.g. https)
    // is not same-origin.
    if (originUrl.protocol !== "http:") return false;
    // `URL#host` includes the port; lowercase the whole authority so a
    // mixed-case hostname still matches (hostnames are case-insensitive).
    return originUrl.host.toLowerCase() === requestHost.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * True when the request's `Origin` (if present) is same-origin with the
 * request's own `Host` — i.e. the request is NOT a disallowed cross-origin one.
 * A request with no `Origin` header (a non-browser client, or a request that
 * omits it) is allowed; a request whose `Origin` authority does not exactly
 * match the `Host` authority is rejected.
 *
 * Shared by `mutationAuthMiddleware` (Express HTTP mutations) and the Rung 2A
 * driven-session WS upgrade handler (mt#2750, ./driven-session-ws.ts) so BOTH
 * surfaces enforce the identical cross-origin defense. This is load-bearing for
 * the WS path: a browser's `WebSocket` cannot set an `Authorization` header, so
 * the SPA authenticates the upgrade with the `SameSite=Strict` cookie — and
 * that cookie IS sent to a same-site DIFFERENT-port origin, so without this
 * check a malicious `http://127.0.0.1:<other>` page could open an authenticated
 * command-execution channel (a CSRF on the driven-session host). Browsers do
 * send `Origin` on WS upgrades, so the check is enforceable there (mt#2750 R1).
 */
export function isRequestOriginAllowed(req: {
  headers: { origin?: string; host?: string };
}): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return isSameOrigin(origin, req.headers.host);
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
 *
 * Cookie bootstrap is LOOPBACK-ONLY. When the daemon is bound to a non-loopback
 * address via the `--host` opt-in (`isLoopbackBind === false`), this middleware
 * is a no-op: the plain-HTTP `minsky_cockpit` cookie (no `Secure`) must never
 * be handed to a browser talking to a routable address, where it could be sent
 * cross-origin over the wire. Non-loopback consumers authenticate with an
 * explicit `Authorization: Bearer <token>` header instead (mt#2538 R1).
 */
export function cookieBootstrapMiddleware(token: string, isLoopbackBind: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isLoopbackBind) {
      next();
      return;
    }
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
 * Extract the bearer token or `minsky_cockpit` cookie value from a
 * request-like object's headers — works for both an Express `Request` and
 * the raw `http.IncomingMessage` a WS upgrade handler sees (both expose
 * `.headers.authorization` / `.headers.cookie`). Returns `null` when neither
 * is present. Does NOT compare against an expected token — see
 * `isValidCockpitAuth` for the comparison.
 */
export function extractCockpitAuthToken(headers: {
  authorization?: string;
  cookie?: string;
}): string | null {
  const authHeader = headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  const cookies = parseCookies(headers.cookie);
  return cookies[COCKPIT_COOKIE_NAME] ?? null;
}

/**
 * True when `req` carries a valid bearer token or `minsky_cockpit` cookie
 * matching `token`. Shared by `mutationAuthMiddleware` (Express requests)
 * below and the Rung 2A driven-session WS upgrade handler (mt#2750,
 * ./driven-session-ws.ts#attachDrivenSessionWebSocket) — like
 * `isHostAllowed` above, this predicate is called directly by the WS
 * handler rather than mounted as middleware, since WS upgrades never reach
 * Express's middleware pipeline.
 */
export function isValidCockpitAuth(
  req: { headers: { authorization?: string; cookie?: string } },
  token: string
): boolean {
  const provided = extractCockpitAuthToken(req.headers);
  return provided !== null && provided === token;
}

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
export function mutationAuthMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    if (!isRequestOriginAllowed(req)) {
      res.status(403).json({ error: "Cross-origin mutation rejected" });
      return;
    }

    if (isValidCockpitAuth(req, token)) {
      next();
      return;
    }

    res.status(401).json({ error: "Missing or invalid cockpit auth token" });
  };
}
