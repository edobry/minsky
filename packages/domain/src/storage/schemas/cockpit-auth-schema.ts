import { pgTable, text, uuid, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Cockpit passkey authentication (mt#4023).
 *
 * Two tables, both holding authentication material exclusively and no product
 * data. That separation is load-bearing rather than cosmetic: the deployed
 * `cockpit-preview` service connects to the production database as the
 * SELECT-only `minsky_preview` role (verified 2026-08-11 via
 * `pg_stat_activity` — one live connection under that role), so the migration
 * that creates these tables also grants write access on EXACTLY these two.
 * Keeping product data out of them is what makes that grant safe to hand a
 * role that is otherwise read-only.
 *
 * WebAuthn ceremony state (the per-ceremony challenge) is deliberately NOT
 * stored here — it lives in a short-TTL in-memory map in
 * `src/cockpit/passkey-auth.ts`. A challenge is single-use and expires in
 * seconds, the deployment runs one replica, and losing in-flight challenges on
 * restart costs a user one retry. A third table would buy nothing.
 *
 * Cross-references: mt#4023 (this), mt#2538 (the local-daemon auth posture this
 * extends), ADR-023 (the accepted record that names the unauthenticated-daemon
 * gap).
 */

/**
 * Registered passkey credentials. One row per authenticator the principal has
 * enrolled — several are expected and healthy (laptop, phone, hardware key),
 * which is why enrollment is not capped at one.
 */
export const cockpitPasskeysTable = pgTable(
  "cockpit_passkeys",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * The credential's own id, base64url-encoded — WebAuthn's identifier for
     * this authenticator, echoed back by the browser on every login. Unique
     * because a second row for the same credential would make the login lookup
     * ambiguous.
     */
    credentialId: text("credential_id").notNull().unique(),

    /** COSE public key, base64url-encoded. Verification material, not a secret. */
    publicKey: text("public_key").notNull(),

    /**
     * WebAuthn signature counter. Synced passkeys generally report 0 forever,
     * so this is recorded rather than enforced — a regression is not treated as
     * a cloned-authenticator signal, because for the dominant credential type it
     * carries no signal at all.
     */
    counter: integer("counter").notNull().default(0),

    /** Reported transports (`internal`, `hybrid`, `usb`, …), when the browser supplies them. */
    transports: jsonb("transports").$type<string[]>(),

    /** Operator-facing label, so a revocation list is readable ("MacBook", "iPhone"). */
    label: text("label"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    byCredentialId: index("idx_cockpit_passkeys_credential_id").on(table.credentialId),
  })
);

/**
 * Issued browser sessions. Stored rather than signed-stateless so that
 * revocation is real: deleting the row ends the session on the next request,
 * with no secret to rotate and no window during which an already-issued token
 * stays valid.
 */
export const cockpitAuthSessionsTable = pgTable(
  "cockpit_auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * SHA-256 of the session token, hex-encoded. The raw token exists only in
     * the operator's cookie — a database read yields no usable session, which
     * matters more here than usual because the role that reads this table also
     * reads it from a shared production database.
     */
    tokenHash: text("token_hash").notNull().unique(),

    /** Which credential authenticated this session. Null once that passkey is deleted. */
    passkeyId: uuid("passkey_id").references(() => cockpitPasskeysTable.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    byTokenHash: index("idx_cockpit_auth_sessions_token_hash").on(table.tokenHash),
    byExpiresAt: index("idx_cockpit_auth_sessions_expires_at").on(table.expiresAt),
  })
);

export type CockpitPasskeyRecord = typeof cockpitPasskeysTable.$inferSelect;
export type CockpitPasskeyInsert = typeof cockpitPasskeysTable.$inferInsert;
export type CockpitAuthSessionRecord = typeof cockpitAuthSessionsTable.$inferSelect;
export type CockpitAuthSessionInsert = typeof cockpitAuthSessionsTable.$inferInsert;
