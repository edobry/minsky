#!/usr/bin/env bun
/**
 * One-time backfill: set `displayName` for every `projects` row that
 * predates `ensureProjectRow`'s auto-derived default (mt#4729 SC4).
 *
 * `ensureProjectRow` now seeds `displayName` on FIRST INSERT (auto-derived
 * from the slug via `deriveDisplayNameFromSlug`, unless explicitly
 * overridden) — but a conflict (an already-provisioned slug) never touches
 * it, so a project row created before this default shipped is left with
 * `displayName: null` forever unless something else sets it. This script
 * is that "something else": the sanctioned backfill path named in the
 * mt#4729 spec's `## Design Decisions` section, not a hand-typed SQL
 * UPDATE.
 *
 * Every write goes through `setProjectDisplayNameIfUnset`, which guards
 * `WHERE display_name IS NULL` — an operator-set or already-derived name is
 * never clobbered, and a concurrent write racing this script can never be
 * overwritten (same idempotent-backfill shape as
 * `backfill-ask-short-ids.ts`).
 *
 * Usage:
 *   bun scripts/backfill-project-display-names.ts              # dry-run (default)
 *   bun scripts/backfill-project-display-names.ts --execute    # apply
 *
 * Safety (CLAUDE.md §Operational Safety: Dry-Run First):
 *   - Dry-run by default; `--execute` required to mutate.
 *   - Bounded to the `projects` table's own row count — observed at
 *     authoring time, 2 rows total (`edobry/minsky`, `edobry/peezombie`),
 *     well under the >10-record task-wrapper threshold, so this is an
 *     individually audited operation, not a task-wrapped migration.
 *
 * @see mt#4729 — this script's originating task (SC4)
 */

import "reflect-metadata";
import { projectsTable } from "@minsky/domain/storage/schemas/projects-schema";
import { setProjectDisplayNameIfUnset } from "@minsky/domain/project/projects-repository";
import { deriveDisplayNameFromSlug } from "@minsky/domain/project/slug";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// ---------------------------------------------------------------------------
// DB bootstrap — same real-container path as backfill-ask-short-ids.ts, so
// this script resolves the SAME connection production code does rather than
// hand-parsing config or a connection string.
// ---------------------------------------------------------------------------

async function bootstrapDb(): Promise<PostgresJsDatabase> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;

  // Duck-typed guard (PR #2110 R1), not `instanceof PersistenceProvider` —
  // see backfill-ask-short-ids.ts's identical comment for why.
  interface SqlCapablePersistence {
    getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
  }
  const isSqlCapablePersistence = (p: unknown): p is SqlCapablePersistence =>
    !!p &&
    !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
    typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";

  if (!isSqlCapablePersistence(persistence)) {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }
  return connection;
}

// ---------------------------------------------------------------------------
// Read + apply
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  slug: string;
  displayName: string | null;
}

async function fetchAllProjectRows(db: PostgresJsDatabase): Promise<ProjectRow[]> {
  const rows = await db
    .select({
      id: projectsTable.id,
      slug: projectsTable.slug,
      displayName: projectsTable.displayName,
    })
    .from(projectsTable);
  return rows as ProjectRow[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");

  const db = await bootstrapDb();
  const rows = await fetchAllProjectRows(db);
  const missing = rows.filter((r) => !r.displayName);

  console.log(`backfill-project-display-names ${execute ? "(EXECUTE)" : "(dry-run)"}`);
  console.log(`  total projects:       ${rows.length}`);
  console.log(`  missing displayName:  ${missing.length}`);
  for (const r of missing) {
    console.log(`      ${r.slug}  ->  ${deriveDisplayNameFromSlug(r.slug)}`);
  }

  if (!execute) {
    console.log(`  (dry-run — re-run with --execute to set ${missing.length} display name(s))`);
    console.log(JSON.stringify({ mode: "dry-run", total: rows.length, missing: missing.length }));
    // Explicit exit (mt#4729): the open postgres pool otherwise keeps the
    // event loop alive indefinitely — the same reason the --execute path
    // below ends in process.exit() rather than falling off the end of main().
    process.exit(0);
  }

  let updated = 0;
  const errors: Array<{ slug: string; message: string }> = [];
  for (const r of missing) {
    try {
      const derived = deriveDisplayNameFromSlug(r.slug);
      // PostgresJsDatabase structurally satisfies ProjectsUpdateDb's narrow
      // update() shape; the cast avoids importing the full drizzle
      // table-typed update() signature here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wasUpdated = await setProjectDisplayNameIfUnset(r.slug, derived, db as any);
      if (wasUpdated) updated += 1;
    } catch (err) {
      errors.push({ slug: r.slug, message: err instanceof Error ? err.message : String(err) });
    }
  }
  console.log(`  updated=${updated} errors=${errors.length} of ${missing.length}`);
  for (const e of errors) console.log(`    error ${e.slug}: ${e.message}`);

  // Verification: recount rows still missing a displayName after the run.
  const postRows = await fetchAllProjectRows(db);
  const stillMissing = postRows.filter((r) => !r.displayName).length;
  console.log(
    `  post-run: ${postRows.length - stillMissing}/${postRows.length} have a displayName`
  );

  console.log(
    JSON.stringify({
      mode: "execute",
      total: rows.length,
      missing: missing.length,
      updated,
      errorCount: errors.length,
    })
  );

  process.exit(errors.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      `backfill-project-display-names failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
}
