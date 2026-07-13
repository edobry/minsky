#!/usr/bin/env bun
/**
 * Regenerate the fresh-DB bootstrap snapshot (mt#2439).
 *
 * The Postgres migration tree starts at an empty baseline
 * (`0000_charming_smasher.sql` is literally `-- empty baseline`), so a brand-new
 * database cannot be bootstrapped by replaying the tree: `0001` immediately
 * ALTERs pre-baseline tables that no migration creates. The migration runner's
 * fresh-DB path (postgres-migration-operations.ts) instead applies a
 * full-current-schema snapshot and stamps the drizzle ledger at the snapshot's
 * journal high-water-mark; incremental migrations newer than the snapshot then
 * apply normally.
 *
 * This script regenerates that snapshot from the drizzle schema definitions
 * (the source of truth) by running `drizzle-kit generate` against an EMPTY
 * scratch out-dir — with no prior snapshots, drizzle-kit emits the full CREATE
 * DDL for the current schema. The result is written to:
 *
 *   packages/domain/src/storage/migrations/pg/bootstrap/full-schema.sql
 *   packages/domain/src/storage/migrations/pg/bootstrap/meta.json
 *
 * meta.json records the journal entry the snapshot corresponds to
 * (`throughTag` / `when`). The runner stamps the ledger with `when`, so a
 * STALE snapshot is still CORRECT — migrations added after regeneration apply
 * incrementally on top. Regenerate opportunistically (e.g., when the
 * incremental tail grows long), not as a correctness requirement.
 *
 * Usage: bun scripts/generate-bootstrap-snapshot.ts
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

const REPO_ROOT = join(import.meta.dir, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/domain/src/storage/migrations/pg");
const BOOTSTRAP_DIR = join(MIGRATIONS_DIR, "bootstrap");

// Reuse the canonical schema list from the committed drizzle config so the
// snapshot cannot drift from what `db:generate:pg` sees.
const pgConfig = (await import(join(REPO_ROOT, "drizzle.pg.config.ts"))).default as {
  schema: string[];
};

// The scratch dir must live INSIDE the repo: drizzle-kit loads the scratch
// config with CJS resolution from the config's own directory, so a config
// under /tmp cannot resolve `reflect-metadata` / repo node_modules.
const scratchOut = mkdtempSync(join(REPO_ROOT, ".bootstrap-snapshot-scratch-"));
try {
  const scratchConfigPath = join(scratchOut, "drizzle.scratch.config.ts");
  const schemaPaths = pgConfig.schema.map((p) => join(REPO_ROOT, p.replace(/^\.\//, "")));
  writeFileSync(
    scratchConfigPath,
    `import "reflect-metadata";
import type { Config } from "drizzle-kit";
export default {
  schema: ${JSON.stringify(schemaPaths)},
  out: ${JSON.stringify(join(scratchOut, "out"))},
  dialect: "postgresql",
} satisfies Config;
`
  );

  execFileSync("bunx", ["--yes", "drizzle-kit", "generate", "--config", scratchConfigPath], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  const generated = readdirSync(join(scratchOut, "out")).filter((f) => f.endsWith(".sql"));
  if (generated.length !== 1) {
    throw new Error(
      `Expected exactly 1 generated SQL file in the scratch out-dir, got ${generated.length}: ${generated.join(", ")}`
    );
  }
  // The schema uses pgvector's `vector` type, but no migration (and no
  // drizzle-kit output) creates the extension — production environments
  // (Supabase) pre-enable it, and the runtime vector storage layer runs its
  // own CREATE EXTENSION on init. A fresh vanilla Postgres has neither, so
  // the bootstrap artifact must be self-contained.
  const snapshotSql = `CREATE EXTENSION IF NOT EXISTS vector;\n--> statement-breakpoint\n${readFileSync(
    join(scratchOut, "out", generated[0]),
    "utf8"
  )}`;

  // Journal high-water-mark this snapshot corresponds to.
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"));
  const entries = journal.entries as Array<{ tag: string; when: number }>;
  const last = entries[entries.length - 1];
  if (!last) {
    throw new Error("Migration journal has no entries — cannot stamp a snapshot high-water-mark.");
  }

  mkdirSync(BOOTSTRAP_DIR, { recursive: true });
  writeFileSync(join(BOOTSTRAP_DIR, "full-schema.sql"), snapshotSql);
  writeFileSync(
    join(BOOTSTRAP_DIR, "meta.json"),
    `${JSON.stringify({ throughTag: last.tag, when: last.when }, null, 2)}\n`
  );

  console.log(`Bootstrap snapshot written: through ${last.tag} (when=${last.when})`);
  console.log(`  ${join(BOOTSTRAP_DIR, "full-schema.sql")} (${snapshotSql.length} bytes)`);
} finally {
  rmSync(scratchOut, { recursive: true, force: true });
}
