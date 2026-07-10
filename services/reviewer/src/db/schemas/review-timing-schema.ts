/**
 * Drizzle schema for review_timing table.
 *
 * Per-review timing persistence for observability and timeout budget grounding.
 * Owned by the reviewer service. No imports from src/.
 *
 * mt#2088.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const reviewTimingTable = pgTable(
  "review_timing",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),

    prOwner: text("pr_owner").notNull(),
    prRepo: text("pr_repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    iterationIndex: integer("iteration_index").notNull(),

    totalWallClockMs: integer("total_wall_clock_ms").notNull(),
    perRoundLatenciesMs: integer("per_round_latencies_ms")
      .array()
      .notNull()
      .default(sql`'{}'::int[]`),

    timeoutCount: integer("timeout_count").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    retryOutcomes: text("retry_outcomes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    scopeClassification: text("scope_classification"),
    toolUseActive: boolean("tool_use_active"),
    provider: text("provider"),
    model: text("model"),

    // mt#2288: per-review token spend + computed USD cost. Nullable because the
    // two pre-model skip paths (routing-skip, concurrent-inflight) write a
    // timing row with no model call. cost_usd is frozen at write time from a
    // static per-model pricing map (see token-cost.ts); NULL when the model is
    // unpriced.
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    // mt#2721: cached input tokens (OpenAI prompt_tokens_details.cached_tokens);
    // a per-review cache-hit ratio is cached_tokens / input_tokens.
    cachedTokens: integer("cached_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    byPrIteration: index("idx_rt_pr_iteration").on(
      table.prOwner,
      table.prRepo,
      table.prNumber,
      table.iterationIndex
    ),
    byCreatedAt: index("idx_rt_created_at").on(table.createdAt),
  })
);

export type ReviewTimingRecord = typeof reviewTimingTable.$inferSelect;
export type ReviewTimingInsert = typeof reviewTimingTable.$inferInsert;
