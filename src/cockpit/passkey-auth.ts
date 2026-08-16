/**
 * Cockpit passkey authentication (mt#4023).
 *
 * WebAuthn gate for the publicly-reachable `cockpit-preview` deployment, which
 * until this shipped served the live corpus to anyone holding the URL —
 * `isPublicDeployment: true` skipped both the Host allowlist and the
 * mutation-auth requirement (see ./server.ts). This module supplies the
 * credential the deployment had none of.
 *
 * Scope discipline: this is the DEPLOYED-instance gate. The local daemon keeps
 * the mt#2538 posture (loopback bind + bearer token, ./auth.ts) untouched — a
 * passkey ceremony needs a stable relying-party id, which a loopback daemon on
 * an arbitrary port does not usefully have.
 *
 * Design notes:
 *  - The relying-party id MUST be the full deployment hostname. `up.railway.app`
 *    is on the Public Suffix List, so no shorter registrable suffix exists to
 *    scope a credential to. A custom domain later means re-enrolling.
 *  - Ceremony challenges live in a short-TTL in-memory map rather than a table:
 *    single-use, seconds-lived, one replica, and losing them on restart costs a
 *    retry. The client carries an opaque `ceremonyId` between start and finish,
 *    so concurrent tabs cannot clobber one another.
 *  - Sessions are stored, not signed-stateless, so revocation is real and needs
 *    no secret to rotate.
 *  - The store is injected. Every decision in here is exercised against a fake
 *    in the tests; nothing reaches for a database on its own.
 */
import { createHash, randomBytes } from "crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { log } from "@minsky/shared/logger";
import { respondIfDatabaseUnavailable } from "./db-unavailable-response";

/**
 * Hex-encode bytes without `Buffer#toString(encoding)`.
 *
 * Same workaround ./auth.ts documents: this project's root `@types/node` and
 * bun-types' bundled copy disagree about Buffer's `toString` overload set, so
 * the encoding argument fails to typecheck. Base64url conversions go through
 * SimpleWebAuthn's own `isoBase64URL` helpers for the same reason.
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

export interface StoredPasskey {
  id: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[] | null;
}

export interface PasskeyStore {
  listPasskeys(): Promise<StoredPasskey[]>;
  findPasskeyByCredentialId(credentialId: string): Promise<StoredPasskey | null>;
  insertPasskey(input: {
    credentialId: string;
    publicKey: string;
    counter: number;
    transports?: string[];
    label?: string;
  }): Promise<string>;
  updatePasskeyCounter(credentialId: string, counter: number): Promise<void>;
  createSession(input: {
    tokenHash: string;
    passkeyId: string | null;
    expiresAt: Date;
  }): Promise<void>;
  findValidSession(tokenHash: string, now: Date): Promise<{ id: string } | null>;
  deleteSession(tokenHash: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Session lifetime. Long enough not to be a nuisance for a single operator. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A ceremony challenge is valid for this long. WebAuthn ceremonies take seconds. */
export const CEREMONY_TTL_MS = 5 * 60 * 1000;

/**
 * Cookie name. The `__Host-` prefix is not decoration: it forces Secure, Path=/
 * and no Domain, which pins the cookie to this exact host. Sibling tenants on
 * the shared Railway suffix therefore cannot set a cookie that shadows it.
 * Plain-HTTP contexts (local runs, tests) cannot store a `__Host-` cookie at
 * all, so they fall back to the unprefixed name.
 */
export const SESSION_COOKIE_SECURE = "__Host-minsky_cockpit_session";
export const SESSION_COOKIE_INSECURE = "minsky_cockpit_session";

export function sessionCookieName(isSecure: boolean): string {
  return isSecure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_INSECURE;
}

/**
 * True when the request reached us over TLS. Railway terminates TLS at its
 * proxy and forwards `x-forwarded-proto`, so the socket itself is plain HTTP
 * even in production — checking `req.secure` alone would permanently choose the
 * insecure cookie on the one deployment this module exists to protect.
 */
