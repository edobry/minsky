/**
 * Tests for `computeMigrationFreshness` — the pure-logic verdict function
 * that decides whether `__drizzle_migrations` reflects the on-disk journal.
 *
 * See mt#1750: replaces a row-count-based check that was fragile to Supabase
 * transaction-pooler routing returning stale COUNT values.
 */

import { describe, test, expect } from "bun:test";
import { computeMigrationFreshness } from "./migration-freshness";

describe("computeMigrationFreshness", () => {
  describe("empty journal", () => {
    test("no files, no meta table → not pending", () => {
      const verdict = computeMigrationFreshness({
        latestJournalHash: undefined,
        latestJournalHashInDb: false,
        appliedCount: 0,
        fileCount: 0,
        metaTableExists: false,
      });
      expect(verdict.pending).toBe(false);
      expect(verdict.warnings).toEqual([]);
    });

    test("files exist but no meta table → pending (DB never migrated)", () => {
      const verdict = computeMigrationFreshness({
        latestJournalHash: undefined,
        latestJournalHashInDb: false,
        appliedCount: 0,
        fileCount: 5,
        metaTableExists: false,
      });
      expect(verdict.pending).toBe(true);
    });

    test("files exist with meta table but no journal → not pending (degenerate but stable)", () => {
      const verdict = computeMigrationFreshness({
        latestJournalHash: undefined,
        latestJournalHashInDb: false,
        appliedCount: 5,
        fileCount: 5,
        metaTableExists: true,
      });
      expect(verdict.pending).toBe(false);
    });
  });

  describe("nonempty journal", () => {
    test("meta table missing → pending", () => {
      const verdict = computeMigrationFreshness({
        latestJournalHash: "abc123",
        latestJournalHashInDb: false,
        appliedCount: 0,
        fileCount: 34,
        metaTableExists: false,
      });
      expect(verdict.pending).toBe(true);
    });

    test("hash IS in DB → not pending (the central success case)", () => {
      const verdict = computeMigrationFreshness({
        latestJournalHash: "abc123",
        latestJournalHashInDb: true,
        appliedCount: 34,
        fileCount: 34,
        metaTableExists: true,
      });
      expect(verdict.pending).toBe(false);
      expect(verdict.warnings).toEqual([]);
    });

    test("hash NOT in DB → pending (a genuine missing migration)", () => {
      const verdict = computeMigrationFreshness({
        latestJournalHash: "abc123",
        latestJournalHashInDb: false,
        appliedCount: 33,
        fileCount: 34,
        metaTableExists: true,
      });
      expect(verdict.pending).toBe(true);
    });
  });

  describe("hash-based check is invariant to stale-COUNT false positives (mt#1750)", () => {
    test("hash IS in DB but stale COUNT under-reports applied count → not pending", () => {
      // The original failure mode: applied=33 (stale), fileCount=34, would have
      // triggered "pending=true" under the old `applied < files` predicate. With
      // the hash-based check, the verdict is correctly "not pending" because the
      // journal's latest hash is in the DB.
      const verdict = computeMigrationFreshness({
        latestJournalHash: "abc123",
        latestJournalHashInDb: true,
        appliedCount: 33,
        fileCount: 34,
        metaTableExists: true,
      });
      expect(verdict.pending).toBe(false);
    });
  });

  describe("phantom rows (applied > fileCount)", () => {
    test("hash IS in DB but applied > files → not pending + warning", () => {
      const verdict = computeMigrationFreshness({
        latestJournalHash: "abc123",
        latestJournalHashInDb: true,
        appliedCount: 35,
        fileCount: 34,
        metaTableExists: true,
      });
      expect(verdict.pending).toBe(false);
      expect(verdict.warnings).toHaveLength(1);
      expect(verdict.warnings[0]).toContain("applied=35");
      expect(verdict.warnings[0]).toContain("files=34");
      expect(verdict.warnings[0]).toContain("delta=1");
      expect(verdict.warnings[0]).toContain("mt#1750");
    });

    test("hash NOT in DB AND applied > files → pending + warning", () => {
      const verdict = computeMigrationFreshness({
        latestJournalHash: "abc123",
        latestJournalHashInDb: false,
        appliedCount: 35,
        fileCount: 34,
        metaTableExists: true,
      });
      expect(verdict.pending).toBe(true);
      expect(verdict.warnings).toHaveLength(1);
    });

    test("equal counts → no warning", () => {
      const verdict = computeMigrationFreshness({
        latestJournalHash: "abc123",
        latestJournalHashInDb: true,
        appliedCount: 34,
        fileCount: 34,
        metaTableExists: true,
      });
      expect(verdict.warnings).toEqual([]);
    });
  });
});
