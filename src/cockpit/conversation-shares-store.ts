/**
 * Drizzle-backed `ShareStore` (mt#4024).
 *
 * Split from ./conversation-shares.ts so the publish/revoke/render DECISIONS —
 * which is the part that can be wrong in a way that exposes something — are
 * tested against a fake with no database in the picture.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { conversationSharesTable } from "@minsky/domain/storage/schemas/conversation-shares-schema";

import type { ShareLookup, ShareRecord, ShareStore } from "./conversation-shares";
// mt#4398 — see `passkey-store.ts` for why this wrapper rather than the domain
// helper directly.
import { describeServerPersistenceUnavailability } from "./db-providers";

const COLUMNS = {
  id: conversationSharesTable.id,
  conversationId: conversationSharesTable.conversationId,
  label: conversationSharesTable.label,
  createdAt: conversationSharesTable.createdAt,
  revokedAt: conversationSharesTable.revokedAt,
  lastAccessedAt: conversationSharesTable.lastAccessedAt,
} as const;

export function createDrizzleShareStore(db: PostgresJsDatabase): ShareStore {
  return {
    async insertShare(input): Promise<ShareRecord> {
      const [row] = await db
        .insert(conversationSharesTable)
        .values({
          tokenHash: input.tokenHash,
          conversationId: input.conversationId,
          label: input.label,
        })
        .returning(COLUMNS);
      if (!row) throw new Error("Share insert returned no row");
      return row;
    },

    async findByTokenHash(tokenHash: string): Promise<ShareLookup> {
      const [row] = await db
        .select(COLUMNS)
        .from(conversationSharesTable)
        .where(eq(conversationSharesTable.tokenHash, tokenHash))
        .limit(1);
      if (!row) return { kind: "unknown" };
      // Revoked is distinguished from absent so the public route can answer 410
      // rather than 404 — see the route's comment for why that distinction is
      // for the reader rather than a leak.
      if (row.revokedAt !== null) return { kind: "revoked" };
      return { kind: "live", share: row };
    },

    async listShares(): Promise<ShareRecord[]> {
      return await db
        .select(COLUMNS)
        .from(conversationSharesTable)
        .orderBy(desc(conversationSharesTable.createdAt));
    },

    async revokeShare(id: string, now: Date): Promise<boolean> {
      // `isNull(revokedAt)` makes a second revoke a no-op that reports false,
      // rather than silently rewriting the original revocation time.
      const rows = await db
        .update(conversationSharesTable)
        .set({ revokedAt: now })
        .where(and(eq(conversationSharesTable.id, id), isNull(conversationSharesTable.revokedAt)))
        .returning({ id: conversationSharesTable.id });
      return rows.length > 0;
    },

    async touchLastAccessed(id: string, now: Date): Promise<void> {
      await db
        .update(conversationSharesTable)
        .set({ lastAccessedAt: now })
        .where(eq(conversationSharesTable.id, id));
    },
  };
}

/**
 * Resolves its connection on first use, for the same reason the passkey store
 * does: `createCockpitServer` is synchronous and the persistence provider is
 * not ready at construction time. A resolution failure surfaces as a 500 on the
 * request that needed it, never as an accidental pass.
 */
export function createLazyDrizzleShareStore(
  getDb: () => Promise<PostgresJsDatabase | null>
): ShareStore {
  let cached: ShareStore | null = null;

  async function store(): Promise<ShareStore> {
    if (cached) return cached;
    const db = await getDb();
    if (!db) {
      // mt#4398: see the sibling in `passkey-store.ts` — same cause-free shape,
      // same fix, and the same reason it went unnoticed.
      throw new Error(
        `Conversation shares: no database connection available. ${await describeServerPersistenceUnavailability()}`
      );
    }
    cached = createDrizzleShareStore(db);
    return cached;
  }

  return {
    insertShare: async (input) => (await store()).insertShare(input),
    findByTokenHash: async (hash) => (await store()).findByTokenHash(hash),
    listShares: async () => (await store()).listShares(),
    revokeShare: async (id, now) => (await store()).revokeShare(id, now),
    touchLastAccessed: async (id, now) => (await store()).touchLastAccessed(id, now),
  };
}
