/**
 * Detector for unguarded DROP/CREATE INDEX statements in staged SQL migration
 * files (mt#3299, gate 3 of the mt#3295 corpus-derived gate wave).
 *
 * Drizzle migrations are applied once and never re-run in the normal case,
 * but a partial-apply (a migration that fails halfway through, or a manual
 * `migrate --execute` retry) re-executes the SAME .sql file from the top.
 * An unguarded `DROP INDEX <name>` hard-fails on retry if the index was
 * already dropped in the failed attempt; an unguarded
 * `CREATE UNIQUE INDEX <name>` hard-fails on retry (or on any environment
 * where the index already exists) the same way. Both classes are made safe
 * by the standard Postgres guard clauses: `DROP INDEX IF EXISTS` and
 * `CREATE UNIQUE INDEX IF NOT EXISTS`.
 *
 * Originating incident: migration 0068 shipped `DROP INDEX` statements
 * without `IF EXISTS` (PR #2142), fixed by 065fc729f.
 *
 * `detectMigrationGuardViolations()` is a pure function (no filesystem/git
 * access); `runMigrationGuardCheck()` below is the I/O-performing runner the
 * pre-commit pipeline calls directly — kept in this file (rather than as a
 * pre-commit.ts private method) so pre-commit.ts's own max-lines budget
 * doesn't absorb this check's I/O/reporting bulk (mt#3299 review).
 */

import { execGitWithTimeout } from "@minsky/domain/utils/git-exec";
import { log } from "@minsky/shared/logger";
import { MIGRATION_DIRS } from "./immutable-migration-detector";
import { readStagedFileContent } from "./staged-file-reader";

/**
 * Env var that, when truthy (`1`, `true`, `yes`), skips this check. Audit-
 * logged to stdout when set. Registered in `HOOK_ONLY_ENV_VARS` at
 * `packages/domain/src/configuration/sources/environment.ts` per the mt#1788
 * ESLint rule contract.
 */
export const MIGRATION_GUARD_CHECK_OVERRIDE_ENV = "MINSKY_SKIP_MIGRATION_GUARD_CHECK";

export type MigrationGuardViolationKind =
  | "drop-index-missing-if-exists"
  | "create-unique-index-missing-if-not-exists";

export interface MigrationGuardViolation {
  /** Repo-relative path to the staged .sql file. */
  filePath: string;
  /** 1-based line number of the offending statement. */
  line: number;
  kind: MigrationGuardViolationKind;
  /** The trimmed source line, for display in the failure message. */
  statement: string;
}

/**
 * True when the given env-var value should be interpreted as enabling the
 * override. Matches the casing rules other hook overrides use.
 */
export function isMigrationGuardOverrideTruthy(envValue: string | undefined): boolean {
  if (!envValue) return false;
  const v = envValue.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// Matched against any `DROP INDEX` statement, then checked against the
// GUARDED pattern below — using two independent (non-lookahead) regexes
// rather than a single negative-lookahead pattern, because the optional
// `CONCURRENTLY` group makes a lookahead-based match backtrack past it and
// false-positive on `DROP INDEX CONCURRENTLY IF EXISTS` (the lookahead
// succeeds at the position BEFORE `CONCURRENTLY` once the engine backtracks
// off the optional group).
const DROP_INDEX_ANY_RE = /\bDROP\s+INDEX\b/i;
const DROP_INDEX_GUARDED_RE = /\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?IF\s+EXISTS\b/i;

const CREATE_UNIQUE_INDEX_ANY_RE = /\bCREATE\s+UNIQUE\s+INDEX\b/i;
const CREATE_UNIQUE_INDEX_GUARDED_RE =
  /\bCREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\b/i;

/**
 * Filter `git diff --cached --name-status --diff-filter=AM` output lines
 * down to staged .sql files directly inside one of `migrationDirs` (not a
 * subdirectory like `meta/`). Pure function so the pre-commit wrapper method
 * stays a thin I/O shell (mt#3299 review: keeps pre-commit.ts's own line
 * budget from absorbing filter logic that belongs with its sibling detector).
 */
export function filterStagedMigrationSqlFiles(
  statusLines: readonly string[],
  migrationDirs: readonly string[]
): string[] {
  const files: string[] = [];
  for (const line of statusLines) {
    const filePath = line.split("\t")[1];
    if (!filePath || !filePath.endsWith(".sql")) continue;
    const inMigrationDir = migrationDirs.some((dir) => {
      const prefix = `${dir}/`;
      return filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/");
    });
    if (inMigrationDir) files.push(filePath);
  }
  return files;
}

/**
 * Scan one migration file's SQL content for unguarded DROP INDEX / CREATE
 * UNIQUE INDEX statements. Line-based (Drizzle-generated migrations emit one
 * statement per line, separated by `--> statement-breakpoint` markers) —
 * comment-only lines (`--` prefix, used for the "manual rollback" doc blocks
 * some migrations carry) are skipped so documentation showing the guarded
 * form doesn't get scanned twice, and so a documented-but-not-executed
 * unguarded example (there are none today, but nothing prevents one) is
 * exempt by construction — this check is about executed statements.
 */
export function detectMigrationGuardViolations(
  filePath: string,
  sqlContent: string
): MigrationGuardViolation[] {
  const violations: MigrationGuardViolation[] = [];
  const lines = sqlContent.split("\n");

  lines.forEach((rawLine, idx) => {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("--")) return;

    if (DROP_INDEX_ANY_RE.test(rawLine) && !DROP_INDEX_GUARDED_RE.test(rawLine)) {
      violations.push({
        filePath,
        line: idx + 1,
        kind: "drop-index-missing-if-exists",
        statement: trimmed,
      });
    }

    if (CREATE_UNIQUE_INDEX_ANY_RE.test(rawLine) && !CREATE_UNIQUE_INDEX_GUARDED_RE.test(rawLine)) {
      violations.push({
        filePath,
        line: idx + 1,
        kind: "create-unique-index-missing-if-not-exists",
        statement: trimmed,
      });
    }
  });

  return violations;
}

