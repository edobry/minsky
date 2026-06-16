#!/usr/bin/env bun
/**
 * Smoke test for projects-scoping migration (mt#2415, Phase 1.2 of mt#2391).
 *
 * Verifies that after applying migrations 0046 + 0047 against a throwaway
 * empty Postgres:
 *   1. The `projects` table exists.
 *   2. The Minsky project row (slug = 'edobry/minsky') is present.
 *   3. `project_id` column exists on tasks, sessions, and asks.
 *   4. All rows in tasks/sessions/asks have project_id set (zero orphans).
 *      (On a fresh empty DB this is vacuously true — zero rows, zero orphans.)
 *
 * HARD PROD-SAFETY: this script NEVER connects to production. It only connects
 * when DATABASE_URL or MINSKY_POSTGRES_URL is explicitly provided by the caller.
 *
 * Usage (env-gated — skips gracefully when no DATABASE_URL/MINSKY_POSTGRES_URL):
 *   DATABASE_URL=postgres://localhost:5432/smoke_test \
 *     bun scripts/smoke-projects-scoping-migration.ts
 *
 * Exit codes:
 *   0  — passed (or skipped due to missing env)
 *   1  — failed
 *
 * @see mt#2415 — Phase 1.2 tracking task
 * @see packages/domain/src/storage/migrations/pg/0046_glossy_ultragirl.sql
 * @see packages/domain/src/storage/migrations/pg/0047_backfill_project_id_minsky.sql
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

// ── env-gate ──────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env["DATABASE_URL"] ?? process.env["MINSKY_POSTGRES_URL"];
if (!DATABASE_URL) {
  console.log("SKIP: neither DATABASE_URL nor MINSKY_POSTGRES_URL is set.");
  console.log("      Set one to point at a throwaway Postgres and re-run.");
  console.log(
    "      Example: DATABASE_URL=postgres://localhost:5432/smoke bun scripts/smoke-projects-scoping-migration.ts"
  );
  process.exit(0);
}

// ── helpers ───────────────────────────────────────────────────────────────────

const repoRoot = import.meta.dir.replace(/\/scripts$/, "");

function psql(sql: string): { ok: boolean; stdout: string; stderr: string } {
  // DATABASE_URL is checked above; non-null at this point.
  const result = spawnSync("psql", [DATABASE_URL as string, "-c", sql, "--no-psqlrc", "-t"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function assert(label: string, condition: boolean, detail?: string): boolean {
  if (condition) {
    console.log(`  PASS: ${label}`);
    return true;
  } else {
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    return false;
  }
}

let failed = false;

// ── step 0: confirm psql is available ────────────────────────────────────────

console.log("--- Step 0: confirm psql is on PATH ---");
const psqlCheck = spawnSync("psql", ["--version"], { stdio: "pipe", encoding: "utf8" });
if (psqlCheck.status !== 0) {
  console.error(
    "FAIL: psql not found in PATH. Install postgresql-client and re-run.\n" +
      "  macOS: brew install libpq && brew link --force libpq\n" +
      "  Linux: apt-get install -y postgresql-client"
  );
  process.exit(1);
}
console.log(`  psql version: ${(psqlCheck.stdout ?? "").trim()}`);

// ── step 1: apply migrations via minsky persistence migrate --execute ─────────

console.log("\n--- Step 1: apply migrations (minsky persistence migrate --execute) ---");

const bundlePath = join(repoRoot, "dist", "minsky.js");
const useBundle = existsSync(bundlePath);
const migrateCmd = useBundle
  ? ["bun", [bundlePath, "persistence", "migrate", "--execute"]]
  : ["bun", ["run", join(repoRoot, "src", "cli.ts"), "persistence", "migrate", "--execute"]];

const migrateResult = spawnSync(migrateCmd[0] as string, migrateCmd[1] as string[], {
  cwd: repoRoot,
  env: {
    ...process.env,
    DATABASE_URL,
    MINSKY_PERSISTENCE_POSTGRES_URL: DATABASE_URL,
    MINSKY_PERSISTENCE_BACKEND: "postgres",
  },
  stdio: "pipe",
  encoding: "utf8",
});
const migrateOutput = [migrateResult.stdout ?? "", migrateResult.stderr ?? ""].join("\n").trim();
console.log(migrateOutput);

if (migrateResult.status !== 0) {
  console.error("FAIL: 'minsky persistence migrate --execute' exited non-zero.");
  failed = true;
} else {
  console.log("  PASS: migrate --execute exited 0.");
}

// ── step 2: assert projects table exists ─────────────────────────────────────

if (!failed) {
  console.log("\n--- Step 2: assert `projects` table exists ---");
  const r = psql(
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'projects' AND table_schema = 'public';"
  );
  if (!r.ok) {
    console.error(`  FAIL: psql query failed — ${r.stderr}`);
    failed = true;
  } else {
    const count = parseInt(r.stdout, 10);
    if (!assert("`projects` table exists in public schema", count === 1, `count=${count}`)) {
      failed = true;
    }
  }
}

// ── step 3: assert Minsky project row exists ──────────────────────────────────

if (!failed) {
  console.log("\n--- Step 3: assert Minsky project row (slug='edobry/minsky') ---");
  const r = psql("SELECT COUNT(*) FROM projects WHERE slug = 'edobry/minsky';");
  if (!r.ok) {
    console.error(`  FAIL: psql query failed — ${r.stderr}`);
    failed = true;
  } else {
    const count = parseInt(r.stdout, 10);
    if (
      !assert("Minsky project row present (slug='edobry/minsky')", count === 1, `count=${count}`)
    ) {
      failed = true;
    }
  }
}

// ── step 4: assert project_id column exists on tasks/sessions/asks ────────────

if (!failed) {
  console.log("\n--- Step 4: assert `project_id` column on tasks, sessions, asks ---");
  for (const table of ["tasks", "sessions", "asks"]) {
    const r = psql(
      `SELECT COUNT(*) FROM information_schema.columns WHERE table_name = '${table}' AND column_name = 'project_id' AND table_schema = 'public';`
    );
    if (!r.ok) {
      console.error(`  FAIL: psql query failed for ${table} — ${r.stderr}`);
      failed = true;
    } else {
      const count = parseInt(r.stdout, 10);
      if (!assert(`\`${table}\`.project_id column exists`, count === 1, `count=${count}`)) {
        failed = true;
      }
    }
  }
}

// ── step 5: assert zero orphaned rows (project_id IS NULL) ───────────────────
// On a fresh empty DB all counts are 0 which trivially satisfies the constraint.
// Against a backfill-target DB (prod-shaped), this proves the backfill ran.

if (!failed) {
  console.log("\n--- Step 5: assert zero orphaned rows (project_id IS NULL) ---");
  for (const table of ["tasks", "sessions", "asks"]) {
    const r = psql(`SELECT COUNT(*) FROM ${table} WHERE project_id IS NULL;`);
    if (!r.ok) {
      console.error(`  FAIL: psql query failed for ${table} — ${r.stderr}`);
      failed = true;
    } else {
      const count = parseInt(r.stdout, 10);
      if (
        !assert(
          `\`${table}\`: zero NULL project_id rows (orphan count = ${count})`,
          count === 0,
          `orphan count=${count}`
        )
      ) {
        failed = true;
      }
    }
  }
}

// ── step 6: assert project_id data type is uuid ───────────────────────────────

if (!failed) {
  console.log("\n--- Step 6: assert project_id columns have data_type='uuid' ---");
  for (const table of ["tasks", "sessions", "asks"]) {
    const r = psql(
      `SELECT data_type FROM information_schema.columns WHERE table_name = '${table}' AND column_name = 'project_id' AND table_schema = 'public';`
    );
    if (!r.ok) {
      console.error(`  FAIL: psql query failed for ${table} — ${r.stderr}`);
      failed = true;
    } else {
      const dtype = r.stdout.trim().toLowerCase();
      if (
        !assert(`\`${table}\`.project_id data_type is 'uuid'`, dtype === "uuid", `got='${dtype}'`)
      ) {
        failed = true;
      }
    }
  }
}

// ── step 7: interruption-safety — assert no NOT NULL on project_id ────────────
// This migration intentionally leaves project_id nullable (NOT NULL deferred
// to Phase 1.3). Verify the column IS NULLABLE.

if (!failed) {
  console.log("\n--- Step 7: assert project_id is nullable (NOT NULL deferred to Phase 1.3) ---");
  for (const table of ["tasks", "sessions", "asks"]) {
    const r = psql(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = '${table}' AND column_name = 'project_id' AND table_schema = 'public';`
    );
    if (!r.ok) {
      console.error(`  FAIL: psql query failed for ${table} — ${r.stderr}`);
      failed = true;
    } else {
      const nullable = r.stdout.trim().toUpperCase();
      if (
        !assert(
          `\`${table}\`.project_id IS NULLABLE (is_nullable='${nullable}')`,
          nullable === "YES",
          `got='${nullable}'`
        )
      ) {
        failed = true;
      }
    }
  }
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log("");
if (failed) {
  console.error("smoke-projects-scoping-migration: FAILED");
  process.exit(1);
} else {
  console.log("smoke-projects-scoping-migration: PASSED");
  process.exit(0);
}
