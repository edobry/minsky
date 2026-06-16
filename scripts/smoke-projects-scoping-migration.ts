#!/usr/bin/env bun
/**
 * Smoke test for the projects-scoping migration (mt#2415, Phase 1.2 of mt#2391).
 *
 * Verifies BOTH paths the migration travels:
 *
 *  A. Fresh-DB SCHEMA path (bootstrap): a brand-new empty Postgres bootstraps
 *     the full-schema snapshot, yielding the `projects` table and a nullable
 *     uuid `project_id` column on tasks/sessions/asks. NOTE: on a fresh DB the
 *     bootstrap stamps the ledger through the latest journal entry, so the
 *     0047 DATA backfill is (correctly) NOT run — a brand-new project is not
 *     "Minsky" and gets no Minsky project row. So this path verifies SCHEMA only.
 *
 *  B. Incremental DATA path (the prod scenario): applying 0047 to a populated
 *     DB creates the Minsky project row (idempotently) and backfills existing
 *     rows' project_id. This is what prod does (ledger at 0045 → migrator
 *     applies 0046 + 0047). Nothing else exercises 0047, so we apply it
 *     directly here against seeded rows and assert INSERT-idempotency + the
 *     UPDATE backfill.
 *
 * HARD PROD-SAFETY: this script NEVER connects to production. It connects only
 * to the throwaway Postgres explicitly provided via DATABASE_URL /
 * MINSKY_POSTGRES_URL. Point it at an empty, disposable database.
 *
 * Usage (env-gated — skips gracefully when no DATABASE_URL/MINSKY_POSTGRES_URL):
 *   DATABASE_URL=postgres://localhost:5434/throwaway \
 *     bun scripts/smoke-projects-scoping-migration.ts
 *
 * Exit codes: 0 = passed (or skipped due to missing env); 1 = failed.
 *
 * @see mt#2415 — Phase 1.2 tracking task
 * @see packages/domain/src/storage/migrations/pg/0046_glossy_ultragirl.sql
 * @see packages/domain/src/storage/migrations/pg/0047_backfill_project_id_minsky.sql
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const DATABASE_URL = process.env["DATABASE_URL"] ?? process.env["MINSKY_POSTGRES_URL"];
if (!DATABASE_URL) {
  console.log("SKIP: neither DATABASE_URL nor MINSKY_POSTGRES_URL is set.");
  console.log("      Set one to point at a THROWAWAY (empty, disposable) Postgres and re-run.");
  process.exit(0);
}

const repoRoot = import.meta.dir.replace(/\/scripts$/, "");
const BACKFILL_SQL = join(
  repoRoot,
  "packages/domain/src/storage/migrations/pg/0047_backfill_project_id_minsky.sql"
);

function psql(sql: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("psql", [DATABASE_URL as string, "-c", sql, "--no-psqlrc", "-t"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function psqlFile(path: string): { ok: boolean; out: string } {
  const r = spawnSync("psql", [DATABASE_URL as string, "-f", path, "--no-psqlrc"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: [r.stdout ?? "", r.stderr ?? ""].join("\n").trim() };
}

let failed = false;
function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failed = true;
  }
}

// ── step 0: psql available ────────────────────────────────────────────────────
console.log("--- Step 0: confirm psql is on PATH ---");
if (spawnSync("psql", ["--version"], { stdio: "pipe", encoding: "utf8" }).status !== 0) {
  console.error(
    "FAIL: psql not found in PATH (brew install libpq / apt-get install postgresql-client)."
  );
  process.exit(1);
}

// ── step 1: bootstrap fresh DB (schema) via minsky persistence migrate ────────
console.log("\n--- Step 1: apply migrations (minsky persistence migrate --execute) ---");
const bundlePath = join(repoRoot, "dist", "minsky.js");
const migrate = existsSync(bundlePath)
  ? spawnSync("bun", [bundlePath, "persistence", "migrate", "--execute"], mkEnv())
  : spawnSync(
      "bun",
      ["run", join(repoRoot, "src", "cli.ts"), "persistence", "migrate", "--execute"],
      mkEnv()
    );
console.log([migrate.stdout ?? "", migrate.stderr ?? ""].join("\n").trim());
assert("migrate --execute exited 0", migrate.status === 0);

function mkEnv() {
  return {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL,
      MINSKY_PERSISTENCE_POSTGRES_URL: DATABASE_URL,
      MINSKY_PERSISTENCE_BACKEND: "postgres",
    },
    stdio: "pipe" as const,
    encoding: "utf8" as const,
  };
}

// ── step 2: SCHEMA — projects table + project_id columns (uuid, nullable) ─────
if (!failed) {
  console.log("\n--- Step 2: schema end-state (projects table + project_id columns) ---");
  const t = psql(
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='projects' AND table_schema='public';"
  );
  assert(
    "`projects` table exists",
    t.ok && parseInt(t.stdout, 10) === 1,
    t.stderr || `count=${t.stdout}`
  );

  for (const table of ["tasks", "sessions", "asks"]) {
    const c = psql(
      `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name='${table}' AND column_name='project_id' AND table_schema='public';`
    );
    const [dtype, nullable] = c.stdout.split("|").map((s) => s.trim().toLowerCase());
    assert(
      `\`${table}\`.project_id is uuid + nullable`,
      c.ok && dtype === "uuid" && nullable === "yes",
      c.stderr || `got '${c.stdout}'`
    );
  }
}

// ── step 3: DATA backfill (prod path) — apply 0047 directly, seeded ───────────
// The bootstrap stamps 0047 as applied without running its DATA, so we exercise
// the backfill SQL directly here (this is exactly what the migrator runs on an
// existing/prod DB where the ledger is below 0047).
if (!failed) {
  console.log("\n--- Step 3: data backfill (apply 0047 against seeded rows) ---");

  // 3a: apply 0047 on the (empty-table) bootstrapped DB → creates the Minsky row.
  const a = psqlFile(BACKFILL_SQL);
  assert("0047 applies cleanly", a.ok, a.out.slice(0, 400));
  const row = psql("SELECT COUNT(*) FROM projects WHERE slug='edobry/minsky';");
  assert(
    "Minsky project row created",
    row.ok && parseInt(row.stdout, 10) === 1,
    `count=${row.stdout}`
  );

  // 3b: seed a task row with NULL project_id, re-apply 0047 → backfilled.
  const seed = psql(
    "INSERT INTO tasks (id) VALUES ('mt#smoke-backfill') ON CONFLICT (id) DO NOTHING;"
  );
  assert("seed task row inserted", seed.ok, seed.stderr);
  const b = psqlFile(BACKFILL_SQL); // idempotent re-apply
  assert(
    "0047 re-applies idempotently (no error, no duplicate Minsky row)",
    b.ok,
    b.out.slice(0, 400)
  );
  const dupe = psql("SELECT COUNT(*) FROM projects WHERE slug='edobry/minsky';");
  assert(
    "still exactly one Minsky row (ON CONFLICT held)",
    dupe.ok && parseInt(dupe.stdout, 10) === 1,
    `count=${dupe.stdout}`
  );
  const backfilled = psql(
    "SELECT COUNT(*) FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id='mt#smoke-backfill' AND p.slug='edobry/minsky';"
  );
  assert(
    "seeded task backfilled to the Minsky project",
    backfilled.ok && parseInt(backfilled.stdout, 10) === 1,
    `count=${backfilled.stdout}`
  );
  const orphans = psql("SELECT COUNT(*) FROM tasks WHERE project_id IS NULL;");
  assert(
    "zero NULL project_id rows in tasks after backfill",
    orphans.ok && parseInt(orphans.stdout, 10) === 0,
    `orphan count=${orphans.stdout}`
  );
}

console.log("");
if (failed) {
  console.error("smoke-projects-scoping-migration: FAILED");
  process.exit(1);
}
console.log("smoke-projects-scoping-migration: PASSED");
process.exit(0);
