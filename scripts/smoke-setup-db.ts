#!/usr/bin/env bun
/**
 * Smoke: `minsky setup db` onboarding (mt#2429)
 *
 * Drives the domain orchestration `runSetupDbConfigure` against a LIVE Postgres
 * (the real config-write → migrate → verify chain), writing to a throwaway temp
 * config dir so the operator's real `~/.config/minsky/config.yaml` is never
 * touched. Verifies:
 *
 *   1. The flow reports success.
 *   2. The temp config file actually contains the connection string under
 *      `persistence.postgres.connectionString` and `persistence.backend: postgres`.
 *   3. The reported applied-migration count is > 0 and 0 pending.
 *
 * Env-gated: set `MINSKY_SMOKE_PG_URL` to a disposable Postgres connection
 * string (e.g. a local Docker container). Without it, the script SKIPs cleanly
 * (exit 0) — matching the live-verification-gap pattern (subagents/CI lack a
 * live DB; a main-agent/operator runs it where the URL is present).
 *
 * Runnable: `MINSKY_SMOKE_PG_URL=postgres://… bun scripts/smoke-setup-db.ts`.
 * Exit 0 = pass or skip, non-zero = fail.
 */

import "reflect-metadata";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runSetupDbConfigure } from "@minsky/domain/setup-db";

async function main(): Promise<number> {
  const pgUrl = process.env.MINSKY_SMOKE_PG_URL;
  if (!pgUrl) {
    console.log(
      "SKIP: MINSKY_SMOKE_PG_URL not set — set it to a disposable Postgres URL to run the live smoke."
    );
    return 0;
  }

  const configDir = mkdtempSync(join(tmpdir(), "mt2429-setup-db-smoke-"));
  try {
    console.log(`Running setup-db flow against a temp config dir: ${configDir}`);
    const result = await runSetupDbConfigure(pgUrl, { configDir });

    if (!result.success) {
      console.error(
        `FAIL: setup-db reported failure at step '${result.failedStep}': ${result.message}`
      );
      return 1;
    }
    console.log(`  ✓ flow succeeded: ${result.message}`);

    if (!result.configPath || !existsSync(result.configPath)) {
      console.error(`FAIL: expected a written config file, got: ${result.configPath}`);
      return 1;
    }

    const written = readFileSync(result.configPath, "utf8");
    if (!written.includes("backend: postgres")) {
      console.error("FAIL: config file is missing 'backend: postgres'.");
      return 1;
    }
    // The connection string is written verbatim; check for a stable fragment.
    const fragment = pgUrl.replace(/^postgres(ql)?:\/\/[^@]*@/, "");
    if (!written.includes(fragment)) {
      console.error("FAIL: config file does not contain the connection string host/db fragment.");
      return 1;
    }
    console.log("  ✓ config file contains persistence.backend + connectionString");

    if (!(typeof result.appliedCount === "number" && result.appliedCount > 0)) {
      console.error(`FAIL: expected appliedCount > 0, got ${result.appliedCount}`);
      return 1;
    }
    if (result.pendingCount !== 0) {
      console.error(`FAIL: expected 0 pending migrations, got ${result.pendingCount}`);
      return 1;
    }
    console.log(
      `  ✓ schema verified: ${result.appliedCount} applied, ${result.pendingCount} pending`
    );

    console.log("PASS: setup-db live smoke (config-write → migrate → verify).");
    return 0;
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("FAIL: smoke threw:", error);
    process.exit(1);
  });
