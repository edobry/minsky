/**
 * Pure logic for determining whether the database schema is up-to-date with
 * the on-disk migration journal.
 *
 * Replaces a row-count comparison (`applied < fileCount`) that was fragile to
 * Supabase transaction-pooler routing: the pooler can return a stale COUNT
 * from a lagged backend connection, producing false-positive "schema out of
 * date" errors that blocked every MCP tool call until the next retry happened
 * to hit a consistent backend.
 *
 * The hash-based check below is invariant to count fluctuations. It asks the
 * specific question that actually matters: "is the hash of the latest journal
 * entry's .sql file present in `__drizzle_migrations`?" If yes, the schema
 * matches what the journal expects; if no, a migration is genuinely missing.
 *
 * The `applied > files` case (phantom rows in `__drizzle_migrations` that
 * have no corresponding file) is surfaced as a warning rather than an error.
 * It indicates historical journal-timestamp edits, not a schema-staleness
 * problem.
 *
 * See mt#1750.
 */

export interface MigrationFreshnessInput {
  /** sha256(content) of the .sql file referenced by the journal's last entry.
   *  `undefined` when the journal has zero entries (fresh project). */
  latestJournalHash: string | undefined;
  /** Whether `latestJournalHash` is present in `drizzle.__drizzle_migrations.hash`. */
  latestJournalHashInDb: boolean;
  /** Row count from `SELECT COUNT(*) FROM drizzle.__drizzle_migrations`. */
  appliedCount: number;
  /** Number of `*.sql` files in the migrations folder. */
  fileCount: number;
  /** Whether `drizzle.__drizzle_migrations` exists. */
  metaTableExists: boolean;
}

export interface MigrationFreshnessVerdict {
  pending: boolean;
  warnings: string[];
}

/**
 * Compute whether migrations are pending based on hash-presence in the
 * `__drizzle_migrations` table, not on row-count comparison.
 *
 * Decision matrix:
 *
 * | journal | meta table | hash in DB | verdict                  |
 * | ------- | ---------- | ---------- | ------------------------ |
 * | empty   | missing    | n/a        | pending iff fileCount>0  |
 * | empty   | present    | n/a        | pending iff fileCount>0  |
 * | nonempty| missing    | n/a        | pending                  |
 * | nonempty| present    | yes        | NOT pending              |
 * | nonempty| present    | no         | pending                  |
 *
 * The `appliedCount > fileCount` case (phantom rows in DB) does not affect
 * the verdict — it emits a warning so operators can investigate but does not
 * block schema access.
 */
export function computeMigrationFreshness(
  input: MigrationFreshnessInput
): MigrationFreshnessVerdict {
  const warnings: string[] = [];

  if (input.appliedCount > input.fileCount) {
    const delta = input.appliedCount - input.fileCount;
    warnings.push(
      `Migration DB has more rows than on-disk files: applied=${input.appliedCount}, ` +
        `files=${input.fileCount} (delta=${delta}). Likely cause: historical journal-timestamp ` +
        `edits left phantom rows in drizzle.__drizzle_migrations. See mt#1750.`
    );
  }

  // No journal entries → no migrations defined. Pending only if files exist
  // without the meta table (i.e., the DB hasn't been migrated at all yet).
  if (input.latestJournalHash === undefined) {
    return { pending: input.fileCount > 0 && !input.metaTableExists, warnings };
  }

  // Journal has entries but the migration meta table doesn't exist → first run.
  if (!input.metaTableExists) {
    return { pending: true, warnings };
  }

  // Hash-based check: the journal's latest entry's hash must be present in the DB.
  return { pending: !input.latestJournalHashInDb, warnings };
}
