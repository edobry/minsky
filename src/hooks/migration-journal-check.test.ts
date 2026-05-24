import { describe, it, expect } from "bun:test";
import { detectMissingJournalEntries, type JournalEntry } from "./migration-journal-check";

function entry(idx: number, tag: string, when = 1700000000000 + idx * 86400000): JournalEntry {
  return { idx, tag, when };
}

describe("detectMissingJournalEntries", () => {
  it("returns success when SQL files and journal entries match exactly", () => {
    const sqlFiles = ["0000_init.sql", "0001_add_users.sql"];
    const journal = [entry(0, "0000_init"), entry(1, "0001_add_users")];
    const result = detectMissingJournalEntries(sqlFiles, journal);
    expect(result.success).toBe(true);
    expect(result.missingFromJournal).toEqual([]);
    expect(result.extraInJournal).toEqual([]);
  });

  it("detects SQL file without journal entry", () => {
    const sqlFiles = ["0000_init.sql", "0001_add_users.sql", "0002_orphan.sql"];
    const journal = [entry(0, "0000_init"), entry(1, "0001_add_users")];
    const result = detectMissingJournalEntries(sqlFiles, journal);
    expect(result.success).toBe(false);
    expect(result.missingFromJournal).toEqual(["0002_orphan"]);
    expect(result.message).toContain("invisible to migrator");
    expect(result.message).toContain("bun run db:generate:pg");
  });

  it("detects journal entry without SQL file", () => {
    const sqlFiles = ["0000_init.sql"];
    const journal = [entry(0, "0000_init"), entry(1, "0001_ghost")];
    const result = detectMissingJournalEntries(sqlFiles, journal);
    expect(result.success).toBe(false);
    expect(result.extraInJournal).toEqual(["0001_ghost"]);
    expect(result.message).toContain("orphaned");
  });

  it("detects both missing and extra simultaneously", () => {
    const sqlFiles = ["0000_init.sql", "0002_new.sql"];
    const journal = [entry(0, "0000_init"), entry(1, "0001_deleted")];
    const result = detectMissingJournalEntries(sqlFiles, journal);
    expect(result.success).toBe(false);
    expect(result.missingFromJournal).toEqual(["0002_new"]);
    expect(result.extraInJournal).toEqual(["0001_deleted"]);
  });

  it("handles empty inputs", () => {
    const result = detectMissingJournalEntries([], []);
    expect(result.success).toBe(true);
  });

  it("strips .sql extension when comparing", () => {
    const sqlFiles = ["0040_memory_associations.sql"];
    const journal = [entry(40, "0040_memory_associations")];
    const result = detectMissingJournalEntries(sqlFiles, journal);
    expect(result.success).toBe(true);
  });

  it("includes override env var name in failure message", () => {
    const sqlFiles = ["0000_init.sql", "0001_orphan.sql"];
    const journal = [entry(0, "0000_init")];
    const result = detectMissingJournalEntries(sqlFiles, journal);
    expect(result.message).toContain("MINSKY_SKIP_MIGRATION_JOURNAL_CHECK");
  });
});
