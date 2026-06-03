/**
 * Detector for modifications to applied (journaled) SQL migration files.
 *
 * Once a migration has been applied (its tag appears in `meta/_journal.json`),
 * the file is **immutable** — Drizzle's migrator records sha256(full .sql);
 * editing an applied migration causes it to re-apply on the next
 * `migrate --execute`, silently drifting the ledger from actual DB state.
 *
 * This guard blocks staged MODIFICATIONS (git status 'M') to .sql files
 * whose tag is already present in the journal. New file ADDITIONS ('A')
 * are always allowed — that is the correct workflow for new migrations.
 *
 * Tracking tasks: mt#2268 (this guard), mt#1641 / mt#2250 (originating
 * incidents where applied migrations 0002/0014/0015 were edited, corrupting
 * the prod ledger).
 *
 * Pure-function implementation — no side effects, no filesystem access.
 * The pre-commit pipeline calls `detectImmutableMigrationViolations()` with
 * the data it reads from disk and git.
 */

/**
 * Env var that, when truthy (`1`, `true`, `yes`), skips the immutable
 * migration check. Audit-logged to stdout when set.
 *
 * Registered in `HOOK_ONLY_ENV_VARS` at
 * `packages/domain/src/configuration/sources/environment.ts` per the mt#1788
 * ESLint rule contract.
 *
 * Use only for the rare legitimate case: fixing a never-applied migration
 * before its first deploy (i.e. the tag exists in the journal because the
 * journal entry was added by a developer but the migration has never actually
 * run against a database).
 */
export const IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV = "MINSKY_SKIP_IMMUTABLE_MIGRATION_CHECK";

/**
 * The git diff-filter characters that indicate a modification to an existing
 * file. Only 'M' (Modified) triggers the guard; 'A' (Added) and others do
 * not — additions are the correct path for new migrations.
 */
export const MODIFICATION_DIFF_FILTER = "M";

/**
 * Migration directories to watch. Each entry is the directory relative to
 * repo root that contains .sql files and a meta/_journal.json.
 */
export const MIGRATION_DIRS: readonly string[] = [
  "packages/domain/src/storage/migrations/pg",
  "packages/domain/src/storage/migrations",
];

/**
 * A single violation: a staged modification to an applied migration file.
 */
export interface ImmutableMigrationViolation {
  /** Repo-relative path to the staged .sql file (e.g. "packages/domain/src/storage/migrations/pg/0014_dapper_changeling.sql") */
  filePath: string;
  /** The migration tag (filename minus .sql extension, e.g. "0014_dapper_changeling") */
  tag: string;
  /** The migration directory this file lives in */
  migrationDir: string;
}

/**
 * Extract the tag from a migration filename.
 * "0014_dapper_changeling.sql" → "0014_dapper_changeling"
 * Returns null if the filename doesn't end with .sql.
 */
export function extractTagFromFilename(filename: string): string | null {
  if (!filename.endsWith(".sql")) return null;
  return filename.slice(0, -4);
}

/**
 * True when the given env-var value should be interpreted as enabling
 * the override. Matches the same casing rules other hook overrides use.
 */
export function isImmutableMigrationOverrideTruthy(envValue: string | undefined): boolean {
  if (!envValue) return false;
  const v = envValue.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Detect staged modifications to already-applied SQL migration files.
 *
 * A file is a violation when ALL of the following hold:
 *   1. The staged change is a MODIFICATION (diff-filter 'M'), not an addition.
 *   2. The file is under one of the known migration directories.
 *   3. The file ends with `.sql`.
 *   4. The file's tag (filename minus `.sql`) appears in that directory's
 *      `meta/_journal.json` entries.
 *
 * Pure function — accepts pre-read data via parameters so unit tests can
 * inject synthetic input without touching the filesystem.
 *
 * @param stagedModifications - Map from repo-relative file path to git diff-filter
 *   status ('M' = modified, 'A' = added, 'D' = deleted, etc.). Only 'M' entries
 *   can trigger violations.
 * @param journalTagsByDir - Map from migration-dir prefix to Set of journaled tags.
 *   Built by the caller from reading each directory's `meta/_journal.json`.
 * @returns Array of violations (empty = no issues).
 */
export function detectImmutableMigrationViolations(
  stagedModifications: ReadonlyMap<string, string>,
  journalTagsByDir: ReadonlyMap<string, ReadonlySet<string>>
): ImmutableMigrationViolation[] {
  const violations: ImmutableMigrationViolation[] = [];

  for (const [filePath, diffStatus] of stagedModifications) {
    // Only flag modifications, not additions or deletions.
    if (diffStatus !== MODIFICATION_DIFF_FILTER) continue;

    // Only .sql files matter.
    if (!filePath.endsWith(".sql")) continue;

    // Find which migration directory this file belongs to.
    let matchedDir: string | null = null;
    for (const dir of MIGRATION_DIRS) {
      // Path must be directly inside the migration dir (not a subdirectory
      // like meta/), so check that the file path matches <dir>/<filename>.
      const prefix = `${dir}/`;
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      // Ensure the file is directly in the dir (no sub-path separator after the prefix).
      if (remainder.includes("/")) continue;
      matchedDir = dir;
      break;
    }

    if (matchedDir === null) continue;

    // Extract the tag from the filename.
    const filename = filePath.slice(filePath.lastIndexOf("/") + 1);
    const tag = extractTagFromFilename(filename);
    if (tag === null) continue;

    // Check if the tag appears in the journal for this directory.
    const journalTags = journalTagsByDir.get(matchedDir);
    if (journalTags === undefined) continue;

    if (journalTags.has(tag)) {
      violations.push({ filePath, tag, migrationDir: matchedDir });
    }
  }

  return violations;
}
