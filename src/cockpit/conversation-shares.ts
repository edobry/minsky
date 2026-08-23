/**
 * Publish a conversation as a revocable read-only share link (mt#4024).
 *
 * The point of the feature is handing one conversation to one person — "take a
 * look at this" — without giving them the cockpit or an account.
 *
 * Three things carry the safety of that, in order of how much they actually do:
 *
 *  1. **The operator publishes explicitly, one conversation at a time.** Nothing
 *     becomes public by deploying this. Every share is a deliberate act with a
 *     confirmation step that says what is about to be exposed.
 *  2. **The scrub gate refuses transcripts ingested before the credential-scrub
 *     cutover**, at BOTH publish and render. Re-checking at render matters: the
 *     cutoff is a property of the transcript, and a link minted today must not
 *     keep serving if the underlying row is later found un-scrubbed.
 *  3. **Revocation is real** — a row flip, no secret to rotate, effective on the
 *     next request.
 *
 * What the scrub gate does NOT do, stated plainly because the design leaned on
 * it during planning and it does not bear that weight: it matches CREDENTIAL
 * patterns. It does nothing about PII, file contents, customer data, or any
 * other sensitive-but-unpatterned material an agent read into the transcript.
 * ADR-025 names exactly those categories as the reason the transcript archive
 * bucket must be private, and mt#3850 is an open record of live secrets reaching
 * transcripts through `ps` output. That is why (1) exists and why the publish
 * confirmation is explicit rather than a one-click affordance.
 */
import { createHash, randomBytes } from "crypto";
import { Router, type Request, type Response } from "express";

import { log } from "@minsky/shared/logger";
import { respondIfDatabaseUnavailable } from "./db-unavailable-response";

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

export interface ShareRecord {
  id: string;
  conversationId: string;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  lastAccessedAt: Date | null;
}

/** What a token lookup yields: the share, or why it cannot be served. */
export type ShareLookup =
  | { kind: "live"; share: ShareRecord }
  | { kind: "revoked" }
  | { kind: "unknown" };

export interface ShareStore {
  insertShare(input: {
    tokenHash: string;
    conversationId: string;
    label: string | null;
  }): Promise<ShareRecord>;
  findByTokenHash(tokenHash: string): Promise<ShareLookup>;
  listShares(): Promise<ShareRecord[]>;
  revokeShare(id: string, now: Date): Promise<boolean>;
  touchLastAccessed(id: string, now: Date): Promise<void>;
}

/** The conversation content read — the SAME scrub-gated fetch the session film uses. */
export interface ConversationContent {
  blocks: unknown[];
  ingestedAt: string | null;
}

