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
// mt#4398: the cockpit's argument-free wrapper over
// `describePersistenceUnavailability` — it resolves the provider itself, which
// is what makes it usable here where only a null `db` is in hand. No cycle:
// `db-providers` does not import this module.
import { describeServerPersistenceUnavailability } from "./db-providers";

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
    if (!db) {
      // mt#4398: was a cause-free sentence. `check-sql-capability-messages`
      // flagged it and nothing surfaced the flag, because that check has never
      // been wired to run — which this task fixes in the same change.
      throw new Error(
        `Cockpit passkey auth: no database connection available. ${await describeServerPersistenceUnavailability()}`
      );
    }
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
