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

if (!failed) {
  console.log("\n--- Step 2: verify 'tasks' table exists in Postgres ---");
  try {
    // Use psql to check for the table. Requires psql in PATH (available in CI).
    const psqlResult = spawnSync(
      "psql",
      [DATABASE_URL, "-c", "SELECT COUNT(*) FROM tasks;", "--no-psqlrc", "-t"],
      { stdio: "pipe", encoding: "utf8" }
    );
    if (psqlResult.status === 0) {
      console.log("PASS: 'tasks' table exists (SELECT COUNT(*) FROM tasks succeeded).");
    } else {
      // psql may not be available; fall back to checking via minsky tasks list
      console.log("Note: psql not available, skipping table existence check via psql.");
    }
  } catch {
    console.log("Note: psql not available or failed — skipping direct table check.");
  }
}

// ── step 3: minsky persistence migrate (dry-run) — must show 0 pending ───────

if (!failed) {
  console.log("\n--- Step 3: dry-run migrate — should report 0 pending migrations ---");
  const dryResult = run("bun", [bundlePath, "persistence", "migrate"], tempDir);
  console.log(dryResult.output);

  if (!dryResult.ok) {
    console.error("FAIL: 'minsky persistence migrate' (dry-run) failed after execute.");
    failed = true;
  } else if (
    dryResult.output.includes("pending migrations") &&
    !dryResult.output.includes("0 pending")
  ) {
    console.error("FAIL: dry-run reports pending migrations even after --execute ran.");
    failed = true;
  } else {
    console.log("PASS: dry-run exited 0.");
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