export interface MigrationGuardCheckResult {
  success: boolean;
  message: string;
  exitCode: number;
  overridden?: boolean;
}

/**
 * Pre-commit runner: block staged .sql migrations with an unguarded
 * `DROP INDEX`/`CREATE UNIQUE INDEX`. Staged additions/modifications only
 * (mirrors the sibling migration checks in pre-commit.ts; applied migrations
 * are already immutable per mt#2268, so nothing retroactive fires here).
 */
export async function runMigrationGuardCheck(
  projectRoot: string
): Promise<MigrationGuardCheckResult> {
  if (isMigrationGuardOverrideTruthy(process.env[MIGRATION_GUARD_CHECK_OVERRIDE_ENV])) {
    log.cli(
      `[pre-commit:migration-guard] override ${MIGRATION_GUARD_CHECK_OVERRIDE_ENV} set — skipped`
    );
    return {
      success: true,
      message: "Migration guard check skipped via override",
      exitCode: 0,
      overridden: true,
    };
  }

  try {
    const result = await execGitWithTimeout(
      "diff",
      "diff --cached --name-status --diff-filter=AM",
      { workdir: projectRoot, timeout: 5000 }
    );
    const statusLines = result.stdout.toString().trim().split("\n").filter(Boolean);
    const stagedSqlFiles = filterStagedMigrationSqlFiles(statusLines, MIGRATION_DIRS);
    if (stagedSqlFiles.length === 0) {
      return { success: true, message: "Migration guard check passed (n/a)", exitCode: 0 };
    }

    const allViolations: MigrationGuardViolation[] = [];
    for (const filePath of stagedSqlFiles) {
      const content = await readStagedFileContent(projectRoot, filePath);
      allViolations.push(...detectMigrationGuardViolations(filePath, content));
    }
    if (allViolations.length === 0) {
      return { success: true, message: "Migration guard check passed", exitCode: 0 };
    }

    log.cli(`${allViolations.length} unguarded index statement(s). Commit blocked.`);
    for (const v of allViolations) {
      log.cli(`   ${v.filePath}:${v.line} [${v.kind}]  ${v.statement}`);
    }
    log.cli(
      "Guard with `DROP INDEX IF EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS` — a partial-" +
        "apply retry re-executes the file (migration 0068 / PR #2142 / 065fc729f). " +
        `Override: ${MIGRATION_GUARD_CHECK_OVERRIDE_ENV}=1`
    );
    return {
      success: false,
      message: `Migration guard check failed: ${allViolations.length} unguarded statement(s)`,
      exitCode: 1,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error(`Migration guard check failed: ${errorMsg}`);
    return { success: false, message: `Migration guard check failed: ${errorMsg}`, exitCode: 1 };
  }
}
