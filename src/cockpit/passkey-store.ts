/**
 * Drizzle-backed `PasskeyStore` (mt#4023).
 *
 * Separated from ./passkey-auth.ts so the ceremony and session logic can be
 * tested against a fake store with no database anywhere in the picture. This
 * file is the only place that knows the tables exist.
 */
import { and, eq, gt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  cockpitPasskeysTable,
  cockpitAuthSessionsTable,
} from "@minsky/domain/storage/schemas/cockpit-auth-schema";

import type { PasskeyStore, StoredPasskey } from "./passkey-auth";

/**
 * A store that resolves its database connection on first use.
 *
 * `createCockpitServer` is synchronous, and the persistence provider is not
 * ready at construction time. Resolving lazily keeps the factory sync without
 * making the caller await a connection it may never need — and a resolution
 * failure surfaces as a thrown error on the request that needed it, which the
 * middleware turns into a 503 rather than an accidental pass.
 */
export function createLazyDrizzlePasskeyStore(
  getDb: () => Promise<PostgresJsDatabase | null>
): PasskeyStore {
  let cached: PasskeyStore | null = null;

  async function resolveStore(): Promise<PasskeyStore> {
    if (cached) return cached;
    const db = await getDb();
    if (!db) throw new Error("Cockpit passkey auth: no database connection available");
    cached = createDrizzlePasskeyStore(db);
    return cached;
  }

  return {
    listPasskeys: async () => (await resolveStore()).listPasskeys(),
    findPasskeyByCredentialId: async (id) => (await resolveStore()).findPasskeyByCredentialId(id),
    insertPasskey: async (input) => (await resolveStore()).insertPasskey(input),
    updatePasskeyCounter: async (id, counter) =>
      (await resolveStore()).updatePasskeyCounter(id, counter),
    createSession: async (input) => (await resolveStore()).createSession(input),
    findValidSession: async (hash, now) => (await resolveStore()).findValidSession(hash, now),
    deleteSession: async (hash) => (await resolveStore()).deleteSession(hash),
  };
}

export function createDrizzlePasskeyStore(db: PostgresJsDatabase): PasskeyStore {
  return {
    async listPasskeys(): Promise<StoredPasskey[]> {
      const rows = await db
        .select({
          id: cockpitPasskeysTable.id,
          credentialId: cockpitPasskeysTable.credentialId,
          publicKey: cockpitPasskeysTable.publicKey,
          counter: cockpitPasskeysTable.counter,
          transports: cockpitPasskeysTable.transports,
        })
        .from(cockpitPasskeysTable);
      return rows;
    },

    async findPasskeyByCredentialId(credentialId: string): Promise<StoredPasskey | null> {
      const [row] = await db
        .select({
          id: cockpitPasskeysTable.id,
          credentialId: cockpitPasskeysTable.credentialId,
          publicKey: cockpitPasskeysTable.publicKey,
          counter: cockpitPasskeysTable.counter,
          transports: cockpitPasskeysTable.transports,
        })
        .from(cockpitPasskeysTable)
        .where(eq(cockpitPasskeysTable.credentialId, credentialId))
        .limit(1);
      return row ?? null;
    },

    async insertPasskey(input): Promise<string> {
      const [row] = await db
        .insert(cockpitPasskeysTable)
        .values({
          credentialId: input.credentialId,
          publicKey: input.publicKey,
          counter: input.counter,
          transports: input.transports,
          label: input.label,
        })
        .returning({ id: cockpitPasskeysTable.id });
      if (!row) throw new Error("Passkey insert returned no row");
      return row.id;
    },

    async updatePasskeyCounter(credentialId: string, counter: number): Promise<void> {
      await db
        .update(cockpitPasskeysTable)
        .set({ counter, lastUsedAt: new Date() })
        .where(eq(cockpitPasskeysTable.credentialId, credentialId));
    },

    async createSession(input): Promise<void> {
      await db.insert(cockpitAuthSessionsTable).values({
        tokenHash: input.tokenHash,
        passkeyId: input.passkeyId,
        expiresAt: input.expiresAt,
      });
    },

    async findValidSession(tokenHash: string, now: Date): Promise<{ id: string } | null> {
      // Expiry is enforced in the WHERE clause rather than after the read, so a
      // stale row can never be treated as live by a caller that forgets to
      // check — and a revoked (deleted) row simply does not match.
      const [row] = await db
        .select({ id: cockpitAuthSessionsTable.id })
        .from(cockpitAuthSessionsTable)
        .where(
          and(
            eq(cockpitAuthSessionsTable.tokenHash, tokenHash),
            gt(cockpitAuthSessionsTable.expiresAt, now)
          )
        )
        .limit(1);
      return row ?? null;
    },

    async deleteSession(tokenHash: string): Promise<void> {
      await db
        .delete(cockpitAuthSessionsTable)
        .where(eq(cockpitAuthSessionsTable.tokenHash, tokenHash));
    },
  };
}
