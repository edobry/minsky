#!/usr/bin/env bun
/**
 * Cold-start migration smoke test (mt#2369)
 *
 * Verifies that `minsky persistence migrate --execute` succeeds against an
 * empty Postgres database when run from an arbitrary temp directory that is
 * NOT the Minsky source checkout — i.e., the `resolvePgMigrationsFolder()`
 * resolver finds the bundled migrations at dist/storage/migrations/pg rather
 * than the cwd-relative fallback.
 *
 * Usage (env-gated — skips gracefully when DATABASE_URL is absent):
 *   bun scripts/smoke-cold-start-migrate.ts
 *
 * Exit codes:
 *   0  — smoke passed (or skipped due to missing env)
 *   1  — smoke failed
 *
 * The CI cold-start-migrate workflow calls this script from a temp dir after
 * building the bundle, to ensure the production binary works outside the repo.
 *
 * @see mt#2369 — Phase 0 portability floor
 * @see .github/workflows/cold-start-migrate.yml — CI gate that runs this script
 */

import { spawnSync } from "child_process";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ── env-gate ─────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.log("SKIP: DATABASE_URL not set — cold-start migration smoke test skipped.");
  console.log(
    "To run locally: DATABASE_URL=postgres://... bun scripts/smoke-cold-start-migrate.ts"
  );
  process.exit(0);
}

// ── locate the bundle ────────────────────────────────────────────────────────

const repoRoot = import.meta.dir.replace(/\/scripts$/, "");
const bundlePath = join(repoRoot, "dist", "minsky.js");

if (!existsSync(bundlePath)) {
  console.error(`ERROR: dist/minsky.js not found at ${bundlePath}`);
  console.error("Run 'bun run build' first to produce the bundle.");
  process.exit(1);
}

const migrationsCheck = join(
  repoRoot,
  "dist",
  "storage",
  "migrations",
  "pg",
  "meta",
  "_journal.json"
);
if (!existsSync(migrationsCheck)) {
  console.error(`ERROR: dist/storage/migrations/pg/meta/_journal.json not found.`);
  console.error("The build did not copy migrations. Run 'bun run build' to regenerate.");
  process.exit(1);
}

console.log(`Bundle: ${bundlePath}`);
console.log(`Migrations: ${join(repoRoot, "dist", "storage", "migrations", "pg")}`);

// ── create a temp working directory ──────────────────────────────────────────

const tempDir = mkdtempSync(join(tmpdir(), "minsky-cold-start-"));
console.log(`\nTemp dir (simulating external project cwd): ${tempDir}`);

// ── helper ───────────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], cwd: string): { ok: boolean; output: string } {
  const result = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
    encoding: "utf8",
  });
  const output = [result.stdout ?? "", result.stderr ?? ""].join("\n").trim();
  return { ok: result.status === 0, output };
}

let failed = false;

// ── step 1: minsky persistence migrate --execute from temp dir ───────────────

console.log("\n--- Step 1: run 'minsky persistence migrate --execute' from temp dir ---");
const migrateResult = run("bun", [bundlePath, "persistence", "migrate", "--execute"], tempDir);
console.log(migrateResult.output);

if (!migrateResult.ok) {
  console.error("FAIL: 'minsky persistence migrate --execute' failed from temp dir.");
  failed = true;
} else {
  console.log("PASS: migrate --execute exited 0.");
}

// ── step 2: verify 'tasks' table was created ─────────────────────────────────
// Hard assertion: SELECT COUNT(*) FROM tasks MUST succeed. If psql is not
// available we treat this as a FAIL rather than a skip — in CI psql is always
// present alongside Postgres. This conclusively proves the migration ran.

if (!failed) {
  console.log("\n--- Step 2: verify 'tasks' table exists in Postgres (hard assertion) ---");
  let tableVerified = false;
  try {
    // Use psql to check for the table. psql is required in CI environments that
    // run this script against a real Postgres service — if it's absent that is
    // itself a CI configuration problem, not a skip-worthy condition.
    const psqlResult = spawnSync(
      "psql",
      [DATABASE_URL, "-c", "SELECT COUNT(*) FROM tasks;", "--no-psqlrc", "-t"],
      { stdio: "pipe", encoding: "utf8" }
    );
    if (psqlResult.status === 0) {
      console.log("PASS: 'tasks' table exists (SELECT COUNT(*) FROM tasks succeeded).");
      tableVerified = true;
    } else {
      const psqlOut = [psqlResult.stdout ?? "", psqlResult.stderr ?? ""].join("\n").trim();
      console.error("FAIL: psql returned non-zero exit; 'tasks' table may not exist.");
      console.error(psqlOut);
      failed = true;
    }
  } catch (err) {
    // psql not found in PATH — treat as hard failure in environments where the
    // database is actually running (psql should always be installed alongside Postgres).
    console.error("FAIL: psql not available in PATH. Cannot verify 'tasks' table existence.");
    console.error(
      "Note: if running locally without psql, use DATABASE_URL pointing to an empty DB"
    );
    console.error(`  and install psql (e.g. brew install libpq). Error: ${err}`);
    failed = true;
  }
  if (!tableVerified && !failed) {
    console.error("FAIL: 'tasks' table existence could not be confirmed.");
    failed = true;
  }
}

// ── step 3: minsky persistence migrate (dry-run) — MUST show 0 pending ───────
// Hard assertion: the output MUST contain "0 pending" to conclusively prove that
// --execute applied all migrations. A dry-run that exits 0 but doesn't report
// "0 pending" would indicate an unexpected state (e.g. resolver found wrong folder).

if (!failed) {
  console.log("\n--- Step 3: dry-run migrate — MUST confirm 0 pending migrations ---");
  const dryResult = run("bun", [bundlePath, "persistence", "migrate"], tempDir);
  console.log(dryResult.output);

  if (!dryResult.ok) {
    console.error("FAIL: 'minsky persistence migrate' (dry-run) failed after execute.");
    failed = true;
  } else if (!dryResult.output.includes("0 pending")) {
    // The dry-run must explicitly report "0 pending" — this is the only way to
    // conclusively prove that (a) the migrations resolved correctly and (b) all
    // of them were applied. An exit-0 without this string means the resolver may
    // have found an empty/wrong folder or the count report format changed.
    console.error("FAIL: dry-run did NOT report '0 pending'. Migrations may not have applied.");
    console.error("Expected the output to contain '0 pending'; got the output above.");
    failed = true;
  } else {
    console.log("PASS: dry-run confirms 0 pending migrations.");
  }
}

// ── cleanup ──────────────────────────────────────────────────────────────────

try {
  rmSync(tempDir, { recursive: true });
} catch {
  // best-effort cleanup
}

// ── summary ──────────────────────────────────────────────────────────────────

console.log("");
if (failed) {
  console.error("cold-start migration smoke: FAILED");
  process.exit(1);
} else {
  console.log("cold-start migration smoke: PASSED");
  process.exit(0);
}
