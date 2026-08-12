/**
 * Conversation share-link route tests (mt#4024).
 *
 * Every assertion here is about EXPOSURE — who can read what, and when it
 * stops. Run against a real HTTP server with injected fakes, because the
 * properties worth testing (the gate lets the public route through but nothing
 * else; a revoked link stops serving) are properties of the middleware chain,
 * not of any single function.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer, type Server } from "http";

import { createCockpitServer } from "./server";
import {
  hashShareToken,
  type ShareLookup,
  type ShareRecord,
  type ShareStore,
} from "./conversation-shares";
import type { PasskeyStore } from "./passkey-auth";

const CONTENT_TYPE_JSON = "application/json";
const SESSION_COOKIE_HEADER = "minsky_cockpit_session=test";
const CONVERSATION_ID = "agent-ae1576839e37ecab9";

const closeList: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closeList.length > 0) {
    const close = closeList.pop();
    if (close) await close();
  }
});

function authenticatedPasskeyStore(): PasskeyStore {
  return {
    listPasskeys: async () => [{ id: "p1", credentialId: "c1", publicKey: "", counter: 0 }],
    findPasskeyByCredentialId: async () => null,
    insertPasskey: async () => "p1",
    updatePasskeyCounter: async () => {},
    createSession: async () => {},
    findValidSession: async () => ({ id: "s1" }),
    deleteSession: async () => {},
  };
}

/** In-memory share store. Records the token HASH, exactly as the real one does. */
function fakeShareStore() {
  const rows: Array<ShareRecord & { tokenHash: string }> = [];
  let nextId = 1;
  const store: ShareStore = {
    async insertShare(input) {
      const row = {
        id: `share-${nextId++}`,
        conversationId: input.conversationId,
        label: input.label,
        createdAt: new Date("2026-08-12T00:00:00Z"),
        revokedAt: null,
        lastAccessedAt: null,
        tokenHash: input.tokenHash,
      };
      rows.push(row);
      return row;
    },
    async findByTokenHash(tokenHash): Promise<ShareLookup> {
      const row = rows.find((r) => r.tokenHash === tokenHash);
      if (!row) return { kind: "unknown" };
      if (row.revokedAt !== null) return { kind: "revoked" };
      return { kind: "live", share: row };
    },
    async listShares() {
      return rows;
    },
    async revokeShare(id, now) {
      const row = rows.find((r) => r.id === id && r.revokedAt === null);
      if (!row) return false;
      row.revokedAt = now;
      return true;
    },
    async touchLastAccessed(id, now) {
      const row = rows.find((r) => r.id === id);
      if (row) row.lastAccessedAt = now;
    },
  };
  return { store, rows };
}

interface StartOptions {
  scrubGateThrows?: boolean;
  contentMissing?: boolean;
  shareStore?: ShareStore;
}

