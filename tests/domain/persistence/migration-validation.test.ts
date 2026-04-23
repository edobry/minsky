/**
 * Migration Validation Tests
 *
 * Unit tests for the pure validation functions used to guard
 * the Postgres migration layer.
 */

import { describe, it, expect } from "bun:test";
import {
  validateJournalTimestamps,
  assertMigrationCountMatch,
} from "../../../src/domain/persistence/postgres-migration-operations";
import type {
  Journal,
  JournalEntry,
} from "../../../src/domain/persistence/postgres-migration-operations";

// Shared migration tags used across the test journal fixtures.
const MIGRATION_A = "0000_migration_a";
const MIGRATION_B = "0001_migration_b";
const MIGRATION_C = "0002_migration_c";

// Helper to build a minimal Journal for tests
function makeJournal(entries: Array<{ idx: number; when: number; tag: string }>): Journal {
  return {
    version: "7",
    dialect: "postgresql",
    entries: entries.map(
      (e): JournalEntry => ({
        idx: e.idx,
        version: "7",
        when: e.when,
        tag: e.tag,
        breakpoints: true,
      })
    ),
  };
}

describe("validateJournalTimestamps", () => {
  it("accepts valid monotonically increasing timestamps", () => {
    const journal = makeJournal([
      { idx: 0, when: 100, tag: MIGRATION_A },
      { idx: 1, when: 200, tag: MIGRATION_B },
      { idx: 2, when: 300, tag: MIGRATION_C },
    ]);
    expect(() => validateJournalTimestamps(journal)).not.toThrow();
  });

  it("throws on out-of-order timestamps", () => {
    const journal = makeJournal([
      { idx: 0, when: 100, tag: MIGRATION_A },
      { idx: 1, when: 300, tag: MIGRATION_B },
      { idx: 2, when: 200, tag: MIGRATION_C },
    ]);
    expect(() => validateJournalTimestamps(journal)).toThrow(
      /timestamps out of order.*0001_migration_b.*0002_migration_c/s
    );
  });

  it("throws on equal timestamps", () => {
    const journal = makeJournal([
      { idx: 0, when: 100, tag: MIGRATION_A },
      { idx: 1, when: 200, tag: MIGRATION_B },
      { idx: 2, when: 200, tag: MIGRATION_C },
    ]);
    expect(() => validateJournalTimestamps(journal)).toThrow(/timestamps out of order/);
  });

  it("accepts single entry journal", () => {
    const journal = makeJournal([{ idx: 0, when: 100, tag: MIGRATION_A }]);
    expect(() => validateJournalTimestamps(journal)).not.toThrow();
  });

  it("accepts empty journal", () => {
    const journal = makeJournal([]);
    expect(() => validateJournalTimestamps(journal)).not.toThrow();
  });
});

describe("assertMigrationCountMatch", () => {
  it("passes when counts match", () => {
    expect(() => assertMigrationCountMatch(5, 5)).not.toThrow();
  });

  it("throws when DB count is less than journal count", () => {
    expect(() => assertMigrationCountMatch(3, 5)).toThrow(
      /2 migration\(s\) may have been silently skipped/
    );
  });

  it("throws when DB count is greater than journal count", () => {
    expect(() => assertMigrationCountMatch(5, 3)).toThrow(/Migration count mismatch/);
  });
});
