#!/usr/bin/env bun
/**
 * Smoke test for the prod-state cache refresh (mt#2506).
 *
 * The producer half of the hybrid cached-injection is a STRUCTURAL change (implement-task
 * §7a): its correctness depends on the live `drizzle.__drizzle_migrations` ledger query
 * actually working against the real schema — no unit test (which stubs `sql.unsafe`) can
 * verify that. This script exercises the real path: connect → read the ledger → write the
 * cache → read it back → assert the snapshot is well-formed.
 *
 * Env-gated: requires `DATABASE_URL` (or a postgres connection string). Skips gracefully
 * (exit 0, "SKIP") when absent — so it is safe to run anywhere. Run live from a context that
 * has the shared/prod connection, then paste the redacted output under "## Live verification"
 * in the PR body.
 *
 * Usage: bun scripts/smoke-prod-state-cache.ts
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { refreshProdStateCache, type UnsafeSql } from "../src/cockpit/prod-state-cache";

const connectionString = process.env.DATABASE_URL ?? process.env.MINSKY_POSTGRES_CONNECTION_STRING;

const tmpPath = path.join(os.tmpdir(), `smoke-prod-state-${process.pid}.json`);

async function main(): Promise<void> {
  const { PersistenceService } = await import("@minsky/domain/persistence/service");
  const service = new PersistenceService();
  try {
    if (connectionString) {
      await service.initialize({ backend: "postgres", postgres: { connectionString } });
    } else {
      // No explicit env connection — bootstrap the app config, then fall back to the
      // configured backend (the same source the cockpit prod-state sweeper uses). SKIPs
      // below if that isn't a reachable postgres.
      const { initializeConfiguration, CustomConfigFactory } = await import(
        "@minsky/domain/configuration"
      );
      await initializeConfiguration(new CustomConfigFactory(), {
        workingDirectory: process.cwd(),
      });
      await service.initialize();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (connectionString) {
      console.error(`FAIL: cannot connect to DB via provided connection string: ${msg}`);
      process.exit(1);
    }
    console.log(`SKIP: no reachable DB configured (env unset + config init failed): ${msg}`);
    process.exit(0);
  }

  const provider = service.getProvider();
  const getRawSql =
    "getRawSqlConnection" in provider &&
    typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection === "function"
      ? (provider as { getRawSqlConnection: () => Promise<unknown> }).getRawSqlConnection.bind(
          provider
        )
      : null;
  if (!getRawSql) {
    console.log("SKIP: configured backend has no raw SQL connection (not postgres).");
    process.exit(0);
  }

  const sql = (await getRawSql()) as UnsafeSql;
  const nowIso = new Date().toISOString();
  const ok = await refreshProdStateCache(sql, nowIso, tmpPath);
  if (!ok) {
    console.error("FAIL: refreshProdStateCache returned false (ledger unreadable).");
    process.exit(1);
  }

  const record = JSON.parse(String(fs.readFileSync(tmpPath, "utf-8"))) as {
    ledgerRows: number;
    latestAppliedAtMs: number | null;
    checkedAt: string;
  };
  fs.unlinkSync(tmpPath);

  if (typeof record.ledgerRows !== "number" || record.ledgerRows < 0) {
    console.error(`FAIL: bogus ledgerRows ${record.ledgerRows}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        ledgerRows: record.ledgerRows,
        latestAppliedAt:
          record.latestAppliedAtMs !== null
            ? new Date(record.latestAppliedAtMs).toISOString()
            : null,
        checkedAt: record.checkedAt,
      },
      null,
      2
    )
  );
  process.exit(0);
}

void main();
