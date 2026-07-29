import { describe, test, expect } from "bun:test";
import {
  detectMigrationGuardViolations,
  isMigrationGuardOverrideTruthy,
  MIGRATION_GUARD_CHECK_OVERRIDE_ENV,
} from "./migration-guard-detector";

const FILE = "packages/domain/src/storage/migrations/pg/0099_test_migration.sql";

describe("detectMigrationGuardViolations", () => {
  test("flags an unguarded DROP INDEX", () => {
    const sql = `DROP INDEX "idx_foo";--> statement-breakpoint\n`;
    const violations = detectMigrationGuardViolations(FILE, sql);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      filePath: FILE,
      line: 1,
      kind: "drop-index-missing-if-exists",
    });
  });

  test("does not flag a guarded DROP INDEX IF EXISTS", () => {
    const sql = `DROP INDEX IF EXISTS "idx_foo";--> statement-breakpoint\n`;
    expect(detectMigrationGuardViolations(FILE, sql)).toHaveLength(0);
  });

  test("does not flag DROP INDEX CONCURRENTLY IF EXISTS", () => {
    const sql = `DROP INDEX CONCURRENTLY IF EXISTS "idx_foo";--> statement-breakpoint\n`;
    expect(detectMigrationGuardViolations(FILE, sql)).toHaveLength(0);
  });

  test("flags an unguarded CREATE UNIQUE INDEX", () => {
    const sql = `CREATE UNIQUE INDEX "idx_bar" ON "t" ("c");--> statement-breakpoint\n`;
    const violations = detectMigrationGuardViolations(FILE, sql);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      filePath: FILE,
      line: 1,
      kind: "create-unique-index-missing-if-not-exists",
    });
  });

  test("does not flag a guarded CREATE UNIQUE INDEX IF NOT EXISTS", () => {
    const sql = `CREATE UNIQUE INDEX IF NOT EXISTS "idx_bar" ON "t" ("c");--> statement-breakpoint\n`;
    expect(detectMigrationGuardViolations(FILE, sql)).toHaveLength(0);
  });

  test("skips commented-out documentation lines", () => {
    const sql = `-- Manual rollback:\n--   DROP INDEX idx_foo;\n`;
    expect(detectMigrationGuardViolations(FILE, sql)).toHaveLength(0);
  });

  test("does not flag a plain (non-unique) CREATE INDEX", () => {
    const sql = `CREATE INDEX "idx_bar" ON "t" ("c");--> statement-breakpoint\n`;
    expect(detectMigrationGuardViolations(FILE, sql)).toHaveLength(0);
  });

  test("reports multiple violations across lines", () => {
    const sql = [
      `DROP INDEX "idx_one";--> statement-breakpoint`,
      `CREATE UNIQUE INDEX "idx_two" ON "t" ("c");--> statement-breakpoint`,
    ].join("\n");
    const violations = detectMigrationGuardViolations(FILE, sql);
    expect(violations).toHaveLength(2);
    expect(violations[0]?.line).toBe(1);
    expect(violations[1]?.line).toBe(2);
  });
});

describe("isMigrationGuardOverrideTruthy", () => {
  test("recognizes truthy values", () => {
    expect(isMigrationGuardOverrideTruthy("1")).toBe(true);
    expect(isMigrationGuardOverrideTruthy("true")).toBe(true);
    expect(isMigrationGuardOverrideTruthy("YES")).toBe(true);
  });

  test("rejects falsy/undefined values", () => {
    expect(isMigrationGuardOverrideTruthy(undefined)).toBe(false);
    expect(isMigrationGuardOverrideTruthy("0")).toBe(false);
    expect(isMigrationGuardOverrideTruthy("")).toBe(false);
  });

  test("exports the expected override env-var name", () => {
    expect(MIGRATION_GUARD_CHECK_OVERRIDE_ENV).toBe("MINSKY_SKIP_MIGRATION_GUARD_CHECK");
  });
});
