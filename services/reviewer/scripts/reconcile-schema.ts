#!/usr/bin/env bun
/**
 * Reviewer-service schema reconciliation (mt#1967 SC#3).
 *
 * Operator-facing recovery script. Diagnoses and (with --execute) applies
 * any missing reviewer-service migrations against the configured Postgres.
 *
 * Canonical-path implementation: invokes the same `applyMigrations()` the
 * reviewer service uses at boot, so the diagnostic always reflects what
 * the runtime would do — no parallel-codepath drift.
 *
 * ## Usage
 *
 *     # Dry-run (default): reports state without applying anything.
 *     bun services/reviewer/scripts/reconcile-schema.ts
 *
 *     # Apply forward-only repair using the canonical drizzle migrator.
 *     bun services/reviewer/scripts/reconcile-schema.ts --execute
 *
 * ## Environment
 *
 * Reads connection string from `MINSKY_SESSIONDB_POSTGRES_URL`, falling
 * back to `MINSKY_POSTGRES_URL`. Same resolution order as
 * `services/reviewer/src/db/client.ts`. If neither is set the script
 * exits non-zero with a clear error — there is no localhost fallback in
 * this operator path; an operator running reconciliation MUST know which
 * database they are reconciling.
 *
 * ## Output
 *
 * On dry-run: structured stdout JSON with `mode: "dry-run"`,
 * `presentTables: [...]`, `missingTables: [...]`, `migrationRows: N`.
 *
 * On execute: invokes `applyMigrations(db)`, which uses the dedicated
 * `__drizzle_migrations_reviewer` table and the post-migration self-check.
 * Re-prints the diagnostic after the apply.
 *
 * ## Why this script exists
 *
 * mt#1963 surfaced the silent-skip bug (two services sharing
 * `drizzle.__drizzle_migrations`; the older service's migrations get
 * silently skipped because drizzle's migrator uses a timestamp comparison,
 * not a hash-set check). The boot-time migrate() now uses a dedicated
 * tracking table and self-check; this script makes the same diagnostic
 * available out-of-band so an operator can reconcile without redeploying.
 *
 * See services/reviewer/DEPLOY.md → "Schema reconciliation (mt#1967)" for
 * the operator runbook.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import {
  applyMigrations,
  REVIEWER_EXPECTED_TABLES,
  REVIEWER_MIGRATIONS_TABLE,
  REVIEWER_MIGRATIONS_SCHEMA,
} from "../src/db/migrate";
import * as convergenceMetricsSchema from "../src/db/schemas/convergence-metrics-schema";
import * as webhookEventsSchema from "../src/db/schemas/webhook-events-schema";
import * as inflightReviewsSchema from "../src/db/schemas/inflight-reviews-schema";

const schema = {
  ...convergenceMetricsSchema,
  ...webhookEventsSchema,
  ...inflightReviewsSchema,
};

interface ReconcileReport {
  mode: "dry-run" | "execute";
  connectionStringSource: "MINSKY_SESSIONDB_POSTGRES_URL" | "MINSKY_POSTGRES_URL";
  presentTables: string[];
  missingTables: string[];
  migrationRows: number;
  expectedTables: readonly string[];
  outcome: "all-present" | "missing-detected" | "apply-completed" | "apply-failed";
  applyError?: string;
}

function resolveConnectionString(): {
  url: string;
  source: ReconcileReport["connectionStringSource"];
} {
  const sessiondb = process.env.MINSKY_SESSIONDB_POSTGRES_URL;
  if (sessiondb) return { url: sessiondb, source: "MINSKY_SESSIONDB_POSTGRES_URL" };

  const fallback = process.env.MINSKY_POSTGRES_URL;
  if (fallback) return { url: fallback, source: "MINSKY_POSTGRES_URL" };

  console.error(
    "ERROR: neither MINSKY_SESSIONDB_POSTGRES_URL nor MINSKY_POSTGRES_URL is set.\n" +
      "Operator must set one explicitly — no localhost fallback in this operator path."
  );
  process.exit(2);
}

async function inspect(db: ReturnType<typeof drizzle<typeof schema>>): Promise<{
  presentTables: string[];
  missingTables: string[];
  migrationRows: number;
}> {
  const tableRows = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema()
      AND tablename = ANY(${[...REVIEWER_EXPECTED_TABLES] as string[]})
  `);
  const present = new Set(tableRows.map((r) => r.tablename));
  const presentTables = REVIEWER_EXPECTED_TABLES.filter((t) => present.has(t));
  const missingTables = REVIEWER_EXPECTED_TABLES.filter((t) => !present.has(t));

  let migrationRows = 0;
  try {
    const countRows = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM ${sql.identifier(REVIEWER_MIGRATIONS_SCHEMA)}.${sql.identifier(REVIEWER_MIGRATIONS_TABLE)}
    `);
    migrationRows = countRows[0]?.count ?? 0;
  } catch {
    // Tracking table doesn't exist yet — first-run case. Leave at 0.
    migrationRows = 0;
  }

  return { presentTables, missingTables, migrationRows };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const mode: ReconcileReport["mode"] = execute ? "execute" : "dry-run";

  const { url, source } = resolveConnectionString();
  const sqlClient = postgres(url, { prepare: false, max: 1 });
  const db = drizzle(sqlClient, { schema });

  try {
    const beforeState = await inspect(db);
    const report: ReconcileReport = {
      mode,
      connectionStringSource: source,
      presentTables: beforeState.presentTables,
      missingTables: beforeState.missingTables,
      migrationRows: beforeState.migrationRows,
      expectedTables: REVIEWER_EXPECTED_TABLES,
      outcome: beforeState.missingTables.length === 0 ? "all-present" : "missing-detected",
    };

    if (mode === "dry-run") {
      console.log(JSON.stringify(report, null, 2));
      if (report.outcome === "missing-detected") {
        console.error(
          `\n${report.missingTables.length} expected table(s) missing. ` +
            `Re-run with --execute to apply forward-only repair via the canonical ` +
            `drizzle migrator (writes to ${REVIEWER_MIGRATIONS_SCHEMA}.${REVIEWER_MIGRATIONS_TABLE}).`
        );
        process.exit(1);
      }
      console.log("\nAll expected tables present. Nothing to do.");
      return;
    }

    // Execute path: invoke the canonical drizzle migrator (via applyMigrations).
    try {
      await applyMigrations(db);
      const afterState = await inspect(db);
      const afterReport: ReconcileReport = {
        mode: "execute",
        connectionStringSource: source,
        presentTables: afterState.presentTables,
        missingTables: afterState.missingTables,
        migrationRows: afterState.migrationRows,
        expectedTables: REVIEWER_EXPECTED_TABLES,
        outcome: "apply-completed",
      };
      console.log(JSON.stringify(afterReport, null, 2));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const failureReport: ReconcileReport = {
        ...report,
        mode: "execute",
        outcome: "apply-failed",
        applyError: message,
      };
      console.error(JSON.stringify(failureReport, null, 2));
      process.exit(3);
    }
  } finally {
    await sqlClient.end();
  }
}

main().catch((err: unknown) => {
  console.error("Unhandled error:", err instanceof Error ? err.message : String(err));
  process.exit(4);
});
