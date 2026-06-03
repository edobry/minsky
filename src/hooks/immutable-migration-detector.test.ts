import { describe, test, expect } from "bun:test";
import {
  detectImmutableMigrationViolations,
  extractTagFromFilename,
  isImmutableMigrationOverrideTruthy,
  IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV,
  MIGRATION_DIRS,
  MODIFICATION_DIFF_FILTER,
} from "./immutable-migration-detector";

// ─── helpers ─────────────────────────────────────────────────────────────────

const PG_DIR = "packages/domain/src/storage/migrations/pg";
const SQLITE_DIR = "packages/domain/src/storage/migrations";

// Migration tags reused across cases — extracted to satisfy no-magic-string-duplication.
const TAG_DAPPER = "0014_dapper_changeling";
const TAG_CHARMING = "0000_charming_smasher";
const TAG_PRIMA = "0000_unusual_prima";

/** Build a Map<filePath, diffStatus> from a list of [path, status] pairs. */
function staged(...entries: Array<[string, string]>): ReadonlyMap<string, string> {
  return new Map(entries);
}

/** Build a Map<dir, Set<tag>> used as journalTagsByDir. */
function journal(dir: string, ...tags: string[]): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map([[dir, new Set(tags)]]);
}

// ─── extractTagFromFilename ───────────────────────────────────────────────────

describe("extractTagFromFilename", () => {
  test("returns tag for a standard migration filename", () => {
    expect(extractTagFromFilename("0014_dapper_changeling.sql")).toBe(TAG_DAPPER);
    expect(extractTagFromFilename("0000_charming_smasher.sql")).toBe(TAG_CHARMING);
    expect(extractTagFromFilename("0045_new_thing.sql")).toBe("0045_new_thing");
  });

  test("returns null for a file without .sql extension", () => {
    expect(extractTagFromFilename("0014_dapper_changeling.ts")).toBeNull();
    expect(extractTagFromFilename("README.md")).toBeNull();
    expect(extractTagFromFilename("migration")).toBeNull();
  });

  test("handles minimal filename (just an extension)", () => {
    expect(extractTagFromFilename(".sql")).toBe("");
  });
});

// ─── isImmutableMigrationOverrideTruthy ──────────────────────────────────────

describe("isImmutableMigrationOverrideTruthy", () => {
  test("returns false for undefined and empty string", () => {
    expect(isImmutableMigrationOverrideTruthy(undefined)).toBe(false);
    expect(isImmutableMigrationOverrideTruthy("")).toBe(false);
  });

  test("returns true for canonical truthy values", () => {
    expect(isImmutableMigrationOverrideTruthy("1")).toBe(true);
    expect(isImmutableMigrationOverrideTruthy("true")).toBe(true);
    expect(isImmutableMigrationOverrideTruthy("TRUE")).toBe(true);
    expect(isImmutableMigrationOverrideTruthy("True")).toBe(true);
    expect(isImmutableMigrationOverrideTruthy("yes")).toBe(true);
    expect(isImmutableMigrationOverrideTruthy("YES")).toBe(true);
    expect(isImmutableMigrationOverrideTruthy("Yes")).toBe(true);
  });

  test("returns false for non-truthy values", () => {
    expect(isImmutableMigrationOverrideTruthy("0")).toBe(false);
    expect(isImmutableMigrationOverrideTruthy("false")).toBe(false);
    expect(isImmutableMigrationOverrideTruthy("no")).toBe(false);
    expect(isImmutableMigrationOverrideTruthy("nope")).toBe(false);
    expect(isImmutableMigrationOverrideTruthy("maybe")).toBe(false);
  });

  test("override env var name matches the documented constant", () => {
    expect(IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV).toBe("MINSKY_SKIP_IMMUTABLE_MIGRATION_CHECK");
  });
});

// ─── constants ───────────────────────────────────────────────────────────────

describe("constants", () => {
  test("MODIFICATION_DIFF_FILTER is 'M'", () => {
    expect(MODIFICATION_DIFF_FILTER).toBe("M");
  });

  test("MIGRATION_DIRS includes pg and sqlite directories", () => {
    expect(MIGRATION_DIRS).toContain("packages/domain/src/storage/migrations/pg");
    expect(MIGRATION_DIRS).toContain("packages/domain/src/storage/migrations");
  });
});

// ─── detectImmutableMigrationViolations — core scenarios ─────────────────────

