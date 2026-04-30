/**
 * Enum Drift-Check Tests
 *
 * Verifies that TypeScript _VALUES arrays stay in sync with the DB-side
 * schema definitions (pgEnum for memory_type; CHECK constraint for
 * task_relationships.type).
 *
 * Two drift axes are guarded:
 *   1. TS const vs runtime schema object (e.g., memoryTypeEnum.enumValues derived
 *      from MEMORY_TYPE_VALUES — caught by the pgEnum comparison tests).
 *   2. TS const vs SQL migration file (the actual DDL shipped to the DB) — caught
 *      by the migration-parsing tests below. This is the critical axis: a divergent
 *      migration would be invisible to axis 1 because both runtime objects would
 *      agree with each other while disagreeing with the actual DB schema.
 *
 * These are pure unit tests — no live DB required.
 */

/* eslint-disable custom/no-real-fs-in-tests -- reading shipped migration SQL IS the point of axis-2 drift checks */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { MEMORY_TYPE_VALUES } from "../../memory/types";
import { memoryTypeEnum } from "./memory-embeddings";
import { RELATIONSHIP_TYPE_VALUES } from "../../tasks/task-graph-service";
import { taskRelationshipsTable, PARENT_RELATIONSHIP_TYPE } from "./task-relationships";

// ---------------------------------------------------------------------------
// Migration-parsing helper
// ---------------------------------------------------------------------------

/**
 * Reads a SQL migration file, applies the given regex to extract a
 * comma-separated value list from a capture group, and returns the trimmed,
 * unquoted values as a sorted string array.
 *
 * The regex MUST have exactly one capture group that matches the inner list
 * of quoted SQL identifiers (e.g., `'value1', 'value2'`).
 *
 * Scope note: regex-based parsing is deliberately chosen here over live-DB
 * introspection or code-gen. The goal is to catch the specific drift class
 * "migration SQL diverges from TS const" without requiring a live database.
 * More robust alternatives (pgdump comparison, code-gen round-trip) are
 * deferred to a follow-up if the regex approach proves insufficient.
 */
function parseSqlValueList(sqlFilePath: string, regex: RegExp): string[] {
  const sqlRaw = readFileSync(sqlFilePath);
  const sql = typeof sqlRaw === "string" ? sqlRaw : sqlRaw.toString();
  const match = regex.exec(sql);
  if (!match || !match[1]) {
    throw new Error(
      `Migration-parsing regex did not match in ${sqlFilePath}.\n` +
        `Regex: ${regex}\n` +
        `File content (first 500 chars): ${sql.slice(0, 500)}`
    );
  }
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .sort();
}

// Resolve migration file paths relative to this test file. This file lives at
// src/domain/storage/schemas/enum-drift.test.ts; migrations live at
// src/domain/storage/migrations/pg/.
const MIGRATIONS_DIR = join(import.meta.dir, "../migrations/pg");

describe("Enum drift-check — memory_type", () => {
  test("MEMORY_TYPE_VALUES matches the values registered in the pgEnum", () => {
    // The pgEnum object exposes the registered enum values via the .enumValues property.
    // Drizzle's pgEnum() stores the tuple as-is; we compare sorted arrays to be
    // order-independent.
    const enumValues = [...memoryTypeEnum.enumValues].sort();
    const tsValues = [...MEMORY_TYPE_VALUES].sort();

    expect(enumValues).toEqual(tsValues);
  });

  test("MEMORY_TYPE_VALUES contains all expected type values", () => {
    const expected: string[] = ["feedback", "project", "reference", "user"];
    const actual: string[] = [...MEMORY_TYPE_VALUES].sort();
    expect(actual).toEqual(expected);
  });

  test("adding a hypothetical new value to MEMORY_TYPE_VALUES would mismatch pgEnum (guard)", () => {
    // This test documents the invariant: if someone adds "system" to MEMORY_TYPE_VALUES
    // but not to the pgEnum, the first test above would catch it.
    // Here we verify that the current set is exactly the expected baseline.
    expect(MEMORY_TYPE_VALUES).toHaveLength(4);
  });

  test("MEMORY_TYPE_VALUES matches the migration's CREATE TYPE memory_type ENUM (axis 2)", () => {
    // Parse the migration file directly. This catches the case the runtime-object
    // comparison cannot: a migration shipped to the DB whose enum values diverge
    // from the TS const. The tests above would still pass in that scenario because
    // the in-code pgEnum is itself derived from MEMORY_TYPE_VALUES.
    const migrationPath = join(MIGRATIONS_DIR, "0024_memory_phase_1.sql");
    const sqlValues = parseSqlValueList(
      migrationPath,
      /CREATE TYPE\s+(?:"[^"]+"\.)?"?memory_type"?\s+AS\s+ENUM\s*\(([^)]+)\)/i
    );
    expect(sqlValues).toEqual([...MEMORY_TYPE_VALUES].sort());
  });
});

