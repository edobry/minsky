/**
 * Reusable `short_id` column + unique-index PATTERN for adding a numeric
 * `entity#NNNN` short id alongside an entity table's existing primary key —
 * mt#2963, ADR-029.
 *
 * ## What this file is (and is not)
 *
 * This is a documented HELPER PATTERN, not a migration and not applied to
 * any table. mt#2963's scope is explicitly the shared foundation only — no
 * entity table (`asks`, `memories`, `sessions`, or any other) is modified
 * here. Each per-entity sibling task (mt#2965 ask, mt#2966 memory, mt#2967
 * session) is responsible for:
 *
 *   1. Adding `shortId: shortIdColumn()` to its own table's column map.
 *   2. Adding the unique index via `shortIdUniqueIndex(tableName, table.shortId)`
 *      in that table's index-builder callback.
 *   3. Authoring its own Drizzle migration (`drizzle-kit generate`) for the
 *      additive `ALTER TABLE ... ADD COLUMN short_id text` + the unique
 *      index — migrations are immutable/journaled per the
 *      `immutable-migration` pre-commit guard, so the migration file itself
 *      cannot be authored speculatively here without belonging to that
 *      table's own migration slot.
 *   4. Owning its own backfill strategy for existing rows (this column is
 *      nullable precisely so the column-add and the backfill can be
 *      separate, safely-sequenced steps — see "Nullable, not backfilled
 *      here" below).
 *   5. Wiring minting-on-create via `nextShortId` (`../../utils/short-id.ts`)
 *      + a per-entity tombstone mechanism, and resolution via
 *      `resolveEntityIdPrefix` / `resolveEntityIdPrefixOrThrow`
 *      (`../../utils/id-prefix-resolver.ts`).
 *
 * ## Usage (copy this shape into the per-entity schema file)
 *
 * ```ts
 * import { pgTable, uuid, text, uniqueIndex } from "drizzle-orm/pg-core";
 * import { shortIdColumn, shortIdUniqueIndex } from "../short-id-column";
 *
 * export const asksTable = pgTable(
 *   "asks",
 *   {
 *     id: uuid("id").defaultRandom().primaryKey(),
 *     // ...existing columns...
 *     shortId: shortIdColumn(),
 *   },
 *   (table) => ({
 *     // ...existing indexes...
 *     shortIdUnique: shortIdUniqueIndex("asks", table.shortId),
 *   })
 * );
 * ```
 *
 * ## Design decisions (ADR-029)
 *
 * - **Nullable, not backfilled here.** The column is added as plain
 *   nullable `text`, with no `NOT NULL` and no `DEFAULT`. This lets the
 *   `ADD COLUMN` migration itself be instant and lock-free on Postgres (no
 *   full-table rewrite), decoupled from the backfill. A plain (non-partial)
 *   UNIQUE INDEX on a nullable column is safe on Postgres: NULLs are never
 *   considered equal to each other under a standard btree unique index, so
 *   many rows can sit at `short_id IS NULL` simultaneously pre-backfill
 *   without violating uniqueness. Each per-entity task decides its own
 *   backfill approach (a `state-ops`-kind task per
 *   `operational-safety-dry-run-first.mdc`, since backfilling every
 *   existing row is a bulk shared-state mutation over the >10-row
 *   threshold).
 *
 * - **UNIQUE INDEX, not a table-level UNIQUE CONSTRAINT.** Functionally
 *   equivalent for this column (Postgres implements a UNIQUE constraint via
 *   a unique index anyway), but declaring it as an explicit named index
 *   keeps the door open for a later partial-index swap
 *   (`WHERE short_id IS NOT NULL`) — which Drizzle's schema DSL cannot
 *   express directly (see `ask-schema.ts`'s note on `asks_window_idx` for
 *   the established precedent of hand-writing a partial index in the raw
 *   migration SQL when needed) — as a pure migration-file change with no
 *   schema-file rename, because the index name stays the same.
 *
 * - **Concurrency / uniqueness enforcement lives at the DB layer.**
 *   `nextShortId` (the minting util) is a pure function with no I/O — it
 *   does not itself prevent two concurrent writers from proposing the same
 *   id. The unique index this helper adds is what turns a TOCTOU collision
 *   into a clean `onConflictDoNothing()` no-op the caller can detect and
 *   retry against — the exact pattern `MinskyTaskBackend.tryInsertTask`
 *   already uses for `mt#NNNN` (see `nextShortId`'s doc comment for the
 *   full justification, including why a DB advisory lock was rejected).
 *
 * - **Column type is `text`, not a domain-specific fixed-width type.**
 *   Matches the existing convention across this schema directory (e.g.
 *   `ask-schema.ts`'s `title`/`question`, `memory-embeddings.ts`'s `name`) —
 *   short ids have no fixed max length worth constraining at the column
 *   level; the `<prefix>#<n>` shape is enforced at the application layer
 *   (`short-id.ts`'s `parseShortId`/`formatShortId`), not a DB CHECK
 *   constraint, since a CHECK regex would need per-entity-prefix
 *   duplication with no correctness benefit over app-layer validation.
 *
 * @see mt#2963 — this file's originating task (shared foundation)
 * @see mt#2946 — umbrella (numeric short ids for ask/memory/session)
 * @see docs/architecture/adr-029-numeric-short-ids-foundation.md — full decision record
 * @see ../../utils/short-id.ts — the minting util this column's values come from
 * @see ../../utils/id-prefix-resolver.ts — the resolution util this column is looked up by
 */

import { text, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";

/** The physical Postgres column name every entity's short-id column must use. */
export const SHORT_ID_COLUMN_NAME = "short_id" as const;

/**
 * The `short_id` column definition: nullable text, no default.
 *
 * Assign it directly into a `pgTable(...)` column map, e.g.
 * `shortId: shortIdColumn()`. The TypeScript field name (`shortId`) is the
 * consuming table's choice — only the physical column name
 * (`SHORT_ID_COLUMN_NAME`, `"short_id"`) is fixed by this helper, so every
 * entity's Drizzle-inferred row type exposes the same camelCase accessor
 * regardless of which table it's on.
 */
export function shortIdColumn() {
  return text(SHORT_ID_COLUMN_NAME);
}

/**
 * The unique index definition for a table's short-id column.
 *
 * Call this inside the table's index-builder callback (the third argument
 * to `pgTable`), passing the table's own name (for a consistently-named
 * index: `idx_<tableName>_short_id_unique`) and the column reference
 * (`table.shortId`, i.e. whatever field name you gave `shortIdColumn()`
 * above).
 */
export function shortIdUniqueIndex(tableName: string, shortIdCol: AnyPgColumn) {
  return uniqueIndex(`idx_${tableName}_short_id_unique`).on(shortIdCol);
}