export interface ConversationShareDeps {
  store: ShareStore;
  /** Scrub-gated content fetch. Injected so the routes are testable without a database. */
  fetchContent: (conversationId: string) => Promise<ConversationContent | null>;
  /** Throws `UnscrubbedSessionError` when the transcript predates the scrub cutover. */
  assertScrubGate: (ingestedAt: string | null) => void;
  now?: () => Date;
  randomToken?: () => string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * 32 bytes — 256 bits, double the spec's 128-bit floor. A share token is the
 * ONLY thing protecting the content behind it, and unlike a password it is
 * never rate-limited by a login form, so the cost of being generous here is a
 * longer URL and nothing else.
 */
const TOKEN_BYTES = 32;

function toHex(bytes: Uint8Array): string {
  // Not `Buffer#toString("hex")` — this repo's root @types/node and bun-types
  // disagree about that overload set (see src/cockpit/auth.ts for the same
  // workaround).
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function mintShareToken(): string {
  return toHex(randomBytes(TOKEN_BYTES));
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The public path a minted token is served at. */
export function sharePath(token: string): string {
  return `/s/${token}`;
}

/**
 * A share page must never be indexed. The ChatGPT shared-link incident (Aug
 * 2025) is the precedent: links intended for one recipient turned up in search
 * results. Set on BOTH the HTML shell and the JSON, since either could be
 * crawled if a link leaks.
 */
export function applyNoIndexHeaders(res: Response): void {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface Resolved extends ConversationShareDeps {
  now: () => Date;
  randomToken: () => string;
}

function resolve(deps: ConversationShareDeps): Resolved {
  return {
    ...deps,
    now: deps.now ?? (() => new Date()),
    randomToken: deps.randomToken ?? mintShareToken,
  };
}

function toWireShare(share: ShareRecord, includeToken?: string) {
  return {
    id: share.id,
    conversationId: share.conversationId,
    label: share.label,
    createdAt: share.createdAt.toISOString(),
    revokedAt: share.revokedAt?.toISOString() ?? null,
    lastAccessedAt: share.lastAccessedAt?.toISOString() ?? null,
    // Only ever present on the mint response — the raw token is not recoverable
    // afterwards, by design (the store holds a hash).
    ...(includeToken ? { url: sharePath(includeToken) } : {}),
  };
}

export function createConversationShareRoutes(deps: ConversationShareDeps): Router {
  const resolved = resolve(deps);
  const router = Router();

  // --- Authenticated: mint --------------------------------------------------

  router.post("/api/shares", (req: Request, res: Response) => {
    void (async () => {
      try {
        const { conversationId, label } = req.body ?? {};
        if (typeof conversationId !== "string" || conversationId.length === 0) {
          res.status(400).json({ error: "`conversationId` is required" });
          return;
        }

        // Fetch BEFORE minting: a link to a conversation that cannot be read is
        // worse than a refusal, because it fails only for the recipient.
        const content = await resolved.fetchContent(conversationId);
        if (!content) {
          res.status(404).json({ error: "No transcript found for that conversation" });
          return;
        }
        try {
          resolved.assertScrubGate(content.ingestedAt);
        } catch (err: unknown) {
          res.status(422).json({
            error: "unscrubbed",
            detail: err instanceof Error ? err.message : "Transcript failed the scrub gate",
          });
          return;
        }

        const token = resolved.randomToken();
        const share = await resolved.store.insertShare({
          tokenHash: hashShareToken(token),
          conversationId,
          label: typeof label === "string" && label.trim() ? label.trim() : null,
        });
        res.status(201).json(toWireShare(share, token));
      } catch (err: unknown) {
        if (await respondIfDatabaseUnavailable(res, err, "shares")) return;
        log.error("[shares] mint failed:", { originalError: err });
        res.status(500).json({ error: "Could not create the share link" });
      }
    })();
  });

  // --- Authenticated: list --------------------------------------------------

  router.get("/api/shares", (_req: Request, res: Response) => {
    void (async () => {
      try {
        const shares = await resolved.store.listShares();
        res.json({ shares: shares.map((s) => toWireShare(s)) });
      } catch (err: unknown) {
        if (await respondIfDatabaseUnavailable(res, err, "shares")) return;
        log.error("[shares] list failed:", { originalError: err });
        res.status(500).json({ error: "Could not list share links" });
      }
    })();
  });

  // --- Authenticated: revoke ------------------------------------------------

  router.post("/api/shares/:id/revoke", (req: Request, res: Response) => {
    void (async () => {
      try {
        const revoked = await resolved.store.revokeShare(req.params.id ?? "", resolved.now());
        if (!revoked) {
          res.status(404).json({ error: "No such share link" });
          return;
        }
        res.json({ revoked: true });
      } catch (err: unknown) {
        if (await respondIfDatabaseUnavailable(res, err, "shares")) return;
        log.error("[shares] revoke failed:", { originalError: err });
        res.status(500).json({ error: "Could not revoke the share link" });
      }
    })();
  });

  // --- PUBLIC: the shared conversation's content ----------------------------

  router.get("/api/shares/public/:token", (req: Request, res: Response) => {
    void (async () => {
      applyNoIndexHeaders(res);
      try {
        const token = req.params.token ?? "";
        const lookup = await resolved.store.findByTokenHash(hashShareToken(token));

        // 410 vs 404 is deliberate and the distinction is FOR THE READER, not a
        // leak: someone holding a link that used to work needs to know it was
        // turned off rather than mistyped. A guessed token yields 404, and
        // guessing a 256-bit token is not a threat model.
        if (lookup.kind === "revoked") {
          res.status(410).json({ error: "This share link has been revoked" });
          return;
        }
        if (lookup.kind === "unknown") {
          res.status(404).json({ error: "No such share link" });
          return;
        }

        const content = await resolved.fetchContent(lookup.share.conversationId);
        if (!content) {
          res.status(404).json({ error: "The shared conversation is no longer available" });
          return;
        }
        // Re-checked at RENDER, not only at publish. The gate is a property of
        // the transcript row, so a link minted while it passed must stop
        // serving if it later does not.
        try {
          resolved.assertScrubGate(content.ingestedAt);
        } catch {
          res.status(422).json({ error: "This conversation is no longer publishable" });
          return;
        }

        await resolved.store.touchLastAccessed(lookup.share.id, resolved.now());

        res.json({
          conversationId: lookup.share.conversationId,
          label: lookup.share.label,
          createdAt: lookup.share.createdAt.toISOString(),
          blocks: content.blocks,
        });
      } catch (err: unknown) {
        if (await respondIfDatabaseUnavailable(res, err, "shares")) return;
        log.error("[shares] public render failed:", { originalError: err });
        res.status(500).json({ error: "Could not load the shared conversation" });
      }
    })();
  });

  // --- PUBLIC: the share page's HTML shell ----------------------------------
  //
  // Only sets headers and falls through — the SPA catch-all serves index.html,
  // so the share page reuses the app shell (and its renderers) rather than
  // duplicating a second HTML surface that would drift from it.
  router.get("/s/:token", (_req: Request, res: Response, next) => {
    applyNoIndexHeaders(res);
    next();
  });

  return router;
}
