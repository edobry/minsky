/**
 * Drizzle schema for `telegram_channel_topics` (mt#3505, parent mt#3500).
 *
 * The bot's own inventory of Telegram DM forum topics it has seen inbound,
 * mapping each `message_thread_id` to the `driven_sessions.local_id` of the
 * conversation that topic holds. This table exists because the Bot API
 * exposes no `getForumTopics` (verified absent from core.telegram.org/bots/api
 * — mt#3500 Context) — the bot cannot re-enumerate its own topics, so it must
 * own the mapping itself.
 *
 * ## Identity: `localId` is deterministic, not looked up
 *
 * `localId` is derived from (`chatId`, `messageThreadId`) by
 * `telegramTopicLocalId` (../../../../src/cockpit/principal-channel-launch.ts)
 * — never randomly generated, and never read back from this table to learn
 * what a topic's conversation id IS. What this table answers instead is
 * "have I seen this topic before" (so an unmapped thread id can be told apart
 * from a mapped one) and, from Phase 2 on, "what entity is this topic bound
 * to" — the two nullable columns below.
 *
 * ## Why the entity columns are nullable (Phase 1 requirement, not deferred)
 *
 * A principal-initiated topic (mt#3505's whole scope) starts life with NO
 * entity behind it — the principal opened a topic on a thought that has no
 * home yet. Per mt#3500's "What a topic IS" section: "An unbound topic is a
 * first-class state, not a transitional one." Phase 2 (mt#3507) fills these
 * columns IN PLACE once a topic's conversation produces a task/ask/etc — the
 * `local_id` primary key and its `driven_sessions` row never change when that
 * happens, only these two columns go from NULL to set.
 *
 * ## Conventions followed (from ./entity-threads-schema.ts and
 * ./driven-sessions-schema.ts, this table's two closest siblings)
 *
 * Plain `text` for status/kind-like columns (no pg enum) — cheap to extend.
 * `updatedAt` has no Postgres trigger; a future writer touching this row is
 * responsible for setting it explicitly, matching every other table in this
 * schema directory. `localId` is a `driven_sessions.local_id`-space value in
 * the same sense `entity_threads.local_id` is (see that schema's own
 * "Identity" section) — a third table sharing this keyspace, not a fourth
 * identity scheme competing with it.
 *
 * @see mt#3505 — this schema (Phase 1: principal-initiated topics)
 * @see mt#3500 — parent (design, "What a topic IS", the nullable-entity decision)
 * @see ./entity-threads-schema.ts — the sibling this mirrors most closely
 * @see ./driven-sessions-schema.ts — the table `local_id` is shared with
 * @see ../../../../src/cockpit/principal-channel-launch.ts — the read/write module
 */

import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const telegramChannelTopicsTable = pgTable(
  "telegram_channel_topics",
  {
    /**
     * Deterministic `driven_sessions.local_id` for this topic's conversation —
     * see the module docblock's "Identity" section. Primary key: one row per
     * conversation, matching this table's closest sibling
     * (`entity_threads.local_id`).
     */
    localId: text("local_id").primaryKey(),

    /** The Telegram chat this topic lives in. Thread ids are chat-scoped. */
    chatId: text("chat_id").notNull(),
    /** Telegram's `message_thread_id` — the topic's own identifier within the chat. */
    messageThreadId: integer("message_thread_id").notNull(),

    /**
     * NULLABLE — an unbound topic (no entity yet) is a first-class, PERMANENT
     * state, not a transitional one (mt#3500's "What a topic IS"). Phase 2
     * (mt#3507) fills these in place; this schema does not gate on when.
     */
    entityType: text("entity_type"),
    entityId: text("entity_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** No DB trigger — refreshed explicitly by the store's write path, per
     * this schema directory's established convention (see module docblock). */
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    /**
     * One row per (chat, thread) — what makes the store's "ensure a mapping
     * exists" write idempotent under a redelivered Telegram update racing a
     * fresh one, rather than relying on the caller to check-then-insert.
     */
    byChatThread: uniqueIndex("idx_tct_chat_thread").on(table.chatId, table.messageThreadId),
  })
);

export type TelegramChannelTopicRow = typeof telegramChannelTopicsTable.$inferSelect;
export type TelegramChannelTopicRowInsert = typeof telegramChannelTopicsTable.$inferInsert;