export function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof proto === "string" && proto.split(",")[0]?.trim() === "https") return true;
  return req.protocol === "https";
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function serializeSessionCookie(token: string, isSecure: boolean): string {
  const parts = [
    `${sessionCookieName(isSecure)}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(isSecure: boolean): string {
  const parts = [
    `${sessionCookieName(isSecure)}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** Read the session token under whichever cookie name this context uses. */
export function extractSessionToken(req: Request): string | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[SESSION_COOKIE_SECURE] ?? cookies[SESSION_COOKIE_INSECURE] ?? null;
}

/**
 * Paths reachable without a session.
 *
 * Deliberately a closed list rather than a prefix-deny: a new API route is
 * gated the moment it is added, with no action required by whoever adds it.
 * `/api/health` stays open because the Railway healthcheck and the post-deploy
 * monitor both poll it unauthenticated.
 *
 * The SPA shell and its assets are open too — they carry no data, and the
 * client needs to boot far enough to render a login screen. Every route that
 * serves DATA is gated.
 */
export function isPublicPath(path: string): boolean {
  if (path === "/api/health") return true;
  if (path.startsWith("/api/auth/")) return true;
  // Published conversation shares (mt#4024). The ONLY data route that is
  // deliberately public, and it is not a hole in the gate: it serves exactly
  // one conversation, only when the operator explicitly published it, only
  // while the share is live, and only if that transcript passes the scrub
  // gate. Note how narrow the prefix is — `/api/shares` (mint, list, revoke)
  // stays GATED; only the `/public/` sub-path is open.
  if (path.startsWith("/api/shares/public/")) return true;
  if (!path.startsWith("/api/")) return true; // SPA shell + static assets
  return false;
}

// ---------------------------------------------------------------------------
// Ceremony challenge store (in-memory, TTL)
// ---------------------------------------------------------------------------

type CeremonyKind = "registration" | "authentication";

interface Ceremony {
  kind: CeremonyKind;
  challenge: string;
  expiresAt: number;
}

export class CeremonyStore {
  private readonly ceremonies = new Map<string, Ceremony>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(kind: CeremonyKind, challenge: string): string {
    this.prune();
    const id = toHex(randomBytes(16));
    this.ceremonies.set(id, { kind, challenge, expiresAt: this.now() + CEREMONY_TTL_MS });
    return id;
  }

  /** Single-use: a consumed ceremony is removed, so a replayed finish call fails. */
  consume(id: string, kind: CeremonyKind): string | null {
    this.prune();
    const found = this.ceremonies.get(id);
    if (!found || found.kind !== kind) return null;
    this.ceremonies.delete(id);
    return found.challenge;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, ceremony] of this.ceremonies) {
      if (ceremony.expiresAt <= now) this.ceremonies.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Router + middleware
// ---------------------------------------------------------------------------

export interface PasskeyAuthDeps {
  store: PasskeyStore;
  /** Relying-party id — the deployment's full hostname. */
  rpID: string;
  /** Expected origin, `https://<rpID>`. */
  origin: string;
  rpName?: string;
  ceremonies?: CeremonyStore;
  now?: () => Date;
  randomToken?: () => string;
}

interface ResolvedDeps extends PasskeyAuthDeps {
  ceremonies: CeremonyStore;
  now: () => Date;
  randomToken: () => string;
}

function resolve(deps: PasskeyAuthDeps): ResolvedDeps {
  return {
    ...deps,
    rpName: deps.rpName ?? "Minsky Cockpit",
    ceremonies: deps.ceremonies ?? new CeremonyStore(),
    now: deps.now ?? (() => new Date()),
    randomToken: deps.randomToken ?? (() => toHex(randomBytes(32))),
  };
}

/** Issue a session and return the Set-Cookie value. */
async function issueSession(
  deps: ResolvedDeps,
  passkeyId: string | null,
  isSecure: boolean
): Promise<string> {
  const token = deps.randomToken();
  await deps.store.createSession({
    tokenHash: hashSessionToken(token),
    passkeyId,
    expiresAt: new Date(deps.now().getTime() + SESSION_TTL_MS),
  });
  return serializeSessionCookie(token, isSecure);
}

async function hasValidSession(deps: ResolvedDeps, req: Request): Promise<boolean> {
  const token = extractSessionToken(req);
  if (!token) return false;
  const session = await deps.store.findValidSession(hashSessionToken(token), deps.now());
  return session !== null;
}

/**
 * Deny every non-public request without a valid session.
 *
 * Returns 401 as JSON for API paths. The SPA shell is public (see
 * `isPublicPath`), so an unauthenticated browser still loads the app, which
 * asks `/api/auth/status` and renders the login screen.
 */
export function requirePasskeySession(deps: PasskeyAuthDeps) {
  const resolved = resolve(deps);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isPublicPath(req.path)) {
      next();
      return;
    }
    void hasValidSession(resolved, req)
      .then((ok) => {
        if (ok) {
          next();
          return;
        }
        res.status(401).json({ error: "Authentication required" });
      })
      .catch((err: unknown) => {
        // Fail CLOSED. An auth check that cannot run is not a pass — the whole
        // point of this module is that this deployment defaults to denial.

        log.error("[cockpit-auth] session check failed:", { originalError: err });
        res.status(503).json({ error: "Authentication unavailable" });
      });
  };
}

