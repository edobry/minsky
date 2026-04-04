#!/usr/bin/env bun

/**
 * Session Backend Migration Script
 *
 * Reads all session records from the session DB and identifies sessions where
 * backendType is "local" but repoUrl contains "github.com" (a mismatch introduced
 * before project-level config was added in mt#631-634).
 *
 * Usage:
 *   bun scripts/migrate-session-backends.ts            # dry-run (default, no changes)
 *   bun scripts/migrate-session-backends.ts --execute  # apply changes
 *   bun scripts/migrate-session-backends.ts --verbose  # show all sessions, not just mismatches
 */

import { createSessionProvider } from "../src/domain/session/session-db-adapter";
import { RepositoryBackendType } from "../src/domain/repository/index";
import { log } from "../src/utils/logger";
import { PersistenceService } from "../src/domain/persistence/service";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MigrationRecord {
  sessionId: string;
  oldBackendType: string | undefined;
  newBackendType: string;
  repoUrl: string;
  reason: string;
}

interface MigrationReport {
  totalSessions: number;
  mismatchCount: number;
  migrated: number;
  skipped: number;
  errors: string[];
  changes: MigrationRecord[];
}

// ─── Detection helpers ────────────────────────────────────────────────────────

function isGitHubUrl(url: string): boolean {
  return url.includes("github.com");
}

function shouldMigrate(
  backendType: string | undefined,
  repoUrl: string
): { migrate: boolean; reason: string } {
  if ((backendType === "local" || backendType === undefined) && isGitHubUrl(repoUrl)) {
    return {
      migrate: true,
      reason: `repoUrl contains "github.com" but backendType is "${backendType ?? "(unset)"}"`,
    };
  }
  return { migrate: false, reason: "" };
}

// ─── Main migration ───────────────────────────────────────────────────────────

async function run(execute: boolean, verbose: boolean): Promise<void> {
  if (!execute) {
    console.log("DRY RUN — no changes will be written. Pass --execute to apply.");
    console.log("");
  }

  // PersistenceService must be initialised before createSessionProvider() can be used.
  if (!PersistenceService.isInitialized()) {
    await PersistenceService.initialize();
  }

  const provider = await createSessionProvider();
  const sessions = await provider.listSessions();

  const report: MigrationReport = {
    totalSessions: sessions.length,
    mismatchCount: 0,
    migrated: 0,
    skipped: 0,
    errors: [],
    changes: [],
  };

  console.log(`Found ${sessions.length} session(s) in the database.`);
  console.log("");

  for (const session of sessions) {
    const { migrate, reason } = shouldMigrate(session.backendType, session.repoUrl);

    if (verbose && !migrate) {
      console.log(
        `  [ok]  ${session.session}  backendType=${session.backendType ?? "(unset)"}  url=${session.repoUrl}`
      );
    }

    if (!migrate) {
      continue;
    }

    report.mismatchCount++;

    const changeRecord: MigrationRecord = {
      sessionId: session.session,
      oldBackendType: session.backendType,
      newBackendType: RepositoryBackendType.GITHUB,
      repoUrl: session.repoUrl,
      reason,
    };

    console.log(`  [!]   ${session.session}`);
    console.log(`        url:        ${session.repoUrl}`);
    console.log(`        backendType: ${session.backendType ?? "(unset)"} → github`);
    console.log(`        reason:     ${reason}`);
    console.log("");

    if (execute) {
      try {
        await provider.updateSession(session.session, {
          backendType: RepositoryBackendType.GITHUB,
        });
        report.migrated++;
        changeRecord.newBackendType = RepositoryBackendType.GITHUB;
        console.log(`        ✓ Updated.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push(`${session.session}: ${msg}`);
        report.skipped++;
        console.log(`        ✗ Error: ${msg}`);
      }
    } else {
      report.skipped++;
    }

    report.changes.push(changeRecord);
  }

  // ─── Summary ────────────────────────────────────────────────────────────────

  console.log("─".repeat(60));
  console.log("Summary");
  console.log("─".repeat(60));
  console.log(`  Total sessions:      ${report.totalSessions}`);
  console.log(`  Mismatches found:    ${report.mismatchCount}`);

  if (execute) {
    console.log(`  Successfully updated: ${report.migrated}`);
    console.log(`  Skipped (errors):    ${report.skipped}`);
  } else {
    console.log(`  Would update:        ${report.mismatchCount}`);
    console.log("  (run with --execute to apply)");
  }

  if (report.errors.length > 0) {
    console.log("");
    console.log("Errors:");
    report.errors.forEach((e) => console.log(`  - ${e}`));
  }

  if (report.errors.length > 0) {
    process.exit(1);
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const verbose = args.includes("--verbose") || args.includes("-v");

run(execute, verbose).catch((err) => {
  log.error("Migration script failed", err instanceof Error ? err : { error: String(err) });
  process.exit(1);
});
