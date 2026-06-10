/**
 * Tests for mt#1967's post-migration self-check.
 *
 * The integration test that exercises applyMigrations() end-to-end against
 * a real Postgres is out of scope for unit tests (covered by the
 * reconcile-schema.ts script's dry-run path). These unit tests pin the
 * exported contract — REVIEWER_EXPECTED_TABLES, the dedicated table name,
 * and the verifyExpectedTables() behavior against a stub DB.
 */

import { describe, test, expect } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  REVIEWER_EXPECTED_TABLES,
  REVIEWER_MIGRATIONS_TABLE,
  REVIEWER_MIGRATIONS_SCHEMA,
  REVIEWER_TABLES_SCHEMA,
  buildExpectedTablesQuery,
  verifyExpectedTables,
} from "./migrate";
import type { ReviewerDb } from "./client";

/**
 * Build a minimal stub DB whose `execute()` returns a configurable result
 * set. Only the columns verifyExpectedTables() reads (`tablename`) need
 * to be present.
 */
function stubDbReturning(rows: { tablename: string }[]): ReviewerDb {
  return {
    execute: async (_query: unknown) => rows,
  } as unknown as ReviewerDb;
}

describe("mt#1967 self-check exports", () => {
  test("REVIEWER_EXPECTED_TABLES lists all reviewer tables in migration order", () => {
    expect(REVIEWER_EXPECTED_TABLES).toEqual([
      "reviewer_convergence_metrics",
      "reviewer_webhook_events",
      "reviewer_inflight_reviews",
      "review_timing",
      "reviewer_submission_failures",
    ]);
  });

  test("REVIEWER_MIGRATIONS_TABLE is the service-scoped tracking table", () => {
    // The dedicated name is the load-bearing fix; main Minsky uses the
    // default `__drizzle_migrations`. Renaming this constant breaks the
    // silent-skip fix unless the new name is also reflected in the
    // production tracking table.
    expect(REVIEWER_MIGRATIONS_TABLE).toBe("__drizzle_migrations_reviewer");
  });

  test("REVIEWER_MIGRATIONS_SCHEMA stays in the drizzle schema (table name is the discriminator)", () => {
    expect(REVIEWER_MIGRATIONS_SCHEMA).toBe("drizzle");
  });
});

describe("mt#1967 verifyExpectedTables", () => {
  test("resolves silently when all expected tables are present", async () => {
    const db = stubDbReturning(REVIEWER_EXPECTED_TABLES.map((tablename) => ({ tablename })));
    // Should not throw.
    await verifyExpectedTables(db);
  });

  test("throws with structured message when one expected table is missing", async () => {
    // Simulate missing reviewer_webhook_events specifically — the mt#1967
    // originating case (42P01 on insert into that table).
    const db = stubDbReturning([
      { tablename: "reviewer_convergence_metrics" },
      { tablename: "reviewer_inflight_reviews" },
      { tablename: "review_timing" },
      { tablename: "reviewer_submission_failures" },
    ]);
    await expect(verifyExpectedTables(db)).rejects.toThrow(/self-check FAILED/);
    await expect(verifyExpectedTables(db)).rejects.toThrow(/1 expected/);
    await expect(verifyExpectedTables(db)).rejects.toThrow(/reviewer_webhook_events/);
    // Diagnostic must point operators at the tracking table and runbook.
    await expect(verifyExpectedTables(db)).rejects.toThrow(new RegExp(REVIEWER_MIGRATIONS_TABLE));
    await expect(verifyExpectedTables(db)).rejects.toThrow(/services\/reviewer\/DEPLOY\.md/);
  });

  test("throws listing all missing tables when none are present (fresh DB case)", async () => {
    const db = stubDbReturning([]);
    await expect(verifyExpectedTables(db)).rejects.toThrow(/5 expected/);
    for (const expectedTable of REVIEWER_EXPECTED_TABLES) {
      await expect(verifyExpectedTables(db)).rejects.toThrow(new RegExp(expectedTable));
    }
  });
});

describe("mt#2008 buildExpectedTablesQuery SQL shape", () => {
  // Regression coverage for the production crash on commit fb96637a33 / mt#1967
  // (PR #1197): drizzle-orm's `sql` template spreads a JS array passed inside
  // `ANY(${arr})` into separate parameters with surrounding parens, producing
  // `ANY(($2, $3, $4))`. PostgreSQL interprets the inner parens as a record /
  // composite type (not an array), rejects the query (42601), the reviewer
  // service's migrate handler throws, server.ts exits 1, Railway respawns,
  // and the service crash-loops. The fix switches to `IN (...)` with
  // `sql.join` so the compiled SQL is unambiguously valid Postgres.
  const dialect = new PgDialect();

  test("compiled SQL uses IN (...) form, never ANY((...))", () => {
    const compiled = dialect.sqlToQuery(
      buildExpectedTablesQuery(REVIEWER_TABLES_SCHEMA, REVIEWER_EXPECTED_TABLES)
    );
    // The pre-mt#2008 bug pattern: `ANY(($2, $3, ...))` — the doubled
    // open-paren is what PostgreSQL reads as a record/composite type.
    expect(compiled.sql).not.toMatch(/ANY\s*\(\s*\(/);
    // The fix pattern: `IN ($2, $3, $4)`.
    expect(compiled.sql).toMatch(/tablename\s+IN\s*\(\s*\$/);
  });

  test("schema + every expected table name appears in the parameter list", () => {
    const compiled = dialect.sqlToQuery(
      buildExpectedTablesQuery(REVIEWER_TABLES_SCHEMA, REVIEWER_EXPECTED_TABLES)
    );
    // 1 schema param + N table params = N+1 total.
    expect(compiled.params).toHaveLength(1 + REVIEWER_EXPECTED_TABLES.length);
    expect(compiled.params[0]).toBe(REVIEWER_TABLES_SCHEMA);
    for (const expectedTable of REVIEWER_EXPECTED_TABLES) {
      expect(compiled.params).toContain(expectedTable);
    }
  });

  test("regression: compiled SQL does NOT match the pre-mt#2008 ANY(record) shape", () => {
    // Belt-and-suspenders: the exact failing-query pattern observed in the
    // 2026-05-21 production Railway logs was
    //   `tablename = ANY(($2, $3, $4))`
    // — equality + record-type-as-ANY-operand. Assert neither component is
    // present.
    const compiled = dialect.sqlToQuery(
      buildExpectedTablesQuery(REVIEWER_TABLES_SCHEMA, REVIEWER_EXPECTED_TABLES)
    );
    expect(compiled.sql).not.toMatch(/tablename\s*=\s*ANY/);
    expect(compiled.sql).not.toMatch(/ANY\s*\(\s*\(\s*\$/);
  });
});
