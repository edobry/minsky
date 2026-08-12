import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Published conversation share links (mt#4024).
 *
 * One row per minted link. The row is the ONLY thing standing between a public
 * URL and a conversation, so two properties matter more than anything else
 * here:
 *
 *  - **The token is stored hashed.** A database read yields no working share
 *    URL. This matters more than usual because the deployed cockpit reads this
 *    table through a role on the shared production database.
 *  - **Revocation is a state, not a delete.** A revoked row is retained so the
 *    public route can answer 410 (Gone) rather than 404 — the difference
 *    between "this link was turned off" and "this link never existed" is what
 *    the person holding a stale link actually needs to be told.
 *
 * Deliberately NOT stored: any copy of the conversation. A share renders the
 * live transcript through the same scrub-gated read path the authenticated view
 * uses, so revoking a link revokes access to the content, and a conversation
 * cannot go stale behind a link that outlives it.
 *
 * Cross-references: mt#4024 (this), mt#4023 (the passkey gate whose public-path
 * allow-list this route joins), ADR-025 (transcript access-control posture).
 */
export const conversationSharesTable = pgTable(
  "cockpit_conversation_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * SHA-256 of the share token, hex-encoded. The raw token exists only in the
     * URL the operator copies.
     */
    tokenHash: text("token_hash").notNull().unique(),

    /** The harness conversation this link publishes (`agent_transcripts.agent_session_id`). */
    conversationId: text("conversation_id").notNull(),

    /** Operator-facing note, so a list of live links is readable. */
    label: text("label"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /** Null while live. Set on revoke; the row is retained so `/s/<token>` can answer 410. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    /** Last time the public page was served — so the operator can see whether a link is in use. */
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
  },
  (table) => ({
    byTokenHash: index("idx_conversation_shares_token_hash").on(table.tokenHash),
    byConversation: index("idx_conversation_shares_conversation").on(table.conversationId),
  })
);

export type ConversationShareRecord = typeof conversationSharesTable.$inferSelect;
export type ConversationShareInsert = typeof conversationSharesTable.$inferInsert;
