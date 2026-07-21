/**
 * Short-id unique-index SHAPE lock (mt#2999).
 *
 * Every entity's `idx_<table>_short_id_unique` index MUST be a PLAIN
 * (non-partial) unique index. The create paths insert with a bare
 * `.onConflictDoNothing({ target: <table>.shortId })`, which drizzle emits
 * as `ON CONFLICT ("short_id") DO NOTHING` — and Postgres only infers a
 * PARTIAL unique index as the conflict arbiter when the conflict target
 * repeats the index's predicate. A partial short-id index therefore breaks
 * EVERY insert on that table with "there is no unique or exclusion
 * constraint matching the ON CONFLICT specification".
 *
 * Originating incident (2026-07-21, mt#2999): migrations 0066/0067 shipped
 * `WHERE short_id IS NOT NULL` partial indexes for memories and sessions
 * (drift from the ADR-029 `shortIdUniqueIndex()` foundation helper, which
 * asks kept using) — memory_create AND session_start were fully down in
 * prod until the indexes were rebuilt plain (migration 0068). The
 * seam-level repository tests passed throughout: fakes don't enforce index
 * semantics, so this schema-level lock is the cheapest real-shape guard.
 */

import { describe, test, expect } from "bun:test";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { asksTable } from "./ask-schema";
import { memoriesTable } from "./memory-embeddings";
import { postgresSessions } from "./session-schema";

const CASES: Array<{ table: PgTable; tableName: string }> = [
  { table: asksTable, tableName: "asks" },
  { table: memoriesTable, tableName: "memories" },
  { table: postgresSessions, tableName: "sessions" },
];

describe("short-id unique indexes are PLAIN (non-partial) — mt#2999", () => {
  for (const { table, tableName } of CASES) {
    test(`idx_${tableName}_short_id_unique is unique and has NO partial-index predicate`, () => {
      const config = getTableConfig(table);
      const shortIdIndex = config.indexes.find(
        (idx) => idx.config.name === `idx_${tableName}_short_id_unique`
      );
      expect(shortIdIndex).toBeDefined();
      expect(shortIdIndex?.config.unique).toBe(true);
      // The load-bearing assertion: no WHERE predicate. A predicate here
      // regenerates a partial index on the next drizzle-kit migration and
      // re-breaks the bare ON CONFLICT create path (the mt#2999 outage).
      expect(shortIdIndex?.config.where).toBeUndefined();
    });
  }
});