describe("detectImmutableMigrationViolations", () => {
  // AT: Editing a journaled migration file → blocked
  test("modification to journaled pg migration is flagged (acceptance test)", () => {
    const modifications = staged([`${PG_DIR}/0014_dapper_changeling.sql`, "M"]);
    const journals = journal(PG_DIR, TAG_DAPPER);

    const violations = detectImmutableMigrationViolations(modifications, journals);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      filePath: `${PG_DIR}/0014_dapper_changeling.sql`,
      tag: TAG_DAPPER,
      migrationDir: PG_DIR,
    });
  });

  // AT: Adding a new migration file → allowed
  test("addition of a new pg migration file is allowed (acceptance test)", () => {
    const modifications = staged([`${PG_DIR}/0045_new_thing.sql`, "A"]);
    const journals = journal(PG_DIR, TAG_CHARMING, "0001_true_nocturne");

    const violations = detectImmutableMigrationViolations(modifications, journals);

    expect(violations).toHaveLength(0);
  });

  // Modification of a file whose tag is NOT in the journal → allowed
  test("modification to unjournaled (never-applied) migration is allowed", () => {
    const modifications = staged([`${PG_DIR}/0045_new_thing.sql`, "M"]);
    // 0045 not in journal
    const journals = journal(PG_DIR, TAG_CHARMING, TAG_DAPPER);

    const violations = detectImmutableMigrationViolations(modifications, journals);

    expect(violations).toHaveLength(0);
  });

  // Non-.sql files inside migration dir → ignored
  test("non-SQL files in the migration directory are ignored", () => {
    const modifications = staged([`${PG_DIR}/meta/_journal.json`, "M"]);
    const journals = journal(PG_DIR, TAG_CHARMING);

    const violations = detectImmutableMigrationViolations(modifications, journals);

    expect(violations).toHaveLength(0);
  });

  // Deletion of a journaled file → allowed (not a modification)
  test("deletion of a journaled migration is not flagged", () => {
    const modifications = staged([`${PG_DIR}/0014_dapper_changeling.sql`, "D"]);
    const journals = journal(PG_DIR, TAG_DAPPER);

    const violations = detectImmutableMigrationViolations(modifications, journals);

    expect(violations).toHaveLength(0);
  });

  // File outside migration dirs → ignored
  test("SQL file outside monitored migration dirs is ignored", () => {
    const modifications = staged(["some/other/dir/0014_whatever.sql", "M"]);
    const journals = journal(PG_DIR, "0014_whatever");

    const violations = detectImmutableMigrationViolations(modifications, journals);

    expect(violations).toHaveLength(0);
  });

  // File inside a subdirectory of the migration dir → not matched as direct child
  test("SQL file in a subdirectory of migration dir is ignored", () => {
    // e.g. packages/domain/src/storage/migrations/pg/meta/something.sql
    const modifications = staged([`${PG_DIR}/meta/0014_dapper_changeling.sql`, "M"]);
    const journals = journal(PG_DIR, TAG_DAPPER);

    const violations = detectImmutableMigrationViolations(modifications, journals);

    expect(violations).toHaveLength(0);
  });

  // Empty staged set → no violations
  test("returns empty array when no files are staged", () => {
    const violations = detectImmutableMigrationViolations(new Map(), journal(PG_DIR));
    expect(violations).toHaveLength(0);
  });

  // Empty journal → no violations (no applied migrations)
  test("returns empty array when journal is empty (no applied migrations)", () => {
    const modifications = staged([`${PG_DIR}/0014_dapper_changeling.sql`, "M"]);
    const journals = journal(PG_DIR); // no tags

    const violations = detectImmutableMigrationViolations(modifications, journals);

    expect(violations).toHaveLength(0);
  });

  // No journal entry for the migration dir → no violations
  test("returns empty array when no journal exists for the migration dir", () => {
    const modifications = staged([`${PG_DIR}/0014_dapper_changeling.sql`, "M"]);
    // Provide journal for a different dir only
    const journals: ReadonlyMap<string, ReadonlySet<string>> = new Map([
      [SQLITE_DIR, new Set([TAG_PRIMA])],
    ]);

    const violations = detectImmutableMigrationViolations(modifications, journals);

    expect(violations).toHaveLength(0);
  });

  // Multiple violations across both migration dirs
  test("detects violations in both pg and sqlite migration dirs", () => {
    const modifications = staged(
      [`${PG_DIR}/0014_dapper_changeling.sql`, "M"],
      [`${SQLITE_DIR}/0000_unusual_prima.sql`, "M"],
      [`${PG_DIR}/0045_new_thing.sql`, "A"] // addition — allowed
    );
    const journals: ReadonlyMap<string, ReadonlySet<string>> = new Map([
      [PG_DIR, new Set([TAG_DAPPER])],
      [SQLITE_DIR, new Set([TAG_PRIMA])],
    ]);

    const violations = detectImmutableMigrationViolations(modifications, journals);

    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.tag === TAG_DAPPER)).toBe(true);
    expect(violations.some((v) => v.tag === TAG_PRIMA)).toBe(true);
  });

  // Mix of violations and clean modifications
  test("only flags journaled modifications — other staged files pass through", () => {
    const modifications = staged(
      [`${PG_DIR}/0014_dapper_changeling.sql`, "M"], // journaled — violation
      [`${PG_DIR}/0045_new_thing.sql`, "M"], // not journaled — allowed
      [`${PG_DIR}/0046_another.sql`, "A"], // addition — allowed
      ["src/foo.ts", "M"] // unrelated file
    );
    const journals = journal(PG_DIR, TAG_DAPPER);

    const violations = detectImmutableMigrationViolations(modifications, journals);

    expect(violations).toHaveLength(1);
    const first = violations[0];
    expect(first).toBeDefined();
    expect(first?.tag).toBe(TAG_DAPPER);
  });

  // The sqlite dir prefix should NOT incorrectly match pg-dir files
  test("sqlite dir does not swallow pg dir files (prefix ordering)", () => {
    // SQLITE_DIR is a prefix of PG_DIR, so this checks ordering correctness.
    // A file in PG_DIR should be associated with PG_DIR, not SQLITE_DIR.
    const modifications = staged([`${PG_DIR}/0014_dapper_changeling.sql`, "M"]);
    const journals: ReadonlyMap<string, ReadonlySet<string>> = new Map([
      [PG_DIR, new Set([TAG_DAPPER])],
      [SQLITE_DIR, new Set([TAG_DAPPER])], // tag present in both
    ]);

    const violations = detectImmutableMigrationViolations(modifications, journals);

    // Should find exactly one violation (matched against the first matching dir)
    expect(violations).toHaveLength(1);
    const first = violations[0];
    expect(first).toBeDefined();
    // The matched dir should be PG_DIR because the file lives there
    expect(first?.migrationDir).toBe(PG_DIR);
  });
});
