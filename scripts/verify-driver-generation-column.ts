#!/usr/bin/env bun
/**
 * mt#4456 AT4 — assert the LIVE database carries `driver_generation` (not the
 * pre-rename `actuator_generation`) on both tables that declare it.
 *
 * Read-only. Prints column NAMES only, never row data.
 *
 * ## Why this script exists rather than reusing the driven-session verifiers
 *
 * The obvious live probe cannot answer this question, and would report success
 * either way. `listNonTerminalDrivenSessions` issues `SELECT *` and maps the row
 * in JavaScript, so a column renamed out from under it yields `undefined` rather
 * than a database error; its `catch` then returns `[]` on any failure at all.
 * Run against a table that is merely EMPTY, the mapping never executes. So a
 * green run of that path is compatible with the column being absent, present, or
 * misspelled — it carries no information about which (mem#704's class).
 *
 * `information_schema` is the primary source for a question about column names,
 * so this asks it directly.
 *
 * ## When to run it
 *
 * Post-deploy, after migration 0104 has applied. Deploy-SUCCESS proves the
 * container started; it does not prove the DDL ran. Before 0104 applies this
 * script FAILS by design, naming the old column — that is the negative control,
 * and it was observed failing this way on 2026-08-23 before merge.
 *
 *   bun scripts/verify-driver-generation-column.ts
 *
 * Exit 0 = both tables carry `driver_generation`. Exit 1 = they do not, and the
 * output says what is there instead.
 */
import "reflect-metadata";

// The daemon initializes configuration at boot; a standalone script must do it
// explicitly, or the database resolves null and this reports on a table it never
// actually looked at.
const { initializeConfiguration, CustomConfigFactory } = await import(
  "@minsky/domain/configuration"
);
await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

const { getContextInspectorDb } = await import("../src/cockpit/db-providers");
const { sql } = await import("drizzle-orm");

const EXPECTED = "driver_generation";
const TABLES = ["driven_sessions", "driven_session_conversations"] as const;

const db = await getContextInspectorDb();
if (!db) {
  console.error("FAIL: no database handle — configuration did not resolve one.");
  process.exit(1);
}

let ok = true;

for (const table of TABLES) {
  const rows = Array.from(
    (await db.execute(
      sql`SELECT column_name FROM information_schema.columns
          WHERE table_name = ${table} AND column_name LIKE '%generation%'
          ORDER BY column_name`
    )) as Iterable<Record<string, unknown>>
  );
  const names = rows.map((r) => String(r.column_name));

  if (names.length === 0) {
    console.error(`FAIL ${table}: no *generation* column at all — is the table present?`);
    ok = false;
    continue;
  }
  if (names.includes(EXPECTED)) {
    console.log(`ok   ${table}: ${EXPECTED}`);
    continue;
  }
  console.error(`FAIL ${table}: expected ${EXPECTED}, found ${names.join(", ")}`);
  ok = false;
}

if (!ok) {
  console.error("\nMigration 0104 has not applied to this database.");
  process.exit(1);
}
console.log("\nBoth tables carry driver_generation.");
process.exit(0);