export function createPasskeyAuthRouter(deps: PasskeyAuthDeps): Router {
  const resolved = resolve(deps);
  const router = Router();

  /**
   * Whether enrollment is open to an unauthenticated caller: true only while no
   * passkey exists at all. Once the principal has enrolled, adding another
   * authenticator requires an existing session — so the bootstrap window closes
   * permanently on first use rather than staying open for whoever arrives next.
   */
  const enrollmentOpen = async (): Promise<boolean> =>
    (await resolved.store.listPasskeys()).length === 0;

  router.get("/api/auth/status", (req, res) => {
    void (async () => {
      try {
        res.json({
          // `gated: true` says an auth gate is present here. The client cannot
          // infer that from a 404, because the SPA catch-all answers unmatched
          // GETs with index.html — an unmounted route looks like a successful
          // HTML response, not a missing one.
          gated: true,
          authenticated: await hasValidSession(resolved, req),
          enrollmentOpen: await enrollmentOpen(),
        });
      } catch {
        res.status(503).json({ error: "Authentication unavailable" });
      }
    })();
  });

  router.post("/api/auth/passkey/register/start", (req, res) => {
    void (async () => {
      try {
        if (!(await enrollmentOpen()) && !(await hasValidSession(resolved, req))) {
          res.status(403).json({ error: "Enrollment is closed; sign in with an existing passkey" });
          return;
        }
        const existing = await resolved.store.listPasskeys();
        const options = await generateRegistrationOptions({
          rpName: resolved.rpName ?? "Minsky Cockpit",
          rpID: resolved.rpID,
          userName: "principal",
          attestationType: "none",
          // Exclude already-registered authenticators so the browser says
          // "already registered" instead of silently minting a duplicate.
          excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "preferred",
          },
        });
        const ceremonyId = resolved.ceremonies.create("registration", options.challenge);
        res.json({ ceremonyId, options });
      } catch (err: unknown) {
        if (await respondIfDatabaseUnavailable(res, err, "cockpit-auth")) return;
        log.error("[cockpit-auth] register/start failed:", { originalError: err });
        res.status(500).json({ error: "Could not start enrollment" });
      }
    })();
  });

  router.post("/api/auth/passkey/register/finish", (req, res) => {
    void (async () => {
      try {
        const { ceremonyId, response, label } = req.body ?? {};
        if (typeof ceremonyId !== "string" || !response) {
          res.status(400).json({ error: "Missing ceremonyId or response" });
          return;
        }
        if (!(await enrollmentOpen()) && !(await hasValidSession(resolved, req))) {
          res.status(403).json({ error: "Enrollment is closed; sign in with an existing passkey" });
          return;
        }
        const expectedChallenge = resolved.ceremonies.consume(ceremonyId, "registration");
        if (!expectedChallenge) {
          res.status(400).json({ error: "Unknown or expired ceremony" });
          return;
        }
        const verification = await verifyRegistrationResponse({
          response,
          expectedChallenge,
          expectedOrigin: resolved.origin,
          expectedRPID: resolved.rpID,
        });
        if (!verification.verified || !verification.registrationInfo) {
          res.status(400).json({ error: "Passkey registration could not be verified" });
          return;
        }
        const { credential } = verification.registrationInfo;
        const passkeyId = await resolved.store.insertPasskey({
          credentialId: credential.id,
          publicKey: isoBase64URL.fromBuffer(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports as string[] | undefined,
          label: typeof label === "string" && label.trim() ? label.trim() : undefined,
        });
        // Enrolling signs you in — otherwise the first-run operator would
        // register a passkey and immediately be asked to use it.
        res.setHeader("Set-Cookie", await issueSession(resolved, passkeyId, isSecureRequest(req)));
        res.json({ verified: true });
      } catch (err: unknown) {
        if (await respondIfDatabaseUnavailable(res, err, "cockpit-auth")) return;
        log.error("[cockpit-auth] register/finish failed:", { originalError: err });
        res.status(500).json({ error: "Could not complete enrollment" });
      }
    })();
  });

  router.post("/api/auth/passkey/login/start", (_req, res) => {
    void (async () => {
      try {
        // No `allowCredentials`: discoverable credentials let the browser offer
        // the right passkey without the server first being told who is logging
        // in — there is exactly one principal, so a username step buys nothing.
        const options = await generateAuthenticationOptions({
          rpID: resolved.rpID,
          userVerification: "preferred",
        });
        const ceremonyId = resolved.ceremonies.create("authentication", options.challenge);
        res.json({ ceremonyId, options });
      } catch (err: unknown) {
        if (await respondIfDatabaseUnavailable(res, err, "cockpit-auth")) return;
        log.error("[cockpit-auth] login/start failed:", { originalError: err });
        res.status(500).json({ error: "Could not start sign-in" });
      }
    })();
  });

  router.post("/api/auth/passkey/login/finish", (req, res) => {
    void (async () => {
      try {
        const { ceremonyId, response } = req.body ?? {};
        if (typeof ceremonyId !== "string" || !response?.id) {
          res.status(400).json({ error: "Missing ceremonyId or response" });
          return;
        }
        const expectedChallenge = resolved.ceremonies.consume(ceremonyId, "authentication");
        if (!expectedChallenge) {
          res.status(400).json({ error: "Unknown or expired ceremony" });
          return;
        }
        const passkey = await resolved.store.findPasskeyByCredentialId(response.id);
        if (!passkey) {
          res.status(401).json({ error: "Unrecognized passkey" });
          return;
        }
        const verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: resolved.origin,
          expectedRPID: resolved.rpID,
          credential: {
            id: passkey.credentialId,
            publicKey: isoBase64URL.toBuffer(passkey.publicKey),
            counter: passkey.counter,
            transports: (passkey.transports ?? undefined) as never,
          },
        });
        if (!verification.verified) {
          res.status(401).json({ error: "Passkey verification failed" });
          return;
        }
        await resolved.store.updatePasskeyCounter(
          passkey.credentialId,
          verification.authenticationInfo.newCounter
        );
        res.setHeader("Set-Cookie", await issueSession(resolved, passkey.id, isSecureRequest(req)));
        res.json({ verified: true });
      } catch (err: unknown) {
        if (await respondIfDatabaseUnavailable(res, err, "cockpit-auth")) return;
        log.error("[cockpit-auth] login/finish failed:", { originalError: err });
        res.status(500).json({ error: "Could not complete sign-in" });
      }
    })();
  });

  router.post("/api/auth/logout", (req, res) => {
    void (async () => {
      const token = extractSessionToken(req);
      if (token) {
        try {
          await resolved.store.deleteSession(hashSessionToken(token));
        } catch (err: unknown) {
          log.error("[cockpit-auth] logout failed to delete session:", { originalError: err });
        }
      }
      res.setHeader("Set-Cookie", clearSessionCookie(isSecureRequest(req)));
      res.json({ ok: true });
    })();
  });

  return router;
}