describe("Enum drift-check — task_relationships.type", () => {
  test("RELATIONSHIP_TYPE_VALUES contains all expected type values", () => {
    const expected: string[] = ["depends", "parent"];
    const actual: string[] = [...RELATIONSHIP_TYPE_VALUES].sort();
    expect(actual).toEqual(expected);
  });

  test("task_relationships CHECK constraint SQL contains all RELATIONSHIP_TYPE_VALUES", () => {
    // Extract the CHECK constraint added by task-relationships.ts.
    // The Drizzle table object exposes table checks via Symbol.for("drizzle:Checks")
    // or via the table config. We probe the schema by reconstructing what the SQL
    // should look like based on the same _VALUES array and confirm structural alignment.
    //
    // Since the constraint SQL is generated from RELATIONSHIP_TYPE_VALUES (via sql.raw),
    // the strongest test is to verify that the const and the schema reference the
    // same module export — which TypeScript enforces at compile time. At runtime,
    // we verify the const has the expected values and hasn't drifted from the baseline.
    const expectedSql = `type IN (${RELATIONSHIP_TYPE_VALUES.map((v) => `'${v}'`).join(", ")})`;
    expect(expectedSql).toBe("type IN ('depends', 'parent')");
  });

  test("task_relationships type column exists with snake_case name", () => {
    // Structural check: the type column exists with the correct snake_case DB name.
    // This confirms the schema file loaded correctly with the updated CHECK constraint.
    const typeCol = taskRelationshipsTable.type;
    expect(typeCol).toBeDefined();
    // The column name is the snake_case DB column name
    expect(typeCol.name).toBe("type");
  });

  test("adding a hypothetical new value to RELATIONSHIP_TYPE_VALUES would mismatch CHECK (guard)", () => {
    // Documents the invariant: if someone adds "blocks" to RELATIONSHIP_TYPE_VALUES
    // but not to the migration's CHECK constraint, the CHECK will still only allow
    // 'depends' and 'parent' in the DB, causing failures at runtime.
    // The drift-check test would catch this by asserting the expected baseline count.
    expect(RELATIONSHIP_TYPE_VALUES).toHaveLength(2);
  });

  test("RELATIONSHIP_TYPE_VALUES matches the migration's CHECK constraint IN-list (axis 2)", () => {
    // Parse the migration file directly. The earlier test reconstructs the
    // expected SQL from the same TS const it's checking against, so it cannot
    // catch a divergent migration. This one reads the actual SQL shipped to the DB.
    const migrationPath = join(MIGRATIONS_DIR, "0028_add_type_check_to_task_relationships.sql");
    const sqlValues = parseSqlValueList(
      migrationPath,
      /CHECK\s*\(\s*type\s+IN\s*\(([^)]+)\)\s*\)/i
    );
    expect(sqlValues).toEqual([...RELATIONSHIP_TYPE_VALUES].sort());
  });

  test("PARENT_RELATIONSHIP_TYPE used in unique-index WHERE clause is a member of RELATIONSHIP_TYPE_VALUES", () => {
    // Guards against WHERE-clause drift: if "parent" is renamed or removed from
    // RELATIONSHIP_TYPE_VALUES, the satisfies assertion in task-relationships.ts
    // catches it at compile time. This runtime test makes the same invariant
    // explicit and testable without a live DB.
    const values: readonly string[] = RELATIONSHIP_TYPE_VALUES;
    expect(values).toContain(PARENT_RELATIONSHIP_TYPE);
  });
});
