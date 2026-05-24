/**
 * Migration Journal Consistency Check (mt#2087)
 *
 * Validates that every SQL migration file under the pg migrations folder
 * has a corresponding entry in `meta/_journal.json`. Prevents the class
 * of failure where a hand-written SQL file ships without a journal entry,
 * making it invisible to Drizzle's migrator (mt#2086 incident).
 *
 * Pure-function implementation — no side effects, no filesystem access.
 * The pre-commit pipeline calls `detectMissingJournalEntries()` with
 * the data it reads from disk.
 */

export const MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV = "MINSKY_SKIP_MIGRATION_JOURNAL_CHECK";

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export interface MigrationJournalCheckResult {
  success: boolean;
  sqlFiles: string[];
  journalEntries: string[];
  missingFromJournal: string[];
  extraInJournal: string[];
  message: string;
}

/**
 * Compare SQL file stems against journal entry tags.
 *
 * @param sqlFileNames - basenames of `.sql` files (e.g., `["0040_memory_associations.sql"]`)
 * @param journalEntries - parsed entries from `_journal.json`
 * @returns check result with any mismatches
 */
export function detectMissingJournalEntries(
  sqlFileNames: string[],
  journalEntries: JournalEntry[]
): MigrationJournalCheckResult {
  const sqlStems = new Set(sqlFileNames.map((f) => f.replace(/\.sql$/, "")));
  const journalTags = new Set(journalEntries.map((e) => e.tag));

  const missingFromJournal = [...sqlStems].filter((s) => !journalTags.has(s)).sort();
  const extraInJournal = [...journalTags].filter((t) => !sqlStems.has(t)).sort();

  const success = missingFromJournal.length === 0 && extraInJournal.length === 0;

  let message: string;
  if (success) {
    message = `Migration journal consistent: ${sqlFileNames.length} SQL files, ${journalEntries.length} journal entries.`;
  } else {
    const parts: string[] = [];
    if (missingFromJournal.length > 0) {
      parts.push(
        `SQL files WITHOUT journal entries (invisible to migrator):\n${missingFromJournal
          .map((s) => `  - ${s}.sql`)
          .join("\n")}\n\nFix: run \`bun run db:generate:pg\` instead of hand-writing SQL files.` +
          `\nSee .minsky/rules/migration-authoring.mdc for the canonical workflow.`
      );
    }
    if (extraInJournal.length > 0) {
      parts.push(
        `Journal entries WITHOUT SQL files (orphaned):\n${extraInJournal
          .map((t) => `  - ${t}`)
          .join("\n")}`
      );
    }
    message = `Migration journal inconsistency detected (mt#2087):\n\n${parts.join(
      "\n\n"
    )}\n\nOverride: set ${MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV}=1 (audit-logged).`;
  }

  return {
    success,
    sqlFiles: [...sqlStems].sort(),
    journalEntries: [...journalTags].sort(),
    missingFromJournal,
    extraInJournal,
    message,
  };
}