async function startServer(opts: StartOptions = {}) {
  const shares = opts.shareStore ? { store: opts.shareStore, rows: [] } : fakeShareStore();
  const app = createCockpitServer({
    isPublicDeployment: true,
    publicAuth: "passkey",
    passkeyStore: authenticatedPasskeyStore(),
    shareStore: shares.store,
    shareFetchContent: async () =>
      opts.contentMissing
        ? null
        : { blocks: [{ kind: "text", text: "hello" }], ingestedAt: "2026-08-01T00:00:00Z" },
    shareAssertScrubGate: () => {
      if (opts.scrubGateThrows) throw new Error("Export refused: session ingested before cutoff");
    },
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closeList.push(
    () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
  return { url: `http://127.0.0.1:${addr.port}`, shares };
}

/** First stored row, asserted present — a missing row is a test failure, not a crash. */
function onlyRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) throw new Error("expected exactly one stored share row, found none");
  return row;
}

async function mint(url: string, body: unknown = { conversationId: CONVERSATION_ID }) {
  return await fetch(`${url}/api/shares`, {
    method: "POST",
    headers: { "Content-Type": CONTENT_TYPE_JSON, Cookie: SESSION_COOKIE_HEADER },
    body: JSON.stringify(body),
  });
}

describe("conversation share links (mt#4024)", () => {
  describe("who may mint", () => {
    test("minting REQUIRES a session — the gate covers /api/shares", async () => {
      const { url } = await startServer();
      const res = await fetch(`${url}/api/shares`, {
        method: "POST",
        headers: { "Content-Type": CONTENT_TYPE_JSON },
        body: JSON.stringify({ conversationId: CONVERSATION_ID }),
      });
      expect(res.status).toBe(401);
    });

    test("listing shares REQUIRES a session", async () => {
      const { url } = await startServer();
      expect((await fetch(`${url}/api/shares`)).status).toBe(401);
    });

    test("an authenticated operator can mint, and gets a /s/<token> URL back", async () => {
      const { url } = await startServer();
      const res = await mint(url);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { url: string };
      expect(body.url).toMatch(/^\/s\/[0-9a-f]{64}$/);
    });

    test("the raw token is NOT stored — only its hash", async () => {
      const { url, shares } = await startServer();
      const body = (await (await mint(url)).json()) as { url: string };
      const token = body.url.replace("/s/", "");
      expect(shares.rows).toHaveLength(1);
      expect(onlyRow(shares.rows).tokenHash).toBe(hashShareToken(token));
      // The store holds nothing that equals the token itself.
      expect(JSON.stringify(shares.rows)).not.toContain(token);
    });
  });

  describe("the scrub gate", () => {
    test("publishing an un-scrubbed transcript is REFUSED, and mints nothing", async () => {
      const { url, shares } = await startServer({ scrubGateThrows: true });
      const res = await mint(url);
      expect(res.status).toBe(422);
      expect(shares.rows).toHaveLength(0);
    });

    test("publishing a conversation with no transcript is refused", async () => {
      const { url, shares } = await startServer({ contentMissing: true });
      expect((await mint(url)).status).toBe(404);
      expect(shares.rows).toHaveLength(0);
    });
  });

  describe("the public share page", () => {
    test("serves the conversation WITHOUT a session", async () => {
      const { url } = await startServer();
      const body = (await (await mint(url)).json()) as { url: string };
      const token = body.url.replace("/s/", "");

      // No cookie: this is the whole point of the feature.
      const res = await fetch(`${url}/api/shares/public/${token}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as { conversationId: string; blocks: unknown[] };
      expect(page.conversationId).toBe(CONVERSATION_ID);
      expect(page.blocks).toHaveLength(1);
    });

    test("carries noindex headers", async () => {
      const { url } = await startServer();
      const body = (await (await mint(url)).json()) as { url: string };
      const token = body.url.replace("/s/", "");
      const res = await fetch(`${url}/api/shares/public/${token}`);
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
    });

    test("an unknown token is 404", async () => {
      const { url } = await startServer();
      const res = await fetch(`${url}/api/shares/public/${"0".repeat(64)}`);
      expect(res.status).toBe(404);
    });

    test("a REVOKED token is 410, not 404 — the reader is told it was turned off", async () => {
      const { url, shares } = await startServer();
      const body = (await (await mint(url)).json()) as { url: string };
      const token = body.url.replace("/s/", "");

      const revoke = await fetch(`${url}/api/shares/${onlyRow(shares.rows).id}/revoke`, {
        method: "POST",
        headers: { Cookie: SESSION_COOKIE_HEADER },
      });
      expect(revoke.status).toBe(200);

      const res = await fetch(`${url}/api/shares/public/${token}`);
      expect(res.status).toBe(410);
      // And it serves NO content.
      expect(await res.text()).not.toContain("hello");
    });

    test("publishing one conversation does NOT open any other route", async () => {
      // The property that makes the allow-list narrow rather than a hole: a
      // share being live changes nothing about the rest of the surface.
      const { url } = await startServer();
      await mint(url);
      expect((await fetch(`${url}/api/tasks`)).status).toBe(401);
      expect((await fetch(`${url}/api/shares`)).status).toBe(401);
    });
  });

  describe("revocation", () => {
    test("revoking a second time reports no-op rather than rewriting the time", async () => {
      const { url, shares } = await startServer();
      await mint(url);
      const id = onlyRow(shares.rows).id;
      const first = await fetch(`${url}/api/shares/${id}/revoke`, {
        method: "POST",
        headers: { Cookie: SESSION_COOKIE_HEADER },
      });
      expect(first.status).toBe(200);
      const second = await fetch(`${url}/api/shares/${id}/revoke`, {
        method: "POST",
        headers: { Cookie: SESSION_COOKIE_HEADER },
      });
      expect(second.status).toBe(404);
    });

    test("revoking REQUIRES a session", async () => {
      const { url, shares } = await startServer();
      await mint(url);
      const res = await fetch(`${url}/api/shares/${onlyRow(shares.rows).id}/revoke`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });
  });
});
